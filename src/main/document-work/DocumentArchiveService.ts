/**
 * TPA 独立文稿：归档。
 *
 * 一段编排的收尾只做一件事的判断：**这一轮到底该记成什么**。
 * 判据严格按方案：`agent_end` 只是底层 run 结束，必须等到 `agent_settled` 且运行时
 * 不忙、无排队输入，才去看成果候选；候选文件由主进程独立验证（相对路径 → staging
 * 归属 → 真实路径包含 → 普通非空文件），**模型汇报只是候选，不批准也不结算**。
 *
 * 归档本身是"复制到新版本目录 + 存原始字节快照 + 程序检查 + 落版本记录"：
 * 版本目录排他创建、复制前后校验指纹、失败保留 staging 与输入并如实回报。
 */
import { basename, dirname, join } from "node:path";
import { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_SCHEMA_VERSION, isSafeRelativePath, workFail, workOk, type WorkErrorCode, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactCandidateReport, DocumentArtifactFile, DocumentArtifactVersion, DocumentWorkOperation, DocumentWorkPreparation } from "../../shared/types/documentWork";
import { DocumentArtifactStore } from "./DocumentArtifactStore";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";
import type { DocumentInspectionService } from "./DocumentInspectionService";
import type { DocumentWorkRuntimeAdapter, DocumentWorkRuntimePort, DocumentWorkRuntimeTarget } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";

export type ArchiveOutcome = { state: "archived"; versionId: string } | { state: "failed" | "interrupted" | "unknown"; code: WorkErrorCode; detail?: string };

export type DocumentArchiveServiceDeps = {
	store: DocumentWorkStore;
	pathFs: DocumentPathFsPort;
	/** TPA 管理根（`userData/document-work`）。 */
	workRoot: string;
	inspection: DocumentInspectionService;
	now?: () => number;
	/** 等待稳定的时限；测试注入小值。 */
	settleMs?: number;
};

/** staging 内 TPA 自己的辅助目录：冻结基稿放这里，不算成果候选。 */
export const STAGING_INTERNAL_DIR = "_tpa";

export class DocumentArchiveService {
	private readonly deps: DocumentArchiveServiceDeps;
	private readonly now: () => number;

	constructor(deps: DocumentArchiveServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
	}

	private storeFor(outputRootPath: string): DocumentArtifactStore {
		return new DocumentArtifactStore({
			fs: this.deps.pathFs,
			outputRootPath,
			snapshotRootPath: join(this.deps.workRoot, "snapshots"),
			maxArtifactBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
		});
	}

	/** staging 目录 + 冻结基稿副本；复制前后指纹不一致直接失败（BASE_CHANGED）。 */
	async freezePreparation(input: { preparation: DocumentWorkPreparation; outputRootPath: string }): Promise<WorkResult<{ stagingAbsolutePath: string; frozenBaseRelativePath?: string }>> {
		const artifacts = this.storeFor(input.outputRootPath);
		const layout = artifacts.ensureLayout(input.preparation.outputRelativeDir);
		if ("error" in layout) return layout;
		const staging = artifacts.createStaging(input.preparation.outputRelativeDir, input.preparation.stagingRelativeDir.split("/").pop() ?? "");
		if ("error" in staging) return staging;
		const base = input.preparation.base;
		if (!base) return workOk({ stagingAbsolutePath: staging.value.absolutePath });
		const source = resolveWithinRoot(this.deps.pathFs, input.outputRootPath, base.relativePath);
		if (!source.ok) return workFail(source.error.code, false, { detail: source.error.detail });
		const internalDir = join(staging.value.absolutePath, STAGING_INTERNAL_DIR, "base");
		try {
			this.deps.pathFs.mkdirRecursive(internalDir);
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to prepare the frozen base directory" });
		}
		const frozenRelativePath = `${input.preparation.stagingRelativeDir}/${STAGING_INTERNAL_DIR}/base/${basename(base.relativePath)}`;
		const destination = join(internalDir, basename(base.relativePath));
		const copied = artifacts.copyVerified({ sourceAbsolutePath: source.absolutePath, destinationAbsolutePath: destination, expectedSha256: base.sha256 });
		if ("error" in copied) return copied;
		return workOk({ stagingAbsolutePath: staging.value.absolutePath, frozenBaseRelativePath: frozenRelativePath });
	}

	/** 等待权威稳定点；`agent_end` 只用于识别中断，不用于结算。 */
	private async waitForSettle(adapter: DocumentWorkRuntimeAdapter, target: DocumentWorkRuntimeTarget): Promise<{ kind: "settled" } | { kind: "ended"; stopReason?: string } | { kind: "timeout" }> {
		const matches = (event: { target: DocumentWorkRuntimeTarget; stale: boolean }): boolean => !event.stale && event.target.agentId === target.agentId && event.target.runtimeGeneration === target.runtimeGeneration;
		const settleMs = this.deps.settleMs ?? DOCUMENT_WORK_BUDGETS.settleMs;
		const first = await adapter.waitFor((event) => (event.kind === "settled" || event.kind === "agent_end") && matches(event), settleMs);
		if (!first) return { kind: "timeout" };
		if (first.kind === "settled") return { kind: "settled" };
		if (first.kind === "agent_end") {
			// 中断/出错的回合不会再来 settled：如实记 interrupted，不归档半成品。
			if (first.stopReason === "aborted" || first.stopReason === "error") return { kind: "ended", stopReason: first.stopReason };
			const settled = await adapter.waitFor((event) => event.kind === "settled" && matches(event), settleMs);
			return settled && settled.kind === "settled" ? { kind: "settled" } : { kind: "timeout" };
		}
		return { kind: "timeout" };
	}

	async settleAndArchive(input: { operation: DocumentWorkOperation; preparation: DocumentWorkPreparation; target: DocumentWorkRuntimeTarget; runtime: DocumentWorkRuntimePort; adapter: DocumentWorkRuntimeAdapter }): Promise<ArchiveOutcome> {
		const settled = await this.waitForSettle(input.adapter, input.target);
		if (settled.kind === "timeout") return { state: "unknown", code: "DISPATCH_UNKNOWN", detail: "the runtime did not reach a settled state; the round is not archived and will not be replayed" };
		if (settled.kind === "ended") return { state: "interrupted", code: "RUNTIME_CHANGED", detail: `the round ended with ${settled.stopReason ?? "an error"}` };
		// 稳定点之后仍可能有排队输入或压缩：这时不能把候选当最终成果。
		const flags = await input.runtime.runtimeFlags(input.target);
		if (flags.busy || flags.queued) return { state: "unknown", code: "DISPATCH_UNKNOWN", detail: "the runtime still has work queued after settling" };
		const report = input.adapter.findReport({ attemptId: input.operation.attemptId, preparationId: input.preparation.preparationId, digest: input.preparation.digest });
		if (!report) return { state: "failed", code: "DISPATCH_UNKNOWN", detail: "the round settled without an artifact report; no version was archived" };
		return await this.archive({ operation: input.operation, preparation: input.preparation, report });
	}

	private async archive(input: { operation: DocumentWorkOperation; preparation: DocumentWorkPreparation; report: DocumentArtifactCandidateReport }): Promise<ArchiveOutcome> {
		const work = this.deps.store.readWork(input.operation.workId);
		if ("error" in work) return { state: "failed", code: work.error.code, detail: work.error.detail };
		const root = this.deps.store.getOutputRoot(work.value.record.outputRootId);
		if ("error" in root) return { state: "failed", code: root.error.code, detail: root.error.detail };
		const artifacts = this.storeFor(root.value.path);
		const stagingPrefix = `${input.preparation.stagingRelativeDir}/`;
		const verified: { artifacts: { relativePath: string; absolutePath: string; sha256: string; bytes: number; existenceOnly?: boolean }[]; sources: typeof verified.artifacts } = { artifacts: [], sources: [] };
		const collect = (list: readonly string[], bucket: typeof verified.artifacts): ArchiveOutcome | undefined => {
			for (const candidate of list) {
				const label = typeof candidate === "string" ? candidate.slice(0, 120) : "(not a string)";
				if (!isSafeRelativePath(candidate)) return { state: "failed", code: "PATH_DENIED", detail: `the reported path is not a bounded relative path: ${label}` };
				if (!candidate.startsWith(stagingPrefix) || candidate.includes(`/${STAGING_INTERNAL_DIR}/`)) return { state: "failed", code: "PATH_DENIED", detail: `the reported path is outside this round's staging directory: ${label}` };
				const absolute = resolveWithinRoot(this.deps.pathFs, root.value.path, candidate);
				if (!absolute.ok) return { state: "failed", code: absolute.error.code, detail: absolute.error.detail };
				const stat = this.deps.pathFs.stat(absolute.absolutePath);
				if (!stat || !stat.isFile() || stat.size === 0) return { state: "failed", code: "PATH_DENIED", detail: `the reported file is missing or empty: ${label}` };
				if (stat.size > DOCUMENT_WORK_BUDGETS.artifactBytes) {
					const evidence = artifacts.evidence(absolute.absolutePath, candidate);
					if ("error" in evidence) return { state: "failed", code: evidence.error.code, detail: evidence.error.detail };
					bucket.push({ relativePath: candidate, absolutePath: absolute.absolutePath, sha256: evidence.value.sha256, bytes: evidence.value.bytes, existenceOnly: true });
					continue;
				}
				const fingerprint = artifacts.fingerprint(absolute.absolutePath);
				if ("error" in fingerprint) return { state: "failed", code: fingerprint.error.code, detail: fingerprint.error.detail };
				bucket.push({ relativePath: candidate, absolutePath: absolute.absolutePath, sha256: fingerprint.value.sha256, bytes: fingerprint.value.bytes });
			}
			return undefined;
		};
		const rejected = collect(input.report.artifacts, verified.artifacts) ?? collect(input.report.editableSources, verified.sources);
		if (rejected) return rejected;
		if (verified.artifacts.length === 0) return { state: "failed", code: "INVALID_INPUT", detail: "the report listed no usable deliverable" };

		const allocation = artifacts.allocateVersionDir(input.preparation.outputRelativeDir, work.value.versions.length + 1);
		if ("error" in allocation) return { state: "failed", code: allocation.error.code, detail: allocation.error.detail };
		const versionId = `v${String(allocation.value.ordinal).padStart(4, "0")}_${input.operation.attemptId}`;
		const versionName = `v${String(allocation.value.ordinal).padStart(4, "0")}`;

		const archivedArtifacts: DocumentArtifactFile[] = [];
		const archivedSources: DocumentArtifactFile[] = [];
		for (const [list, bucket] of [
			[verified.artifacts, archivedArtifacts],
			[verified.sources, archivedSources],
		] as const) {
			for (const file of list) {
				const relativeUnderStaging = file.relativePath.slice(stagingPrefix.length);
				const destination = join(allocation.value.absolutePath, relativeUnderStaging);
				const parent = dirname(destination);
				if (parent) this.deps.pathFs.mkdirRecursive(parent);
				if (file.existenceOnly) {
					// 超预算文件不复制字节，只登记存在证据；检查会记未验证。
					bucket.push({ relativePath: `${allocation.value.relativeDir}/${relativeUnderStaging}`, sha256: file.sha256, bytes: file.bytes, existenceOnly: true });
					continue;
				}
				const copied = artifacts.copyVerified({ sourceAbsolutePath: file.absolutePath, destinationAbsolutePath: destination, expectedSha256: file.sha256 });
				if ("error" in copied) return { state: "failed", code: copied.error.code, detail: copied.error.detail };
				bucket.push({ relativePath: `${allocation.value.relativeDir}/${relativeUnderStaging}`, sha256: copied.value.sha256, bytes: copied.value.bytes });
			}
		}

		// 原始字节快照：归档当时的旧稿留一份，用户手改成果文件后仍能对账。
		const snapshots: DocumentArtifactFile[] = [];
		const primary = verified.artifacts[0];
		if (!primary.existenceOnly) {
			const snapshot = artifacts.snapshot(input.preparation.outputRelativeDir, versionName, primary.absolutePath, basename(primary.relativePath));
			if ("error" in snapshot) return { state: "failed", code: snapshot.error.code, detail: snapshot.error.detail };
			snapshots.push(snapshot.value);
		}
		if (input.preparation.base) {
			const frozen = resolveWithinRoot(this.deps.pathFs, root.value.path, `${input.preparation.stagingRelativeDir}/${STAGING_INTERNAL_DIR}/base/${basename(input.preparation.base.relativePath)}`);
			if (frozen.ok && this.deps.pathFs.exists(frozen.absolutePath)) {
				const snapshot = artifacts.snapshot(input.preparation.outputRelativeDir, `${versionName}-base`, frozen.absolutePath, basename(input.preparation.base.relativePath));
				if ("error" in snapshot) return { state: "failed", code: snapshot.error.code, detail: snapshot.error.detail };
				snapshots.push(snapshot.value);
			}
		}

		const candidate = archivedArtifacts[0];
		const extension = candidate.relativePath.slice(candidate.relativePath.lastIndexOf(".")).toLowerCase();
		const method = extension === ".docx" || extension === ".pptx" || extension === ".xlsx" ? "word_local_edit" : "markdown_source";
		const candidateAbsolute = resolveWithinRoot(this.deps.pathFs, root.value.path, candidate.relativePath);
		const inspection = await this.deps.inspection.inspect({
			...(input.preparation.base
				? {
						base: {
							absolutePath: this.resolveArchivedBasePath(root.value.path, archivedSources, input.preparation),
							relativePath: input.preparation.base.relativePath,
						},
					}
				: {}),
			candidate: { absolutePath: candidateAbsolute.ok ? candidateAbsolute.absolutePath : "", relativePath: candidate.relativePath, ...(candidate.existenceOnly ? { existenceOnly: true } : {}) },
			scope: input.preparation.scope,
		});
		if ("error" in inspection) return { state: "failed", code: inspection.error.code, detail: inspection.error.detail };

		const version: DocumentArtifactVersion = {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			workId: input.operation.workId,
			versionId,
			ordinal: allocation.value.ordinal,
			attemptId: input.operation.attemptId,
			preparationId: input.preparation.preparationId,
			...(input.preparation.base ? { parentVersionId: input.preparation.base.versionId } : {}),
			kind: input.preparation.kind,
			relativeDir: allocation.value.relativeDir,
			artifacts: archivedArtifacts,
			editableSources: archivedSources,
			snapshots,
			provenance: input.preparation.base ? { kind: "revised_from_base", baseVersionId: input.preparation.base.versionId, method } : { kind: "created", method },
			...(input.preparation.base ? { base: input.preparation.base } : {}),
			inspection: inspection.value,
			...(input.report.summary ? { modelSummary: input.report.summary.slice(0, 4000) } : {}),
			...(input.report.risks.length ? { modelRisks: input.report.risks.slice(0, 20) } : {}),
			userAcceptance: "not_collected",
			archivedAt: this.now(),
		};
		const stored = this.deps.store.withWork(input.operation.workId, work.value.revision, (bucket) => {
			if (bucket.versions.some((existing) => existing.versionId === versionId)) return workFail<DocumentArtifactVersion>("IO_ERROR", true, { detail: "this version was already recorded" });
			return workOk({ bucket: { ...bucket, versions: [...bucket.versions, version] }, value: version });
		});
		if ("error" in stored) return { state: "failed", code: stored.error.code, detail: stored.error.detail };
		return { state: "archived", versionId };
	}

	/** 检查用的基稿路径：冻结副本在 staging 内；已被清理时退回本轮归档的副本。 */
	private resolveArchivedBasePath(outputRootPath: string, archivedSources: DocumentArtifactFile[], preparation: DocumentWorkPreparation): string {
		const base = preparation.base;
		if (!base) return "";
		const frozen = resolveWithinRoot(this.deps.pathFs, outputRootPath, `${preparation.stagingRelativeDir}/${STAGING_INTERNAL_DIR}/base/${basename(base.relativePath)}`);
		if (frozen.ok && this.deps.pathFs.exists(frozen.absolutePath)) return frozen.absolutePath;
		const name = basename(base.relativePath);
		for (const file of archivedSources) {
			if (basename(file.relativePath) !== name || file.existenceOnly) continue;
			const resolved = resolveWithinRoot(this.deps.pathFs, outputRootPath, file.relativePath);
			if (resolved.ok) return resolved.absolutePath;
		}
		return "";
	}
}
