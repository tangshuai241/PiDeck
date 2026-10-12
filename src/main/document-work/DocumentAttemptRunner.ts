/**
 * 本轮尝试的生命周期：绑定 → 分发 → 等待真正开始 → 等待稳定完成 → 归档。
 *
 * 与 `DocumentWorkService` 分开的原因：这里的判据全是时间与运行时状态（超时、稳定、
 * 退出取消），和「记录怎么写、授权怎么核」是两套关注点；放一起会同时越过文件体量
 * 红线和单一职责。
 *
 * 三条硬性语义：
 * - RPC 接受不等于扩展已绑定，绑定未确认就绝不分发批准；
 * - 分发接受也不等于本轮已开始，只按稳定完成结算会立刻收出空版本；
 * - 退出/取消属于中断，不是失败，留给启动结算转 `interrupted`，不在这里伪造成 failed。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import { encodeBindingPayload, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentWorkChangedEvent, DocumentWorkExtensionState, DocumentWorkOperation, DocumentWorkPreparation, DocumentWorkRecord, WorkErrorCode } from "../../shared/types/documentWork";
import { DOCUMENT_WORK_BIND_COMMAND } from "../../shared/types/documentWork";
import type { ArtifactStoreFailure, DocumentArtifactStore } from "./DocumentArtifactStore";
import type { DocumentInspectionService } from "./DocumentInspectionService";
import type { DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { emitWorkChanged, type DocumentWorkChangeEmitter } from "./documentWorkEvents";

const DEFAULT_BIND_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 3 * 60_000;

export type DocumentAttemptRunnerDeps = {
	store: DocumentWorkStore;
	artifacts: DocumentArtifactStore;
	inspection: DocumentInspectionService;
	runtime: DocumentWorkRuntimeAdapter;
	onChanged: DocumentWorkChangeEmitter;
	logger?: { warn(scope: string, message: string, detail?: unknown): unknown };
	byteBudget?: number;
	bindTimeoutMs?: number;
	settleTimeoutMs?: number;
	startTimeoutMs?: number;
};

/** 结构化 detail 只允许标识与枚举，禁止把路径或正文写进错误。 */
function safeDetail(detail: string): string {
	return /^[A-Za-z0-9_.:-]{1,200}$/.test(detail) ? detail : "detail_redacted";
}

export class DocumentAttemptRunner {
	private readonly byteBudget: number;
	private readonly bindTimeoutMs: number;
	private readonly settleTimeoutMs: number;
	private readonly startTimeoutMs: number;
	/** 扩展汇报的候选按 attemptId 归档；迟到候选绑定不到新尝试。 */
	private readonly extensionStateByAttempt = new Map<string, DocumentWorkExtensionState>();
	private readonly attempts = new Map<string, { attemptId: string; cancelled: boolean }>();
	private readonly watchers = new Set<Promise<void>>();

	constructor(private readonly deps: DocumentAttemptRunnerDeps) {
		this.byteBudget = deps.byteBudget ?? 64 * 1024 * 1024;
		this.bindTimeoutMs = deps.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS;
		this.settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		this.startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	}

	/** 扩展汇报只进候选表；归档仍要等运行稳定并独立校验文件。 */
	observeExtensionState(sessionId: string, state: DocumentWorkExtensionState): void {
		if (state.sessionId !== sessionId) return;
		this.extensionStateByAttempt.set(state.attemptId, state);
	}

	/** 取消只影响本轮：标记后结算协程在下一个检查点收敛。 */
	markCancelled(workId: string): void {
		const attempt = this.attempts.get(workId);
		if (attempt) attempt.cancelled = true;
	}

	beginShutdown(): void {
		for (const attempt of this.attempts.values()) attempt.cancelled = true;
	}

	async drain(): Promise<void> {
		await Promise.allSettled([...this.watchers]);
	}

	async dispatch(record: DocumentWorkRecord, preparation: DocumentWorkPreparation, operation: DocumentWorkOperation): Promise<WorkResult<DocumentWorkOperation>> {
		const encoded = this.buildBindingPayload(record, preparation, operation);
		if (!encoded) return this.failOperation(operation, "INVALID_INPUT", "payload_too_large");
		const bind = await this.deps.runtime.sendCommand({ sessionId: record.sessionId, requestId: `dwbind_${operation.requestId}`, message: `${DOCUMENT_WORK_BIND_COMMAND} bind ${encoded}`, expectedRuntime: operation.runtime });
		if (!bind.accepted) return this.failOperation(operation, bind.unknown ? "DISPATCH_UNKNOWN" : "RUNTIME_CHANGED", bind.error);
		if (!(await this.waitForExtensionBinding(operation))) return this.failOperation(operation, "EXTENSION_UNAVAILABLE", "binding_not_confirmed");
		const running: DocumentWorkOperation = { ...operation, phase: "running", extensionBound: true, dispatchAccepted: true, updatedAt: Date.now() };
		await this.deps.store.saveOperation(running);
		this.emit(record, "running", running.attemptId);
		// 确认授权只在扩展确认绑定之后才分发：顺序不可被渲染层或模型重排。
		if (operation.authorization.kind === "alignment_confirmation") {
			const approve = await this.deps.runtime.sendCommand({ sessionId: record.sessionId, requestId: `dwapprove_${operation.requestId}`, message: `/align approve ${operation.authorization.briefId} ${operation.authorization.revision}`, expectedRuntime: operation.runtime });
			if (!approve.accepted) return this.failOperation(running, approve.unknown ? "DISPATCH_UNKNOWN" : "RUNTIME_CHANGED", approve.error);
			if (approve.unknown) return this.failOperation(running, "DISPATCH_UNKNOWN");
		}
		this.attempts.set(record.workId, { attemptId: running.attemptId, cancelled: false });
		// 结算协程登记在册：退出时先取消再 drain，禁止在拆除后继续写盘。
		const watcher = this.watchAttempt(record.workId, running).finally(() => this.watchers.delete(watcher));
		this.watchers.add(watcher);
		return workSuccess(running);
	}

	/** 扩展必须在超时内确认绑定；RPC 接受不等于绑定成功。 */
	private async waitForExtensionBinding(operation: DocumentWorkOperation): Promise<boolean> {
		const deadline = Date.now() + this.bindTimeoutMs;
		while (Date.now() < deadline) {
			const state = this.extensionStateByAttempt.get(operation.attemptId);
			if (state && state.workId === operation.workId && state.preparationId === operation.preparation.preparationId && state.digest === operation.preparation.digest) return true;
			await new Promise<void>((resolve) => {
				const timer = delay(resolve, 100);
				timer.unref?.();
			});
		}
		return false;
	}

	// ------------------------------------------------------------------ settle / archive

	/**
	 * 本轮结算协程：先确认真的跑过，再等稳定完成，最后归档。
	 * 任何异常都在这里结算干净——后台任务抛出未处理拒绝会打到主进程，用户却看不到任何状态。
	 */
	private async watchAttempt(workId: string, operation: DocumentWorkOperation): Promise<void> {
		const aborted = () => this.attempts.get(workId)?.cancelled === true || this.deps.runtime.isStopped;
		try {
			// 分发接受不等于本轮已开始：批准刚发出时运行时可能还是 idle，此时归档只会收出空版本。
			if (!(await this.waitForAttemptStart(operation, aborted))) {
				// 退出/取消属于中断，不是失败：留给启动结算转 interrupted，不在这里伪造成 failed。
				if (!aborted()) await this.failOperation(operation, "DISPATCH_UNKNOWN", "run_not_observed");
				return;
			}
			const outcome = await this.deps.runtime.waitForSettle({ target: operation.runtime, timeoutMs: this.settleTimeoutMs, isCancelled: aborted });
			if (aborted()) return;
			const record = await this.deps.store.getRecord(workId);
			if (!record) return;
			if (outcome !== "settled") return void (await this.failOperation(operation, outcome === "runtime_changed" ? "RUNTIME_CHANGED" : "IO_ERROR", outcome));
			await this.archiveAttempt(record, operation);
		} catch (error) {
			this.deps.logger?.warn("document-work", "Attempt settlement failed", { workId, attemptId: operation.attemptId, error: error instanceof Error ? error.message : "unknown" });
			if (!aborted()) await this.failOperation(operation, "IO_ERROR", "settlement_failed").catch(() => undefined);
		}
	}

	/** 本轮开始的判据只能是「观察到运行中」或「模型已汇报候选」；两者都没有就不算开始过。 */
	private async waitForAttemptStart(operation: DocumentWorkOperation, aborted: () => boolean): Promise<boolean> {
		const deadline = Date.now() + this.startTimeoutMs;
		while (Date.now() < deadline) {
			if (aborted()) return false;
			if (this.deps.runtime.isBusyFor(operation.runtime.sessionId, operation.runtime)) return true;
			if (this.extensionStateByAttempt.get(operation.attemptId)?.phase === "reported") return true;
			await this.deps.runtime.waitForChange(Math.min(1_000, Math.max(1, deadline - Date.now())));
		}
		return false;
	}

	private async archiveAttempt(record: DocumentWorkRecord, operation: DocumentWorkOperation): Promise<void> {
		const preparation = await this.deps.store.getPreparation(record.workId, operation.preparation.preparationId);
		if (!preparation) return void (await this.failOperation(operation, "PREPARATION_STALE"));
		const inspecting: DocumentWorkOperation = { ...operation, phase: "inspecting", updatedAt: Date.now() };
		await this.deps.store.saveOperation(inspecting);
		this.emit(record, "inspecting", operation.attemptId);
		const candidate = this.extensionStateByAttempt.get(operation.attemptId);
		const files = candidate?.report?.artifacts.length ? [...candidate.report.artifacts] : await this.fallbackArtifacts(preparation);
		if (files.length === 0) return void (await this.failOperation(inspecting, "INSPECTION_UNVERIFIED", "no_candidate_files"));
		const versions = await this.deps.store.listVersions(record.workId, record.versionIds);
		const versionId = `v_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const archived = await this.deps.artifacts.archiveVersion(
			{
				workId: record.workId,
				versionId,
				ordinal: Math.max(0, ...versions.map((version) => version.ordinal)) + 1,
				title: record.title,
				kind: preparation.kind,
				workDirectory: record.workDirectory,
				snapshotDirectory: this.deps.artifacts.snapshotDirectory(record.workId, versionId),
				stagingDirectory: preparation.stagingDirectory,
				files,
				...(preparation.base ? { baseVersionId: preparation.base.versionId, baseDigest: preparation.base.digest } : {}),
				generation: { role: "model", ...(preparation.base ? { sourceVersionId: preparation.base.versionId } : {}) },
			},
			this.byteBudget,
		);
		if (!archived.ok) return void (await this.failOperation(inspecting, archived.reason === "changed" ? "BASE_CHANGED" : "IO_ERROR", archived.reason satisfies ArtifactStoreFailure["reason"]));
		const primary = archived.value.artifacts.find((artifact: DocumentArtifactVersion["artifacts"][number]) => artifact.role === "primary") ?? archived.value.artifacts[0];
		const comparedTextDigest = await this.baseTextDigest(preparation);
		const inspection = await this.deps.inspection.inspect({
			versionId,
			filePath: join(record.workDirectory, "versions", archived.value.directory, ...primary.relativePath.split("/")),
			...(preparation.base ? { comparedTo: { versionId: preparation.base.versionId, ...(comparedTextDigest ? { textDigest: comparedTextDigest } : {}) } } : {}),
		});
		const version: DocumentArtifactVersion = { ...archived.value, inspection, modelSummary: candidate?.report?.summary ?? "", modelRisks: candidate?.report?.risks ?? [] };
		await this.deps.store.saveVersion(version);
		const mutated = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({
			...current,
			versionIds: [...current.versionIds, versionId],
			consumedRevisionTurns: operation.authorization.kind === "revision_instruction" ? [...new Set([...current.consumedRevisionTurns, operation.authorization.sourceTurnHash])] : current.consumedRevisionTurns,
			...(current.activeRequestId === operation.requestId ? { activeRequestId: undefined } : {}),
		}));
		if (!mutated.ok) return void (await this.failOperation(inspecting, mutated.error.code, undefined, mutated.error.currentRevision));
		const settled: DocumentWorkOperation = { ...inspecting, phase: inspection.status === "failed" ? "failed" : "archived", versionId, ...(inspection.status === "failed" ? { error: { code: "INSPECTION_UNVERIFIED" as const, retryable: false, detail: "inspection_failed" } } : {}), updatedAt: Date.now() };
		await this.deps.store.saveOperation(settled);
		this.attempts.delete(record.workId);
		await this.deps.store.removeStaging(preparation.stagingDirectory);
		this.emit(mutated.value, inspection.status === "failed" ? "failed" : "archived", operation.attemptId);
	}

	private async baseTextDigest(preparation: DocumentWorkPreparation): Promise<string | undefined> {
		if (!preparation.base) return undefined;
		const versions = await this.deps.store.listVersions(preparation.workId, [preparation.base.versionId]);
		return versions[0]?.inspection?.coverage.textDigest;
	}

	/** 模型没汇报候选时的兜底：只认 staging 里的文稿类文件，避免把日志当成果。 */
	private async fallbackArtifacts(preparation: DocumentWorkPreparation): Promise<{ relativePath: string; role: "primary" | "editable_source" | "supporting" }[]> {
		const files = await this.deps.artifacts.listStagingFiles(preparation.stagingDirectory);
		const documentLike = files.filter((file) => /\.(?:docx|doc|md|markdown|txt)$/i.test(file));
		if (documentLike.length === 0) return [];
		const primary = documentLike.find((file) => /\.docx$/i.test(file)) ?? documentLike.find((file) => /\.md$/i.test(file)) ?? documentLike[0];
		return documentLike.map((file) => ({ relativePath: file, role: file === primary ? ("primary" as const) : /\.md$/i.test(file) ? ("editable_source" as const) : ("supporting" as const) }));
	}

	private async failOperation(operation: DocumentWorkOperation, code: WorkErrorCode, detail?: string, currentRevision?: number): Promise<WorkResult<DocumentWorkOperation>> {
		const failed: DocumentWorkOperation = {
			...operation,
			phase: code === "DISPATCH_UNKNOWN" ? "unknown" : "failed",
			dispatchUnknown: code === "DISPATCH_UNKNOWN",
			error: { code, retryable: code === "RUNTIME_CHANGED" || code === "IO_ERROR", ...(detail ? { detail: safeDetail(detail) } : {}), ...(currentRevision !== undefined ? { currentRevision } : {}) },
			updatedAt: Date.now(),
		};
		await this.deps.store.saveOperation(failed);
		this.attempts.delete(operation.workId);
		const record = await this.deps.store.getRecord(operation.workId);
		if (record?.activeRequestId === operation.requestId) {
			const cleared = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({ ...current, activeRequestId: undefined }));
			if (cleared.ok) this.emit(cleared.value, failed.phase === "unknown" ? "unknown" : "failed", operation.attemptId);
		}
		this.deps.logger?.warn("document-work", "Operation failed", { workId: operation.workId, attemptId: operation.attemptId, code });
		return workFailure<DocumentWorkOperation>(code, detail, currentRevision);
	}

	/** 绑定载荷：只放本轮真实解析出的路径与身份，不放正文。 */
	private buildBindingPayload(record: DocumentWorkRecord, preparation: DocumentWorkPreparation, operation: DocumentWorkOperation): string | undefined {
		const payload = {
			schemaVersion: 1,
			workId: record.workId,
			attemptId: operation.attemptId,
			preparationId: preparation.preparationId,
			digest: preparation.digest,
			sessionId: record.sessionId,
			kind: preparation.kind,
			workDirectory: record.workDirectory,
			stagingDirectory: preparation.stagingDirectory,
			materialCacheDirectory: this.deps.store.materialCacheDirectory,
			materials: preparation.materials.map((material) => ({ materialId: material.materialId, label: material.label, path: material.hostPath, digest: material.digest })),
			...(preparation.base ? { base: { versionId: preparation.base.versionId, path: preparation.base.frozenPath, digest: preparation.base.digest, fileName: preparation.base.fileName } } : {}),
			scope: preparation.scope,
			requirements: { summary: preparation.requirementsSummary },
		};
		return encodeBindingPayload(payload);
	}

	private emit(record: DocumentWorkRecord, changeKind: DocumentWorkChangedEvent["changeKind"], attemptId?: string): void {
		emitWorkChanged(this.deps.onChanged, record, changeKind, attemptId);
	}
}
