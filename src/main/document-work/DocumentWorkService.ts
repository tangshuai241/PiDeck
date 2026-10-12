/**
 * 文稿工作域编排：建立工作、冻结准备、经原 RPC 分发、结算归档。
 *
 * 授权模型（方案第 5、6 节）：
 * - 授权只有两种来源：当前要求的明确确认（对齐 `briefId + revision`）或本轮明确改稿
 *   用户指令（用最新用户轮的正文指纹核对）。模型文本、布尔字段、渲染层状态都不授权。
 * - RPC 接受、扩展绑定、运行开始、检查通过分别是不同事实，任何一步都不替代下一步。
 *
 * 顺序不变量：主进程先持久化准备与操作，再绑定扩展，最后才分发批准/执行。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import { buildWorkFolder, encodeBindingPayload, kindForRequirements, sameRequirements, sameRuntimeTriple, sanitizeWorkTitle, stableStringify, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import type {
	AuthorizationReference,
	DocumentArtifactVersion,
	DocumentWorkChangedEvent,
	DocumentWorkExtensionState,
	DocumentWorkOperation,
	DocumentWorkPreparation,
	DocumentWorkRecord,
	DocumentWorkView,
	PreparedWork,
	PreparationReference,
	RequirementsReference,
	SessionRuntimeTriple,
	StartWorkInput,
	WorkErrorCode,
	WorkMutation,
} from "../../shared/types/documentWork";
import { DOCUMENT_WORK_BIND_COMMAND } from "../../shared/types/documentWork";
import type { AlignmentState } from "../../shared/types/alignment";
import type { ArtifactStoreFailure, DocumentArtifactStore } from "./DocumentArtifactStore";
import type { DocumentInspectionService } from "./DocumentInspectionService";
import type { DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { DocumentAttemptRunner } from "./DocumentAttemptRunner";
import { selectBaseVersion, validateScopeAgainstHeadings } from "./DocumentRevisionPolicy";
import { emitWorkChanged } from "./documentWorkEvents";
import { containPath, fingerprintFile, hashText, isReadableFile, resolveInsideDirectory } from "./documentWorkPaths";

export type DocumentWorkLogger = { info(scope: string, message: string, detail?: unknown): unknown; warn(scope: string, message: string, detail?: unknown): unknown };

export type MaterialResolver = {
	/** 用户文件选择授权过的路径（含项目目录内的路径）；未授权的绝对路径一律拒绝。 */
	isAllowed(sessionId: string, hostPath: string): Promise<boolean>;
};

export type DocumentWorkServiceDeps = {
	store: DocumentWorkStore;
	artifacts: DocumentArtifactStore;
	inspection: DocumentInspectionService;
	runtime: DocumentWorkRuntimeAdapter;
	materials: MaterialResolver;
	onChanged(event: DocumentWorkChangedEvent): void;
	logger?: DocumentWorkLogger;
	byteBudget?: number;
	/** 绑定确认、开始与结算等待的超时，测试可调小；由尝试协程使用。 */
	bindTimeoutMs?: number;
	settleTimeoutMs?: number;
	startTimeoutMs?: number;
};

export type CreateWorkInput = {
	requestId: string;
	sessionId: string;
	sourceTurnId: string;
	title?: string;
	outputRootId: string;
};

export type PrepareWorkInput = WorkMutation & {
	kind: "create_document" | "revise_document";
	requirementsRef: RequirementsReference;
	scope: { summary: string; sections: string[]; preserve: string[] };
	materialPaths: string[];
	baseVersionId?: string;
};

export type StartWorkRequest = StartWorkInput;

export type CancelWorkRequest = WorkMutation & { attemptId: string; expectedRuntime: SessionRuntimeTriple };

const MATERIAL_ALLOWLIST_TTL_MS = 30 * 60_000;

/** 最新用户轮的正文指纹：授权绑定到真实用户输入，不依赖消息 ID 生成方案。 */
export function hashTurnText(text: string): string {
	return hashText(text.replace(/\r\n?/g, "\n").trim());
}

/** 准备记录指纹不含自身 digest 字段，字段顺序不影响结果。 */
export function preparationDigestOf(preparation: DocumentWorkPreparation): string {
	return hashText(stableStringify({ ...preparation, digest: undefined }));
}

type Materials = DocumentWorkPreparation["materials"];
type Base = DocumentWorkPreparation["base"];

export class DocumentWorkService {
	private readonly byteBudget: number;
	private readonly materialAllowlist = new Map<string, { path: string; expiresAt: number }[]>();
	private readonly alignmentBySession = new Map<string, AlignmentState>();
	private readonly attempts: DocumentAttemptRunner;

	constructor(private readonly deps: DocumentWorkServiceDeps) {
		this.byteBudget = deps.byteBudget ?? 64 * 1024 * 1024;
		this.attempts = new DocumentAttemptRunner({
			store: deps.store,
			artifacts: deps.artifacts,
			inspection: deps.inspection,
			runtime: deps.runtime,
			onChanged: deps.onChanged,
			...(deps.logger ? { logger: deps.logger } : {}),
			...(deps.byteBudget !== undefined ? { byteBudget: deps.byteBudget } : {}),
			...(deps.bindTimeoutMs !== undefined ? { bindTimeoutMs: deps.bindTimeoutMs } : {}),
			...(deps.settleTimeoutMs !== undefined ? { settleTimeoutMs: deps.settleTimeoutMs } : {}),
			...(deps.startTimeoutMs !== undefined ? { startTimeoutMs: deps.startTimeoutMs } : {}),
		});
	}

	// ------------------------------------------------------------------ observation

	/** 用户经系统文件选择器选定的材料路径：只在本次选择后短时有效。 */
	allowMaterials(sessionId: string, paths: readonly string[]): void {
		const now = Date.now();
		const existing = (this.materialAllowlist.get(sessionId) ?? []).filter((entry) => entry.expiresAt > now);
		const merged = new Map(existing.map((entry) => [entry.path, entry]));
		for (const path of paths) merged.set(path, { path, expiresAt: now + MATERIAL_ALLOWLIST_TTL_MS });
		this.materialAllowlist.set(sessionId, [...merged.values()]);
	}

	allowedMaterialPaths(sessionId: string): string[] {
		const now = Date.now();
		return (this.materialAllowlist.get(sessionId) ?? []).filter((entry) => entry.expiresAt > now).map((entry) => entry.path);
	}

	/** 对齐快照只作为「可确认性」证据；它不替代用户点击，也不自行授权。 */
	observeAlignmentState(sessionId: string, state: AlignmentState | null): void {
		if (state === null) this.alignmentBySession.delete(sessionId);
		else this.alignmentBySession.set(sessionId, state);
	}

	readAlignmentState(sessionId: string): AlignmentState | undefined {
		return this.alignmentBySession.get(sessionId);
	}

	/** 扩展汇报只进候选表；归档仍要等运行稳定并独立校验文件。 */
	observeExtensionState(sessionId: string, state: DocumentWorkExtensionState): void {
		this.attempts.observeExtensionState(sessionId, state);
	}

	// ------------------------------------------------------------------ create

	async createWork(input: CreateWorkInput): Promise<WorkResult<DocumentWorkView>> {
		const requestDigest = hashText(stableStringify({ kind: "create", sessionId: input.sessionId, sourceTurnId: input.sourceTurnId, outputRootId: input.outputRootId }));
		const replay = await this.deps.store.readIdempotent(input.requestId, requestDigest);
		if (replay.kind === "conflict") return workFailure<DocumentWorkView>("IDEMPOTENCY_CONFLICT");
		if (replay.kind === "hit") {
			const workId = readStringField(replay.payload, "workId");
			const view = workId ? await this.readView(workId, input.sessionId) : undefined;
			return view ? workSuccess(view) : workFailure<DocumentWorkView>("WORK_NOT_FOUND");
		}
		const outputRoot = await this.deps.store.getOutputRoot(input.outputRootId);
		if (!outputRoot || !(await this.deps.artifacts.directoryExists(outputRoot.path))) return workFailure<DocumentWorkView>("PATH_DENIED");
		// 一个会话一件工作：已有记录直接返回，不因重复提交再建第二件。
		const existingIds = await this.deps.store.listWorkIdsForSession(input.sessionId);
		const existing = existingIds.length ? await this.deps.store.getRecord(existingIds[0]) : undefined;
		if (existing) {
			await this.deps.store.writeIdempotent(input.requestId, requestDigest, { workId: existing.workId });
			return this.viewOf(existing);
		}
		const workId = `dw_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const title = sanitizeWorkTitle(input.title, "文稿工作");
		const workFolder = buildWorkFolder(workId, title);
		const prepared = await this.deps.artifacts.ensureWorkDirectory(outputRoot.path, workFolder);
		if (!prepared.ok) return workFailure<DocumentWorkView>("PATH_DENIED");
		const now = Date.now();
		const record: DocumentWorkRecord = {
			schemaVersion: 1,
			workId,
			sessionId: input.sessionId,
			revision: 1,
			title,
			outputRootId: outputRoot.outputRootId,
			workDirectory: prepared.value,
			workFolder,
			sourceTurnIds: [input.sourceTurnId],
			requirementsSummary: "",
			operationRequestIds: [],
			versionIds: [],
			consumedRevisionTurns: [],
			createdAt: now,
			updatedAt: now,
		};
		const created = await this.deps.store.createRecord(record);
		if (!created.ok) return workFailure<DocumentWorkView>(created.error.code);
		await this.deps.store.writeIdempotent(input.requestId, requestDigest, { workId });
		this.emit(created.value, "created");
		return this.viewOf(created.value);
	}

	// ------------------------------------------------------------------ read

	async getView(workId: string, sessionId: string): Promise<WorkResult<DocumentWorkView>> {
		const view = await this.readView(workId, sessionId);
		return view ? workSuccess(view) : workFailure<DocumentWorkView>("WORK_NOT_FOUND");
	}

	async listForSession(sessionId: string): Promise<DocumentWorkView[]> {
		const views: DocumentWorkView[] = [];
		for (const workId of await this.deps.store.listWorkIdsForSession(sessionId)) {
			const view = await this.readView(workId, sessionId);
			if (view) views.push(view);
		}
		return views;
	}

	private async readView(workId: string, sessionId: string): Promise<DocumentWorkView | undefined> {
		const record = await this.deps.store.getRecord(workId);
		if (!record || record.sessionId !== sessionId) return undefined;
		const view = await this.viewOf(record);
		return view.ok ? view.value : undefined;
	}

	private async viewOf(record: DocumentWorkRecord): Promise<WorkResult<DocumentWorkView>> {
		const versions = await this.deps.store.listVersions(record.workId, record.versionIds);
		const outputRoot = await this.deps.store.getOutputRoot(record.outputRootId);
		const activeOperation = record.activeRequestId ? await this.deps.store.getOperation(record.workId, record.activeRequestId) : undefined;
		const values: DocumentWorkView["versions"] = versions
			.map((version) => {
				const primary = version.artifacts.find((artifact) => artifact.role === "primary");
				return {
					versionId: version.versionId,
					ordinal: version.ordinal,
					title: version.title,
					fileName: primary?.relativePath ?? "",
					inspection: version.inspection?.status ?? ("pending" as const),
					userAcceptance: version.userAcceptance,
					...(version.baseVersionId ? { baseVersionId: version.baseVersionId } : {}),
					manualModification: Boolean(version.manualModification),
					createdAt: version.createdAt,
				};
			})
			.sort((left, right) => right.ordinal - left.ordinal);
		return workSuccess({
			workId: record.workId,
			sessionId: record.sessionId,
			revision: record.revision,
			title: record.title,
			outputRootLabel: outputRoot?.label ?? "",
			requirementsSummary: record.requirementsSummary,
			active: activeOperation ? { attemptId: activeOperation.attemptId, kind: activeOperation.kind, phase: activeOperation.phase, authorizationState: activeOperation.authorizationState, ...(activeOperation.error ? { error: activeOperation.error } : {}) } : null,
			versions: values,
			revisionReady: versions.some((version) => version.inspection?.status === "passed"),
		});
	}

	// ------------------------------------------------------------------ prepare

	async prepare(input: PrepareWorkInput): Promise<WorkResult<PreparedWork>> {
		const requestDigest = hashText(stableStringify(input));
		const replay = await this.deps.store.readIdempotent(input.requestId, requestDigest);
		if (replay.kind === "conflict") return workFailure<PreparedWork>("IDEMPOTENCY_CONFLICT");
		if (replay.kind === "hit") {
			const reference = parsePreparationPayload(replay.payload);
			return reference ? workSuccess(reference) : workFailure<PreparedWork>("IO_ERROR");
		}
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<PreparedWork>("WORK_NOT_FOUND");
		if (record.revision !== input.expectedRevision) return workFailure<PreparedWork>("REVISION_CONFLICT", undefined, record.revision);
		if (!kindForRequirements(input.kind)) return workFailure<PreparedWork>("INVALID_INPUT");
		if (record.activeRequestId && record.activeRequestId !== input.requestId) {
			const active = await this.deps.store.getOperation(record.workId, record.activeRequestId);
			if (active && (active.phase === "dispatching" || active.phase === "running" || active.phase === "inspecting")) return workFailure<PreparedWork>("RUNTIME_BUSY");
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
				const outline = await this.deps.inspection.outline(base.frozenPath);
				if (!outline) {
					await this.deps.store.removeStaging(staging.value);
					return workFailure<PreparedWork>("BASE_CHANGED", "outline_unavailable");
				}
				const scopeCheck = validateScopeAgainstHeadings(input.scope, outline);
				if (!scopeCheck.ok) {
					await this.deps.store.removeStaging(staging.value);
					return workFailure<PreparedWork>("BASE_AMBIGUOUS", "scope_conflict");
				}
			}
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
			scope: { summary: input.scope.summary.slice(0, 2000), sections: input.scope.sections.slice(0, 24), preserve: input.scope.preserve.slice(0, 24) },
			runtime: runtime.target,
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
		const value: PreparedWork = { workId: record.workId, workRevision: mutated.value.revision, preparation: { preparationId: preparation.preparationId, digest: preparation.digest }, summary: preparation.requirementsSummary };
		await this.deps.store.writeIdempotent(input.requestId, requestDigest, value);
		this.emit(mutated.value, "prepared", attemptId);
		return workSuccess(value);
	}

	private async verifyRequirements(record: DocumentWorkRecord, reference: RequirementsReference): Promise<WorkResult<{ requirements: RequirementsReference; summary: string; sourceTurnId?: string }>> {
		if (reference.kind === "alignment") {
			const alignment = this.alignmentBySession.get(record.sessionId);
			if (!alignment || alignment.briefId !== reference.briefId || alignment.revision !== reference.revision) return workFailure("PREPARATION_STALE", "alignment_mismatch");
			if (alignment.phase !== "ready" && alignment.phase !== "approved") return workFailure("APPROVAL_REQUIRED", "alignment_not_ready");
			const brief = alignment.brief;
			return workSuccess({ requirements: reference, summary: brief ? `${brief.goal}\n${brief.deliverable}`.slice(0, 2000) : alignment.briefId });
		}
		const latest = await this.latestUserTurn(record.sessionId);
		if (!latest || latest.sourceTurnId !== reference.sourceTurnId || latest.hash !== reference.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "instruction_mismatch");
		return workSuccess({ requirements: reference, summary: latest.text.slice(0, 2000), sourceTurnId: reference.sourceTurnId });
	}

	private async verifyMaterials(record: DocumentWorkRecord, paths: readonly string[]): Promise<WorkResult<Materials>> {
		if (paths.length > 24) return workFailure("INVALID_INPUT", "too_many_materials");
		const materials: Materials = [];
		for (let index = 0; index < paths.length; index++) {
			const hostPath = paths[index];
			if (!(await this.deps.materials.isAllowed(record.sessionId, hostPath))) return workFailure("PATH_DENIED", "material_not_allowed");
			const fingerprint = await fingerprintFile(hostPath, this.byteBudget);
			if (!fingerprint) return workFailure("IO_ERROR", "material_unreadable");
			materials.push({ materialId: `m${index + 1}`, label: hostPath.split(/[\\/]/).pop() ?? hostPath, hostPath, digest: fingerprint.digest, bytes: fingerprint.bytes });
		}
		return workSuccess(materials);
	}

	/** 基稿冻结：读取公开成果当前字节 → 复制 → 复制前后指纹一致才继续。 */
	private async freezeBase(record: DocumentWorkRecord, versions: readonly DocumentArtifactVersion[], attemptId: string, explicitVersionId?: string): Promise<{ ok: true; base?: Base } | { ok: false; code: WorkErrorCode; detail?: string }> {
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
		return { ok: true, base: { versionId: selection.version.versionId, ordinal: selection.version.ordinal, digest: frozen.value.digest, fileName: primary.relativePath.split("/").pop() ?? "base", frozenPath: frozen.value.frozenPath, origin: selection.fileDigest !== primary.digest ? "external_manual" : "archived" } };
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
				const digest = await this.deps.artifacts.observedDigestInDirectory(directory, artifact.relativePath, this.byteBudget);
				if (digest) observed.set(`${version.versionId}:${artifact.relativePath}`, digest);
				if (digest && digest !== artifact.digest) changed.push(artifact.relativePath);
			}
			const primary = version.artifacts.find((artifact) => artifact.role === "primary");
			const primaryDigest = primary ? observed.get(`${version.versionId}:${primary.relativePath}`) : undefined;
			const adoptable = Boolean(primary && primaryDigest && primaryDigest !== primary.digest && version.ordinal === latestOrdinal && changed.length === 1);
			updated.push(adoptable ? { ...version, manualModification: { digest: primaryDigest as string, observedAt: Date.now() } } : version);
		}
		return { versions: updated, digestFor: (versionId, relativePath) => observed.get(`${versionId}:${relativePath}`) };
	}

	// ------------------------------------------------------------------ start / dispatch

	async start(input: StartWorkRequest): Promise<WorkResult<DocumentWorkOperation>> {
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<DocumentWorkOperation>("WORK_NOT_FOUND");
		if (record.revision !== input.expectedRevision) return workFailure<DocumentWorkOperation>("REVISION_CONFLICT", undefined, record.revision);
		const preparation = await this.deps.store.getPreparation(input.workId, input.preparation.preparationId);
		if (!preparation || preparation.digest !== input.preparation.digest) return workFailure<DocumentWorkOperation>("PREPARATION_STALE");
		if (preparation.workRevision !== record.revision) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", "revision_advanced", record.revision);
		const runtime = await this.deps.runtime.snapshot(record.sessionId);
		if (!runtime) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED");
		if (!sameRuntimeTriple(runtime.target, input.expectedRuntime)) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED");
		if (!sameRuntimeTriple(preparation.runtime, input.expectedRuntime)) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED", "prepared_elsewhere");
		// 运行时忙或有排队输入时不允许开始：避免把本轮执行插到别人前面。
		if (runtime.state.isStreaming === true || runtime.state.isTurnActive === true || runtime.state.isCompacting === true) return workFailure<DocumentWorkOperation>("RUNTIME_BUSY");
		const authorization = await this.verifyAuthorization(record, preparation, input.authorization);
		if (!authorization.ok) return authorization;
		const materials = await this.materialsUnchanged(preparation);
		if (!materials.ok) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", materials.detail);
		if (preparation.base && !(await isReadableFile(preparation.base.frozenPath))) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", "frozen_base_missing");

		const now = Date.now();
		const operation: DocumentWorkOperation = {
			schemaVersion: 1,
			requestId: input.requestId,
			workId: record.workId,
			attemptId: `at_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
			kind: preparation.kind,
			phase: "dispatching",
			preparation: { preparationId: preparation.preparationId, digest: preparation.digest },
			preparedWorkRevision: preparation.workRevision,
			runtime: input.expectedRuntime,
			authorization: input.authorization,
			authorizationState: input.authorization.kind === "revision_instruction" ? "confirmed" : "pending",
			extensionBound: false,
			dispatchAccepted: false,
			dispatchUnknown: false,
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.store.saveOperation(operation);
		const mutated = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({
			...current,
			activeRequestId: operation.requestId,
			operationRequestIds: current.operationRequestIds.includes(operation.requestId) ? current.operationRequestIds : [...current.operationRequestIds, operation.requestId],
		}));
		if (!mutated.ok) return workFailure<DocumentWorkOperation>(mutated.error.code, undefined, mutated.error.currentRevision);
		this.emit(mutated.value, "dispatching", operation.attemptId);
		return this.attempts.dispatch(mutated.value, preparation, operation);
	}

	private async verifyAuthorization(record: DocumentWorkRecord, preparation: DocumentWorkPreparation, authorization: AuthorizationReference): Promise<WorkResult<{ confirmed: boolean }>> {
		if (authorization.kind === "alignment_confirmation") {
			const alignment = this.alignmentBySession.get(record.sessionId);
			if (!alignment || alignment.briefId !== authorization.briefId || alignment.revision !== authorization.revision) return workFailure("APPROVAL_REQUIRED", "alignment_mismatch");
			if (alignment.phase !== "ready") return workFailure("APPROVAL_REQUIRED", "alignment_not_ready");
			if (preparation.requirements.kind !== "alignment" || !sameRequirements(preparation.requirements, { kind: "alignment", briefId: authorization.briefId, revision: authorization.revision })) return workFailure("APPROVAL_REQUIRED", "requirements_mismatch");
			return workSuccess({ confirmed: false });
		}
		const latest = await this.latestUserTurn(record.sessionId);
		if (!latest || latest.sourceTurnId !== authorization.sourceTurnId || latest.hash !== authorization.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "instruction_mismatch");
		if (record.consumedRevisionTurns.includes(authorization.sourceTurnHash)) return workFailure("APPROVAL_REQUIRED", "instruction_replayed");
		if (preparation.requirements.kind !== "user_instruction" || preparation.requirements.sourceTurnHash !== authorization.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "requirements_mismatch");
		return workSuccess({ confirmed: true });
	}

	private async materialsUnchanged(preparation: DocumentWorkPreparation): Promise<{ ok: true } | { ok: false; detail: string }> {
		for (const material of preparation.materials) {
			const fingerprint = await fingerprintFile(material.hostPath, this.byteBudget);
			if (!fingerprint || fingerprint.digest !== material.digest) return { ok: false, detail: "material_changed" };
		}
		return { ok: true };
	}

	// ------------------------------------------------------------------ cancel / read / recovery

	async cancel(input: CancelWorkRequest): Promise<WorkResult<{ attemptId: string }>> {
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<{ attemptId: string }>("WORK_NOT_FOUND");
		if (record.revision !== input.expectedRevision) return workFailure<{ attemptId: string }>("REVISION_CONFLICT", undefined, record.revision);
		const operation = record.activeRequestId ? await this.deps.store.getOperation(record.workId, record.activeRequestId) : undefined;
		if (!operation || operation.attemptId !== input.attemptId) return workFailure<{ attemptId: string }>("CANCEL_NOT_APPLICABLE");
		if (!sameRuntimeTriple(operation.runtime, input.expectedRuntime)) return workFailure<{ attemptId: string }>("RUNTIME_CHANGED");
		const abort = await this.deps.runtime.abort({ sessionId: record.sessionId, requestId: `abort_${operation.requestId}`, expectedRuntime: input.expectedRuntime });
		if (!abort.accepted) return workFailure<{ attemptId: string }>("CANCEL_NOT_APPLICABLE", abort.error);
		this.attempts.markCancelled(record.workId);
		const cancelled: DocumentWorkOperation = { ...operation, phase: "interrupted", error: { code: "IO_ERROR", retryable: true, detail: "cancelled" }, updatedAt: Date.now() };
		await this.deps.store.saveOperation(cancelled);
		const cleared = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({ ...current, activeRequestId: undefined }));
		if (cleared.ok) this.emit(cleared.value, "cancelled", operation.attemptId);
		return workSuccess({ attemptId: operation.attemptId });
	}

	/** 退出路径：先标记取消，再等所有结算协程收敛。 */
	beginShutdown(): void {
		this.attempts.beginShutdown();
	}

	async drain(): Promise<void> {
		await this.attempts.drain();
	}

	async getOperation(workId: string, requestId: string, sessionId: string): Promise<WorkResult<DocumentWorkOperation>> {
		const record = await this.deps.store.getRecord(workId);
		if (!record || record.sessionId !== sessionId) return workFailure<DocumentWorkOperation>("WORK_NOT_FOUND");
		const operation = await this.deps.store.getOperation(workId, requestId);
		return operation ? workSuccess(operation) : workFailure<DocumentWorkOperation>("OPERATION_NOT_FOUND");
	}

	/** 进程重启后的结算：进行中的操作一律转 interrupted / unknown，绝不自动重放。 */
	async recoverOnStartup(): Promise<void> {
		for (const record of await this.deps.store.listAllRecords()) {
			for (const requestId of record.operationRequestIds) {
				const operation = await this.deps.store.getOperation(record.workId, requestId);
				if (!operation) continue;
				const recovered = await this.deps.store.recoverInterruptedOperation(operation);
				if (recovered === operation) continue;
				if (record.activeRequestId === requestId) {
					const current = await this.deps.store.getRecord(record.workId);
					if (current) await this.deps.store.mutateRecord(current.workId, current.revision, (value) => ({ ...value, activeRequestId: undefined }));
				}
				const refreshed = await this.deps.store.getRecord(record.workId);
				if (refreshed) this.emit(refreshed, recovered.phase === "unknown" ? "unknown" : "interrupted", operation.attemptId);
			}
		}
	}

	private async latestUserTurn(sessionId: string): Promise<{ sourceTurnId: string; hash: string; text: string } | undefined> {
		const snapshot = await this.deps.runtime.snapshot(sessionId);
		if (!snapshot) return undefined;
		for (let index = snapshot.messages.length - 1; index >= 0; index--) {
			const message = snapshot.messages[index];
			if (message.role !== "user") continue;
			return { sourceTurnId: message.id, hash: hashTurnText(message.text), text: message.text };
		}
		return undefined;
	}

	private emit(record: DocumentWorkRecord, changeKind: DocumentWorkChangedEvent["changeKind"], attemptId?: string): void {
		emitWorkChanged(this.deps.onChanged, record, changeKind, attemptId);
	}
}

/** 材料根检查：只接受用户授权目录或项目目录内的路径，其余一律拒绝。 */
export async function isPathInsideAnyRoot(roots: readonly string[], candidate: string): Promise<boolean> {
	for (const root of roots) {
		const containment = await containPath(root, candidate);
		if (containment.ok) return true;
	}
	return false;
}

function readStringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

/** 结构化 detail 只允许标识与枚举，禁止把路径或正文写进错误。 */
function safeDetail(detail: string): string {
	return /^[A-Za-z0-9_.:-]{1,200}$/.test(detail) ? detail : "detail_redacted";
}

export function parsePreparationPayload(value: unknown): PreparedWork | undefined {
	const workId = readStringField(value, "workId");
	const summary = readStringField(value, "summary");
	const workRevision = typeof value === "object" && value !== null ? Reflect.get(value, "workRevision") : undefined;
	const preparationValue = typeof value === "object" && value !== null ? Reflect.get(value, "preparation") : undefined;
	const preparationId = readStringField(preparationValue, "preparationId");
	const digest = readStringField(preparationValue, "digest");
	if (!workId || typeof workRevision !== "number" || summary === undefined || !preparationId || !digest) return undefined;
	const preparation: PreparationReference = { preparationId, digest };
	return { workId, workRevision, preparation, summary };
}
