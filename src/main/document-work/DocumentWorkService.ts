/**
 * 文稿工作域编排：建立工作、冻结准备、经原 RPC 分发、结算归档。
 *
 * 授权模型（方案第 5、6 节）：
 * - 授权只有两种来源：当前要求的明确确认（对齐 `briefId + revision`）或本轮明确改稿
 *   用户指令（用最新用户轮的正文指纹核对）。模型文本、布尔字段、渲染层状态都不授权。
 * - RPC 接受、扩展绑定、运行开始、检查通过分别是不同事实，任何一步都不替代下一步。
 *
 * 本类只保留「公开接口 + 授权顺序 + 事务边界」；具体职责已拆到：
 * - `DocumentWorkTransaction`：requestId 去重台账与按 work 串行（副作用不重复）
 * - `DocumentRuntimeLeaseRegistry`：运行时排他租约（一轮 runtime 只允许一轮执行）
 * - `DocumentWorkPreparationFactory`：要求/材料/基稿的校验与不可变准备记录
 * - `DocumentWorkQueries`：只读快照与真实用户轮
 * - `DocumentAttemptRunner`：绑定 → 分发 → 稳定完成 → 归档
 *
 * 锁顺序（不可颠倒）：`runtime:<sessionId>` → `tx:<workId>` → store 内部锁。
 */
import { randomUUID } from "node:crypto";
import { buildWorkFolder, kindForRequirements, sameRequirements, sameRuntimeTriple, sanitizeWorkTitle, stableStringify, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import type { AuthorizationReference, DocumentWorkChangedEvent, DocumentWorkExtensionState, DocumentWorkOperation, DocumentWorkPreparation, DocumentWorkRecord, DocumentWorkView, PreparedWork, RequirementsReference, SessionRuntimeTriple, StartWorkInput, WorkMutation } from "../../shared/types/documentWork";
import type { AlignmentState } from "../../shared/types/alignment";
import { isDocumentWorkIntent, isExplicitRevisionRequest, revisionScopeHints } from "../../shared/documentIntentPolicy";
import type { DocumentArtifactStore } from "./DocumentArtifactStore";
import type { DocumentInspectionService } from "./DocumentInspectionService";
import type { DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { DocumentAttemptRunner } from "./DocumentAttemptRunner";
import { DocumentRuntimeLeaseRegistry } from "./DocumentRuntimeLease";
import { DocumentWorkPreparationFactory, type MaterialResolver, type PrepareWorkRequest } from "./DocumentWorkPreparation";
import { DocumentWorkQueries } from "./DocumentWorkQueries";
import { DocumentWorkTransaction } from "./DocumentWorkTransaction";
import { emitWorkChanged } from "./documentWorkEvents";
import { parseCancelPayload, parseCreatePayload, parseOperationPayload, parsePreparationPayload, workErrorFor } from "./documentWorkReceipts";
import { hashText, insertId, isPathInsideAnyRoot, isReadableFile } from "./documentWorkPaths";
import { hashTurnText } from "./documentWorkTurn";

export type DocumentWorkLogger = { info(scope: string, message: string, detail?: unknown): unknown; warn(scope: string, message: string, detail?: unknown): unknown };

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
	/** 并发回归测试注入点：在租约锁内、读取之前触发，用来强制两个 acquire 交错。 */
	leaseAcquireBarrier?: () => Promise<void> | void;
};

export type CreateWorkInput = {
	requestId: string;
	sessionId: string;
	sourceTurnId: string;
	title?: string;
	outputRootId: string;
};

export type PrepareWorkInput = WorkMutation & PrepareWorkRequestFields;

type PrepareWorkRequestFields = Omit<PrepareWorkRequest, "workId" | "expectedRevision" | "requestId">;

export type StartWorkRequest = StartWorkInput;

export type CancelWorkRequest = WorkMutation & { attemptId: string; expectedRuntime: SessionRuntimeTriple };

const MATERIAL_ALLOWLIST_TTL_MS = 30 * 60_000;

export class DocumentWorkService {
	private readonly byteBudget: number;
	private readonly materialAllowlist = new Map<string, { path: string; expiresAt: number }[]>();
	private readonly alignmentBySession = new Map<string, AlignmentState>();
	private readonly attempts: DocumentAttemptRunner;
	private readonly transaction: DocumentWorkTransaction;
	private readonly leases: DocumentRuntimeLeaseRegistry;
	private readonly queries: DocumentWorkQueries;
	private readonly preparation: DocumentWorkPreparationFactory;

	constructor(private readonly deps: DocumentWorkServiceDeps) {
		this.byteBudget = deps.byteBudget ?? 64 * 1024 * 1024;
		this.transaction = new DocumentWorkTransaction(deps.store);
		this.leases = new DocumentRuntimeLeaseRegistry(deps.store, deps.leaseAcquireBarrier);
		this.queries = new DocumentWorkQueries(deps.store, deps.runtime);
		this.preparation = new DocumentWorkPreparationFactory({
			store: deps.store,
			artifacts: deps.artifacts,
			inspection: deps.inspection,
			runtime: deps.runtime,
			queries: this.queries,
			materials: deps.materials,
			readAlignmentState: (sessionId) => this.alignmentBySession.get(sessionId),
			byteBudget: this.byteBudget,
		});
		this.attempts = new DocumentAttemptRunner({
			store: deps.store,
			artifacts: deps.artifacts,
			inspection: deps.inspection,
			runtime: deps.runtime,
			onChanged: deps.onChanged,
			lease: this.leases,
			...(deps.logger ? { logger: deps.logger } : {}),
			...(deps.byteBudget !== undefined ? { byteBudget: deps.byteBudget } : {}),
			...(deps.bindTimeoutMs !== undefined ? { bindTimeoutMs: deps.bindTimeoutMs } : {}),
			...(deps.settleTimeoutMs !== undefined ? { settleTimeoutMs: deps.settleTimeoutMs } : {}),
			...(deps.startTimeoutMs !== undefined ? { startTimeoutMs: deps.startTimeoutMs } : {}),
		});
	}

	private emit(record: DocumentWorkRecord, changeKind: DocumentWorkChangedEvent["changeKind"], attemptId?: string): void {
		emitWorkChanged(this.deps.onChanged, record, changeKind, attemptId);
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

	/** 建立工作：一个会话一件，重复提交幂等返回原工作。 */
	async createWork(input: CreateWorkInput): Promise<WorkResult<DocumentWorkView>> {
		return this.transaction.run({
			lockKey: `work:${input.sessionId}`,
			requestId: input.requestId,
			requestDigest: hashText(stableStringify({ kind: "create", sessionId: input.sessionId, sourceTurnId: input.sourceTurnId, outputRootId: input.outputRootId })),
			decodeValue: async (value) => {
				const stored = parseCreatePayload(value);
				if (!stored) return undefined;
				return this.queries.readView(stored.workId, input.sessionId);
			},
			action: () => this.createWorkExclusive(input),
		});
	}

	private async createWorkExclusive(input: CreateWorkInput): Promise<WorkResult<DocumentWorkView>> {
		// 文稿归档只适用于明确的正式文稿任务：普通 Plan/编码/解释不建工作，走原生批准。
		const turn = await this.queries.latestUserTurn(input.sessionId);
		if (!turn || !isDocumentWorkIntent(turn.text)) return workFailure<DocumentWorkView>("INVALID_INPUT", "not_document_intent");
		const outputRoot = await this.deps.store.getOutputRoot(input.outputRootId);
		if (!outputRoot || !(await this.deps.artifacts.directoryExists(outputRoot.path))) return workFailure<DocumentWorkView>("PATH_DENIED");
		// 一个会话一件工作：已有记录直接返回，不因重复提交再建第二件。
		const existingIds = await this.deps.store.listWorkIdsForSession(input.sessionId);
		const existing = existingIds.length ? await this.deps.store.getRecord(existingIds[0]) : undefined;
		if (existing) return this.queries.viewOf(existing);
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
			consumedRevisionTurnIds: [],
			createdAt: now,
			updatedAt: now,
		};
		const created = await this.deps.store.createRecord(record);
		if (!created.ok) return workFailure<DocumentWorkView>(created.error.code);
		this.emit(created.value, "created");
		return this.queries.viewOf(created.value);
	}

	// ------------------------------------------------------------------ read

	async getView(workId: string, sessionId: string): Promise<WorkResult<DocumentWorkView>> {
		const view = await this.queries.readView(workId, sessionId);
		return view ? workSuccess(view) : workFailure<DocumentWorkView>("WORK_NOT_FOUND");
	}

	listForSession(sessionId: string): Promise<DocumentWorkView[]> {
		return this.queries.listForSession(sessionId);
	}

	async getOperation(workId: string, requestId: string, sessionId: string): Promise<WorkResult<DocumentWorkOperation>> {
		const record = await this.deps.store.getRecord(workId);
		if (!record || record.sessionId !== sessionId) return workFailure<DocumentWorkOperation>("WORK_NOT_FOUND");
		const operation = await this.deps.store.getOperation(workId, requestId);
		return operation ? workSuccess(operation) : workFailure<DocumentWorkOperation>("OPERATION_NOT_FOUND");
	}

	// ------------------------------------------------------------------ prepare

	async prepare(input: PrepareWorkInput): Promise<WorkResult<PreparedWork>> {
		return this.transaction.run({
			lockKey: `work:${input.workId}`,
			requestId: input.requestId,
			requestDigest: hashText(stableStringify(input)),
			decodeValue: parsePreparationPayload,
			action: () => this.preparation.prepare(input),
		});
	}

	// ------------------------------------------------------------------ start

	/**
	 * 开始一轮：先去重（重放返回原回执，含失败/unknown），再校验，最后占用运行时并分发。
	 *
	 * 事务边界覆盖「读取 → 授权校验 → operation/active 写入 → 回执」，因此并发两次 start
	 * 不会各自写出一份 operation；运行时段则由租约保证同一 runtime 只有一轮执行。
	 */
	async start(input: StartWorkRequest): Promise<WorkResult<DocumentWorkOperation>> {
		// 事务只覆盖「读取 → 授权校验 → operation/active 写入 → 回执」；
		// 绑定与批准在事务外执行，锁不跨 RPC 等待（排他由 active 记录 + 运行时租约保证）。
		const outcome = await this.transaction.runWithOutcome({
			lockKey: `work:${input.workId}`,
			requestId: input.requestId,
			requestDigest: hashText(stableStringify(input)),
			decodeValue: async (value) => {
				const stored = parseOperationPayload(value);
				if (!stored) return undefined;
				// 回执存的是分发时的快照；重放要返回**当前**记录，否则 unknown/归档后的重放会看到旧状态。
				return (await this.deps.store.getOperation(stored.workId, stored.requestId)) ?? stored;
			},
			action: () => this.startExclusive(input),
		});
		if (!outcome.result.ok || !outcome.executed) return outcome.result;
		const dispatched = await this.dispatchCommitted(input.workId, outcome.result.value);
		// 分发结果补齐回执：重放同一 requestId 得到的原结论（含失败与 unknown），且不重新分发。
		await this.transaction.finalizeReceipt(input.requestId, hashText(stableStringify(input)), dispatched);
		return dispatched;
	}

	/** 事务提交后的分发：重读一次记录与准备（事务里那份可能已被其它步骤推进）。 */
	private async dispatchCommitted(workId: string, operation: DocumentWorkOperation): Promise<WorkResult<DocumentWorkOperation>> {
		const record = await this.deps.store.getRecord(workId);
		if (!record) return workFailure<DocumentWorkOperation>("WORK_NOT_FOUND");
		const preparation = await this.deps.store.getPreparation(workId, operation.preparation.preparationId);
		if (!preparation) return workFailure<DocumentWorkOperation>("PREPARATION_STALE");
		return this.attempts.dispatch(record, preparation, operation);
	}

	private async startExclusive(input: StartWorkRequest): Promise<WorkResult<DocumentWorkOperation>> {
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<DocumentWorkOperation>("WORK_NOT_FOUND");
		// 先看有没有在途尝试（含 unknown）：这是最可操作的结论，也避免在「上一轮还没结算」时
		// 用版本号变化把用户引到错误的修复方向（等他重新准备）。
		if (record.activeRequestId) {
			const active = await this.deps.store.getOperation(record.workId, record.activeRequestId);
			if (active && active.phase !== "archived" && active.phase !== "failed" && active.phase !== "interrupted") return workFailure<DocumentWorkOperation>("RUNTIME_BUSY", active.phase);
		}
		if (record.revision !== input.expectedRevision) return workFailure<DocumentWorkOperation>("REVISION_CONFLICT", undefined, record.revision);
		const preparation = await this.deps.store.getPreparation(input.workId, input.preparation.preparationId);
		if (!preparation || preparation.digest !== input.preparation.digest) return workFailure<DocumentWorkOperation>("PREPARATION_STALE");
		if (preparation.workRevision !== record.revision) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", "revision_advanced", record.revision);
		const runtime = await this.deps.runtime.snapshot(record.sessionId);
		if (!runtime) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED");
		if (!sameRuntimeTriple(runtime.target, input.expectedRuntime)) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED");
		if (!sameRuntimeTriple(preparation.runtime, input.expectedRuntime)) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED", "prepared_elsewhere");
		// 原生会话身份也复核：进程换绑到别的 pi 会话后旧准备同样失效。
		if (preparation.nativeSessionId && runtime.nativeSessionId && preparation.nativeSessionId !== runtime.nativeSessionId) return workFailure<DocumentWorkOperation>("RUNTIME_CHANGED", "native_session_changed");
		// 对齐批准必须从空闲态开始（它自己会触发一个模型回合）；改稿轮允许此时 Pi 正忙，
		// 结算协程会等本轮稳定结束再绑定并派发正式改稿提示，不需要用户重开对齐。
		const busy = runtime.state.isStreaming === true || runtime.state.isTurnActive === true || runtime.state.isCompacting === true;
		if (busy && input.authorization.kind !== "revision_instruction") return workFailure<DocumentWorkOperation>("RUNTIME_BUSY");
		if (busy && input.authorization.kind === "revision_instruction" && !(await this.latestTurnMatches(record.sessionId, input.authorization))) return workFailure<DocumentWorkOperation>("APPROVAL_REQUIRED", "instruction_mismatch");
		const authorization = await this.verifyAuthorization(record, preparation, input.authorization);
		if (!authorization.ok) return authorization;
		const materials = await this.preparation.materialsUnchanged(preparation);
		if (!materials.ok) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", materials.detail);
		if (preparation.base && !(await isReadableFile(preparation.base.frozenPath))) return workFailure<DocumentWorkOperation>("PREPARATION_STALE", "frozen_base_missing");

		const now = Date.now();
		const operation: DocumentWorkOperation = {
			schemaVersion: 1,
			requestId: input.requestId,
			workId: record.workId,
			attemptId: insertId("at"),
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
		// 运行时排他先占用：同一 runtime 上另一件工作也不能并行。
		const lease = await this.leases.acquire({ sessionId: record.sessionId, target: input.expectedRuntime, ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}), workId: record.workId, requestId: operation.requestId, attemptId: operation.attemptId });
		if (!lease.ok) return workFailure<DocumentWorkOperation>(lease.error.code, lease.error.detail);
		await this.deps.store.saveOperation(operation);
		const mutated = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({
			...current,
			activeRequestId: operation.requestId,
			operationRequestIds: current.operationRequestIds.includes(operation.requestId) ? current.operationRequestIds : [...current.operationRequestIds, operation.requestId],
			// 改稿轮的「消费」在开始时就落盘：重新挂载/kill 后同一轮不会被再次自动执行。
			// 键是轮标识（稳定 user 消息 id），不是正文 hash：新轮里重复同一句话属于新授权。
			consumedRevisionTurns: operation.authorization.kind === "revision_instruction" ? [...new Set([...current.consumedRevisionTurns, operation.authorization.sourceTurnHash])] : current.consumedRevisionTurns,
			consumedRevisionTurnIds: operation.authorization.kind === "revision_instruction" ? [...new Set([...current.consumedRevisionTurnIds, operation.authorization.sourceTurnId])] : current.consumedRevisionTurnIds,
		}));
		if (!mutated.ok) {
			await this.leases.release(record.sessionId, operation.requestId);
			return workFailure<DocumentWorkOperation>(mutated.error.code, mutated.error.detail, mutated.error.currentRevision);
		}
		this.emit(mutated.value, "dispatching", operation.attemptId);
		// 事务到此为止：分发在锁外进行（见 start）。
		return workSuccess(operation);
	}

	private async verifyAuthorization(record: DocumentWorkRecord, preparation: DocumentWorkPreparation, authorization: AuthorizationReference): Promise<WorkResult<{ confirmed: boolean }>> {
		if (authorization.kind === "alignment_confirmation") {
			const alignment = this.alignmentBySession.get(record.sessionId);
			if (!alignment || alignment.briefId !== authorization.briefId || alignment.revision !== authorization.revision) return workFailure("APPROVAL_REQUIRED", "alignment_mismatch");
			if (alignment.phase !== "ready") return workFailure("APPROVAL_REQUIRED", "alignment_not_ready");
			if (preparation.requirements.kind !== "alignment" || !sameRequirements(preparation.requirements, { kind: "alignment", briefId: authorization.briefId, revision: authorization.revision })) return workFailure("APPROVAL_REQUIRED", "requirements_mismatch");
			return workSuccess({ confirmed: false });
		}
		const latest = await this.queries.latestUserTurn(record.sessionId);
		if (!latest || latest.sourceTurnId !== authorization.sourceTurnId || latest.hash !== authorization.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "instruction_mismatch");
		// 按轮标识判重放：同一轮不能被消费两次（含重新挂载后），但新轮里再说一遍同样的要求是新的授权。
		if (record.consumedRevisionTurnIds.includes(authorization.sourceTurnId)) return workFailure("APPROVAL_REQUIRED", "instruction_replayed");
		if (preparation.requirements.kind !== "user_instruction" || preparation.requirements.sourceTurnHash !== authorization.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "requirements_mismatch");
		// 授权只对应「用户明确提出的那次改稿要求」：准备里声明的范围必须就是授权的那段文字。
		if (hashTurnText(preparation.scope.summary) !== authorization.sourceTurnHash) return workFailure("APPROVAL_REQUIRED", "scope_mismatch");
		// 二次复核：讨论、否定或「先解释」类消息即使原样成为范围文本，也不构成改稿授权。
		if (!isExplicitRevisionRequest(preparation.scope.summary)) return workFailure("APPROVAL_REQUIRED", "not_explicit_revision");
		return workSuccess({ confirmed: true });
	}

	/** 本轮用户轮是否就是授权引用的那一轮（改稿排队接续时用来复核）。 */
	private async latestTurnMatches(sessionId: string, authorization: AuthorizationReference): Promise<boolean> {
		if (authorization.kind !== "revision_instruction") return false;
		const latest = await this.queries.latestUserTurn(sessionId);
		return Boolean(latest && latest.sourceTurnId === authorization.sourceTurnId);
	}

	// ------------------------------------------------------------------ cancel

	/**
	 * 取消只针对本轮：带 attemptId 与三元组校验；成功后释放租约并清 active。
	 * 与 start 一样走去重事务，重复取消返回原回执。
	 */
	async cancel(input: CancelWorkRequest): Promise<WorkResult<{ attemptId: string }>> {
		return this.transaction.run({
			lockKey: `work:${input.workId}`,
			requestId: input.requestId,
			requestDigest: hashText(stableStringify(input)),
			decodeValue: parseCancelPayload,
			action: () => this.cancelExclusive(input),
		});
	}

	private async cancelExclusive(input: CancelWorkRequest): Promise<WorkResult<{ attemptId: string }>> {
		const record = await this.deps.store.getRecord(input.workId);
		if (!record) return workFailure<{ attemptId: string }>("WORK_NOT_FOUND");
		if (record.revision !== input.expectedRevision) return workFailure<{ attemptId: string }>("REVISION_CONFLICT", undefined, record.revision);
		const operation = record.activeRequestId ? await this.deps.store.getOperation(record.workId, record.activeRequestId) : undefined;
		if (!operation || operation.attemptId !== input.attemptId) return workFailure<{ attemptId: string }>("CANCEL_NOT_APPLICABLE");
		if (!sameRuntimeTriple(operation.runtime, input.expectedRuntime)) return workFailure<{ attemptId: string }>("RUNTIME_CHANGED");
		const abort = await this.deps.runtime.abort({ sessionId: record.sessionId, requestId: `abort_${operation.requestId}`, expectedRuntime: input.expectedRuntime });
		if (!abort.accepted) return workFailure<{ attemptId: string }>("CANCEL_NOT_APPLICABLE", abort.error);
		this.attempts.markCancelled(record.workId);
		const cancelled: DocumentWorkOperation = { ...operation, phase: "interrupted", error: workErrorFor("IO_ERROR", "cancelled"), updatedAt: Date.now() };
		await this.deps.store.saveOperation(cancelled);
		const cleared = await this.deps.store.mutateRecord(record.workId, record.revision, (current) => ({ ...current, activeRequestId: undefined }));
		// 明确取消是解除排他租约的两种途径之一（另一种是 runtime 换代）。
		await this.leases.release(record.sessionId, operation.requestId);
		if (cleared.ok) this.emit(cleared.value, "cancelled", operation.attemptId);
		return workSuccess({ attemptId: operation.attemptId });
	}

	// ------------------------------------------------------------------ revision / recovery / lifecycle

	/**
	 * 普通聊天里的明确改稿：主进程自己读「真实用户当前轮」判断，不需要用户先切模式。
	 *
	 * 保守策略：只有既出现改稿动词又指名要改的块、且没有「别改先解释」类语境时才接续；
	 * 已消费过的轮（含崩溃前已开始的）不再自动执行，避免重新挂载后重复跑历史消息。
	 */
	async autoRevise(sessionId: string, requestId: string): Promise<WorkResult<{ engaged: boolean }>> {
		const views = await this.queries.listForSession(sessionId);
		const work = views[0];
		if (!work) return workSuccess({ engaged: false });
		const turn = await this.queries.latestUserTurn(sessionId);
		if (!turn) return workSuccess({ engaged: false });
		if (!work.versions.some((version) => version.inspection === "passed")) return workSuccess({ engaged: false });
		if (!isExplicitRevisionRequest(turn.text)) return workSuccess({ engaged: false });
		const record = await this.deps.store.getRecord(work.workId);
		if (!record) return workSuccess({ engaged: false });
		if (record.consumedRevisionTurnIds.includes(turn.sourceTurnId)) return workSuccess({ engaged: false });
		if (record.activeRequestId) {
			const active = await this.deps.store.getOperation(record.workId, record.activeRequestId);
			if (active && active.phase !== "archived" && active.phase !== "failed" && active.phase !== "interrupted") return workSuccess({ engaged: false });
		}
		const prepared = await this.prepare({
			requestId: `${requestId}_p`,
			workId: work.workId,
			expectedRevision: work.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: turn.sourceTurnId, sourceTurnHash: turn.hash },
			scope: { summary: turn.text, sections: [], preserve: [], allow: revisionScopeHints(turn.text) },
			materialPaths: [],
		});
		if (!prepared.ok) return workFailure<{ engaged: boolean }>(prepared.error.code, prepared.error.detail);
		const runtime = await this.deps.runtime.snapshot(sessionId);
		if (!runtime) return workFailure<{ engaged: boolean }>("RUNTIME_CHANGED");
		const started = await this.start({
			requestId: `${requestId}_s`,
			workId: work.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: runtime.target,
			authorization: { kind: "revision_instruction", sourceTurnId: turn.sourceTurnId, sourceTurnHash: turn.hash },
		});
		return started.ok ? workSuccess({ engaged: true }) : workFailure<{ engaged: boolean }>(started.error.code, started.error.detail);
	}

	/** 退出路径：先标记取消，再等所有结算协程收敛。 */
	beginShutdown(): void {
		this.attempts.beginShutdown();
	}

	async drain(): Promise<void> {
		await this.attempts.drain();
	}

	/**
	 * 进程重启后的结算。
	 *
	 * 两条规则：
	 * - 分发结果**未知**的尝试保持原状并继续持有租约：不自动重放，也不开放新请求
	 *   （包括同一 runtime 上的另一件工作），等用户明确取消或 runtime 换代；
	 * - 其余进行中的尝试（旧进程已经不在了）转 `interrupted`，并只清理**匹配自己**的
	 *   租约与 active，不误放别人的 attempt。
	 */
	async recoverOnStartup(): Promise<void> {
		const validLeases = await this.leases.reconcileOnStartup((sessionId) => {
			const cached = this.deps.runtime.cached(sessionId);
			return cached ? { target: cached.target } : undefined;
		});
		const leasedRequestIds = new Set(validLeases.map((lease) => `${lease.workId}:${lease.requestId}`));
		for (const record of await this.deps.store.listAllRecords()) {
			for (const requestId of record.operationRequestIds) {
				const operation = await this.deps.store.getOperation(record.workId, requestId);
				if (!operation) continue;
				// 未知分发的尝试保持保守阻塞：不结算、不释放、也不清 active。
				if (operation.dispatchUnknown || operation.phase === "unknown") continue;
				// 仍持有租约且不是未知状态的尝试：等它自己的结算协程处理，不抢跑。
				if (leasedRequestIds.has(`${record.workId}:${requestId}`) && operation.phase !== "dispatching" && operation.phase !== "running" && operation.phase !== "inspecting") continue;
				const recovered = await this.deps.store.recoverInterruptedOperation(operation);
				if (recovered === operation) continue;
				if (record.activeRequestId === requestId) {
					const current = await this.deps.store.getRecord(record.workId);
					if (current) await this.deps.store.mutateRecord(current.workId, current.revision, (value) => ({ ...value, activeRequestId: undefined }));
				}
				// 只清匹配这一次尝试的租约。
				await this.leases.release(operation.runtime.sessionId, operation.requestId);
				const refreshed = await this.deps.store.getRecord(record.workId);
				if (refreshed) this.emit(refreshed, "interrupted", operation.attemptId);
			}
		}
	}
}

export { hashTurnText, isPathInsideAnyRoot };
export type { MaterialResolver, RequirementsReference };
