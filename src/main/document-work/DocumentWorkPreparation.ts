/**
 * 准备流水线：要求核对、材料指纹、基稿冻结、块大纲抽取与记录落盘。
 *
 * 从编排服务里拆出来的原因（评审）：这一段的职责是「把一次请求变成一份不可变准备记录」，
 * 包含大量文件与内容校验；和写事务、授权顺序混在一起会让 `DocumentWorkService` 越过体量红线，
 * 也让「准备不可变」这条规则难以单独理解。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { kindForRequirements, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import type { AlignmentState } from "../../shared/types/alignment";
import type { DocumentArtifactVersion, DocumentWorkPreparation, DocumentWorkRecord, PreparedWork, RequirementsReference } from "../../shared/types/documentWork";
import type { DocumentArtifactStore } from "./DocumentArtifactStore";
import type { DocumentInspectionService } from "./DocumentInspectionService";
import type { DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { selectBaseVersion, validateScopeAgainstHeadings } from "./DocumentRevisionPolicy";
import { resolveRevisionScope } from "../../shared/documentRevisionScope";
import { preparationDigestOf } from "./documentWorkTurn";
import { fingerprintFile, resolveInsideDirectory } from "./documentWorkPaths";
import type { DocumentWorkQueries } from "./DocumentWorkQueries";

export type MaterialResolver = {
	/** 用户文件选择授权过的路径（含项目目录内的路径）；未授权的绝对路径一律拒绝。 */
	isAllowed(sessionId: string, hostPath: string): Promise<boolean>;
};

export type PrepareWorkRequest = {
	requestId: string;
	workId: string;
	expectedRevision: number;
	kind: "create_document" | "revise_document";
	requirementsRef: RequirementsReference;
	/** allow 声明本轮允许改动的块；缺省时基稿里已有块默认全部必须保留。 */
	scope: { summary: string; sections: string[]; preserve: string[]; allow?: string[] };
	materialPaths: string[];
	baseVersionId?: string;
	/**
	 * 普通聊天指令型改稿：范围由主进程按**冻结基稿的真实标题**解析（覆盖 scope.allow/preserve）。
	 * 渲染层不能构造这个字段（IPC 不接收），避免「信任渲染层 scope」。
	 */
	instructionScope?: { instruction: string };
};

type Materials = DocumentWorkPreparation["materials"];
type Base = DocumentWorkPreparation["base"];

export type DocumentWorkPreparationDeps = {
	store: DocumentWorkStore;
	artifacts: DocumentArtifactStore;
	inspection: DocumentInspectionService;
	runtime: DocumentWorkRuntimeAdapter;
	queries: DocumentWorkQueries;
	materials: MaterialResolver;
	readAlignmentState(sessionId: string): AlignmentState | undefined;
	byteBudget: number;
};

export class DocumentWorkPreparationFactory {
	constructor(private readonly deps: DocumentWorkPreparationDeps) {}

	/** 生成一份不可变准备记录；任何一步失败都不留下半成品准备。 */
	async prepare(input: PrepareWorkRequest): Promise<WorkResult<PreparedWork>> {
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<PreparedWork>("WORK_NOT_FOUND");
		if (record.revision !== input.expectedRevision) return workFailure<PreparedWork>("REVISION_CONFLICT", undefined, record.revision);
		if (!kindForRequirements(input.kind)) return workFailure<PreparedWork>("INVALID_INPUT");
		if (record.activeRequestId && record.activeRequestId !== input.requestId) {
			const active = await this.deps.store.getOperation(record.workId, record.activeRequestId);
			if (active && (active.phase === "dispatching" || active.phase === "running" || active.phase === "inspecting" || active.phase === "unknown")) return workFailure<PreparedWork>("RUNTIME_BUSY", active.phase);
		}
		const versions = await this.deps.store.listVersions(record.workId, record.versionIds);
		if (input.kind === "revise_document" && versions.length === 0) return workFailure<PreparedWork>("INVALID_INPUT", "no_base_version");
		if (input.kind === "create_document" && versions.length > 0) return workFailure<PreparedWork>("INVALID_INPUT", "work_already_has_versions");

		const runtime = await this.deps.runtime.snapshot(record.sessionId);
		if (!runtime) return workFailure<PreparedWork>("RUNTIME_CHANGED");
		const requirements = await this.verifyRequirements(record, input.requirementsRef);
		if (!requirements.ok) return requirements;
		const materials = await this.verifyMaterials(record, input.materialPaths);
		if (!materials.ok) return materials;

		const attemptId = `at_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const staging = await this.deps.artifacts.ensureStagingDirectory(record.workDirectory, attemptId);
		if (!staging.ok) return workFailure<PreparedWork>("PATH_DENIED");
		let base: Base;
		if (input.kind === "revise_document") {
			const frozen = await this.freezeBase(record, versions, attemptId, input.baseVersionId);
			if (!frozen.ok) {
				await this.deps.store.removeStaging(staging.value);
				return workFailure<PreparedWork>(frozen.code, frozen.detail);
			}
			base = frozen.base;
			if (base) {
				// 块大纲在 freezeBase 里从冻结副本抽出；这里只做范围冲突判定。
				const scopeCheck = validateScopeAgainstHeadings(
					input.scope,
					base.sections.map((section) => section.heading),
				);
				if (!scopeCheck.ok) {
					await this.deps.store.removeStaging(staging.value);
					return workFailure<PreparedWork>("BASE_AMBIGUOUS", "scope_conflict");
				}
			}
		}
		// 指令型改稿：把「改哪里」解析成冻结基稿里的真实标题；歧义/无法解析一律 fail closed。
		let resolvedScope = input.scope;
		if (input.instructionScope) {
			const resolution = resolveRevisionScope({ instruction: input.instructionScope.instruction, headings: (base?.sections ?? []).map((section) => section.heading) });
			if (resolution.kind === "ordinary") {
				await this.deps.store.removeStaging(staging.value);
				return workFailure<PreparedWork>("APPROVAL_REQUIRED", "not_explicit_revision");
			}
			if (resolution.kind === "unresolved") {
				await this.deps.store.removeStaging(staging.value);
				return workFailure<PreparedWork>("BASE_AMBIGUOUS", resolution.reason);
			}
			resolvedScope = { summary: input.scope.summary, sections: [], preserve: resolution.preserve, allow: resolution.allow };
		}
		const draft: DocumentWorkPreparation = {
			schemaVersion: 1,
			preparationId: `pr_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
			digest: "",
			workId: record.workId,
			workRevision: record.revision + 1,
			kind: input.kind,
			requirements: requirements.value.requirements,
			requirementsSummary: requirements.value.summary,
			outputRootId: record.outputRootId,
			stagingDirectory: staging.value,
			materials: materials.value,
			...(base ? { base } : {}),
			// allow 必须一并落盘：它是「哪些块允许改」的唯一来源，丢了就会把合法改动判成违规。
			scope: { summary: resolvedScope.summary.slice(0, 2000), sections: resolvedScope.sections.slice(0, 24), preserve: resolvedScope.preserve.slice(0, 24), ...(resolvedScope.allow ? { allow: resolvedScope.allow.slice(0, 24) } : {}) },
			runtime: runtime.target,
			...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}),
			createdAt: Date.now(),
		};
		const preparation: DocumentWorkPreparation = { ...draft, digest: preparationDigestOf(draft) };
		await this.deps.store.savePreparation(preparation);
		const mutated = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({
			...current,
			requirementsSummary: preparation.requirementsSummary,
			sourceTurnIds: requirements.value.sourceTurnId && !current.sourceTurnIds.includes(requirements.value.sourceTurnId) ? [...current.sourceTurnIds, requirements.value.sourceTurnId] : current.sourceTurnIds,
		}));
		if (!mutated.ok) return workFailure<PreparedWork>(mutated.error.code, undefined, mutated.error.currentRevision);
		return workSuccess({ workId: record.workId, workRevision: mutated.value.revision, preparation: { preparationId: preparation.preparationId, digest: preparation.digest }, summary: preparation.requirementsSummary });
	}

	private async verifyRequirements(record: DocumentWorkRecord, reference: RequirementsReference): Promise<WorkResult<{ requirements: RequirementsReference; summary: string; sourceTurnId?: string }>> {
		if (reference.kind === "alignment") {
			const alignment = this.deps.readAlignmentState(record.sessionId);
			if (!alignment || alignment.briefId !== reference.briefId || alignment.revision !== reference.revision) return workFailure("PREPARATION_STALE", "alignment_mismatch");
			if (alignment.phase !== "ready" && alignment.phase !== "approved") return workFailure("APPROVAL_REQUIRED", "alignment_not_ready");
			const brief = alignment.brief;
			return workSuccess({ requirements: reference, summary: brief ? `${brief.goal}\n${brief.deliverable}`.slice(0, 2000) : alignment.briefId });
		}
		const latest = await this.deps.queries.latestUserTurn(record.sessionId);
		if (!latest || latest.sourceTurnId !== reference.sourceTurnId || latest.hash !== reference.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "instruction_mismatch");
		return workSuccess({ requirements: reference, summary: latest.text.slice(0, 2000), sourceTurnId: reference.sourceTurnId });
	}

	private async verifyMaterials(record: DocumentWorkRecord, paths: readonly string[]): Promise<WorkResult<Materials>> {
		if (paths.length > 24) return workFailure("INVALID_INPUT", "too_many_materials");
		const materials: Materials = [];
		for (let index = 0; index < paths.length; index++) {
			const hostPath = paths[index];
			if (!(await this.deps.materials.isAllowed(record.sessionId, hostPath))) return workFailure("PATH_DENIED", "material_not_allowed");
			const fingerprint = await fingerprintFile(hostPath, this.deps.byteBudget);
			if (!fingerprint) return workFailure("IO_ERROR", "material_unreadable");
			materials.push({ materialId: `m${index + 1}`, label: hostPath.split(/[\\/]/).pop() ?? hostPath, hostPath, digest: fingerprint.digest, bytes: fingerprint.bytes });
		}
		return workSuccess(materials);
	}

	/** 基稿冻结：读取公开成果当前字节 → 复制 → 复制前后指纹一致才继续。 */
	async freezeBase(record: DocumentWorkRecord, versions: readonly DocumentArtifactVersion[], attemptId: string, explicitVersionId?: string): Promise<{ ok: true; base?: Base } | { ok: false; code: "BASE_AMBIGUOUS" | "BASE_CHANGED" | "PATH_DENIED" | "IO_ERROR"; detail?: string }> {
		const observed = await this.withObservedDigests(record, versions);
		const selection = selectBaseVersion({ kind: "revise_document", versions: observed.versions, explicitVersionId, readableDigest: (versionId, relativePath) => observed.digestFor(versionId, relativePath) });
		if (selection.kind === "create") return { ok: true };
		if (selection.kind === "ambiguous") return { ok: false, code: selection.reason === "unreadable_base" ? "BASE_CHANGED" : "BASE_AMBIGUOUS", detail: selection.reason };
		const primary = selection.version.artifacts.find((artifact) => artifact.role === "primary");
		if (!primary) return { ok: false, code: "BASE_AMBIGUOUS", detail: "no_primary" };
		const publicFile = resolveInsideDirectory(join(record.workDirectory, "versions", selection.version.directory), primary.relativePath);
		if (!publicFile) return { ok: false, code: "PATH_DENIED", detail: "bad_path" };
		const frozen = await this.deps.artifacts.freezeBase({ workId: record.workId, attemptId, sourcePath: publicFile, fileName: `${selection.version.directory}-${primary.relativePath.split("/").pop() ?? "base"}` });
		if (!frozen.ok) return { ok: false, code: frozen.reason === "changed" ? "BASE_CHANGED" : "IO_ERROR", detail: frozen.reason };
		// 块大纲来自冻结副本（不是公开文件），因此「冻结后原文件又被改」也不影响这一轮的结论。
		const analysis = await this.deps.inspection.analyze(frozen.value.frozenPath);
		return {
			ok: true,
			base: {
				versionId: selection.version.versionId,
				ordinal: selection.version.ordinal,
				digest: frozen.value.digest,
				fileName: primary.relativePath.split("/").pop() ?? "base",
				frozenPath: frozen.value.frozenPath,
				origin: selection.fileDigest !== primary.digest ? "external_manual" : "archived",
				sections: analysis?.sections ?? [],
			},
		};
	}

	/** 公开成果被手工改过时记录观察值；归属唯一（最新版 + 恰好一个文件变化）才自动接续。 */
	private async withObservedDigests(record: DocumentWorkRecord, versions: readonly DocumentArtifactVersion[]): Promise<{ versions: DocumentArtifactVersion[]; digestFor: (versionId: string, relativePath: string) => string | undefined }> {
		const observed = new Map<string, string>();
		const updated: DocumentArtifactVersion[] = [];
		const latestOrdinal = versions.reduce((highest, version) => Math.max(highest, version.ordinal), 0);
		for (const version of versions) {
			const changed: string[] = [];
			for (const artifact of version.artifacts) {
				const directory = join(record.workDirectory, "versions", version.directory);
				const digest = await this.deps.artifacts.observedDigestInDirectory(directory, artifact.relativePath, this.deps.byteBudget);
				if (digest) observed.set(`${version.versionId}:${artifact.relativePath}`, digest);
				if (digest && digest !== artifact.digest) changed.push(artifact.relativePath);
			}
			const primary = version.artifacts.find((artifact) => artifact.role === "primary");
			const primaryDigest = primary ? observed.get(`${version.versionId}:${primary.relativePath}`) : undefined;
			// 用局部常量收窄，避免 `as string` 这类绕过类型的断言。
			const adoptable = primary !== undefined && primaryDigest !== undefined && primaryDigest !== primary.digest && version.ordinal === latestOrdinal && changed.length === 1;
			if (adoptable && primaryDigest !== undefined) updated.push({ ...version, manualModification: { digest: primaryDigest, observedAt: Date.now() } });
			else updated.push(version);
		}
		return { versions: updated, digestFor: (versionId, relativePath) => observed.get(`${versionId}:${relativePath}`) };
	}

	/** 材料自准备后是否变化：任一指纹不同即整轮准备失效。 */
	async materialsUnchanged(preparation: DocumentWorkPreparation): Promise<{ ok: true } | { ok: false; detail: string }> {
		for (const material of preparation.materials) {
			const fingerprint = await fingerprintFile(material.hostPath, this.deps.byteBudget);
			if (!fingerprint || fingerprint.digest !== material.digest) return { ok: false, detail: "material_changed" };
		}
		return { ok: true };
	}
}
