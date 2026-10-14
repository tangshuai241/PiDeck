/**
 * 待办队列发送器（P02）：把耐久入队的操作发到云端，并把确认结果写回缓存/台账。
 *
 * 规则（与 wire contract 对齐）：
 * - 同事项串行：按 itemId 取队首，队首未消解（conflict/error/未知未判定）时整组跳过，其它事项照常；
 * - 结果未知（offline / 无结构化 body 的 5xx）先查 `GET /requests/:requestId`：applied 直接确认，
 *   pending 保持等待，404 才用同一 requestId（create 另带同一 client_ref）安全重发；绝不新生成 requestId 盲创建；
 * - CAS 冲突保留草稿与云端版本（conflict 阶段 + cloudRevision），不静默覆盖；
 * - 云端未启用写入（NOT_ENABLED / TASK_DOMAIN_BARRIER）只留稿：操作退回 pending，界面显示未切换；
 * - 退避有界（5s→120s 上限），队列空或没有可发操作时不停留定时器；dispose 后不再发任何请求。
 *
 * 本模块不做账号发现、不做入参校验、不写 IPC；那些在 Service 与 IPC 层。
 */

import { clearTimeout, setTimeout } from "node:timers";
import type { PersonalTodoChangedReason, PersonalTodoErrorInfo } from "../../shared/types/personalTodo";
import type { CloudMemoryAuthLease } from "../cloudMemory/cloudMemoryAuthSeam";
import { hasQueuedOperations, nextBackoffMs, pickEligibleOperation, remapQueuedChain, updateOperation, upsertItem } from "./personalTodoQueue";
import { transportFailureToError, writeFailedError, type PersonalTodoAccountRuntime } from "./personalTodoRuntime";
import { appendLedgerEntry, type PersonalTodoCacheFile, type PersonalTodoOutboxPhase, type PersonalTodoQueuedOperation } from "./personalTodoStore";
import { buildMutateBody, type WireMutateSuccess } from "./personalTodoWire";
import type { PersonalTodoTransport } from "./personalTodoTransport";

const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 120_000;

export type PersonalTodoAcquireResult = { ok: true; lease: CloudMemoryAuthLease } | { ok: false; stale: boolean; error: PersonalTodoErrorInfo };

export type PersonalTodoQueueRunnerDeps = {
	transport: PersonalTodoTransport;
	getRuntime: () => PersonalTodoAccountRuntime | null;
	getGeneration: () => number;
	isDisposed: () => boolean;
	acquire: (runtime: PersonalTodoAccountRuntime) => Promise<PersonalTodoAcquireResult>;
	persistCache: (runtime: PersonalTodoAccountRuntime, cache: PersonalTodoCacheFile) => Promise<boolean>;
	noteLocalItemWrite: (runtime: PersonalTodoAccountRuntime, itemId: string) => void;
	emit: (runtime: PersonalTodoAccountRuntime, reason: PersonalTodoChangedReason, itemIds: string[], reload: boolean, identityRemap?: { from: string; to: string }[]) => void;
	/** 身份在发送途中切换：调用方负责切作用域并重新装载（本模块不碰账号）。 */
	onIdentityStale: (runtime: PersonalTodoAccountRuntime) => void;
	/** 状态写锁（与 Service 的 submit/retry 共用一条串行链）：发送器不得与用户提交交错覆盖 outbox 快照。 */
	serialize: <T>(task: () => Promise<T>) => Promise<T>;
	/** 某个本地文件成功写回：调用方据此清除装载时的损坏告警。 */
	onStoreWritten: (runtime: PersonalTodoAccountRuntime, file: "outbox" | "ledger") => void;
	log: (message: string, details?: Record<string, unknown>) => void;
	nowIso: () => string;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
};

type PumpOutcome = "progress" | "stop" | "stale";

export class PersonalTodoQueueRunner {
	private readonly deps: PersonalTodoQueueRunnerDeps;
	private pumping = false;
	private retryTimer: NodeJS.Timeout | null = null;
	private backoffMs = 0;

	constructor(deps: PersonalTodoQueueRunnerDeps) {
		this.deps = deps;
	}

	/** 有可发操作时启动发送循环（幂等；在飞时不重复启动）。 */
	kick(): void {
		if (this.deps.isDisposed() || this.pumping) return;
		const runtime = this.deps.getRuntime();
		if (!runtime || !hasQueuedOperations(runtime.outbox.operations)) return;
		void this.runPump();
	}

	/** 用户显式重试：立刻尝试并重置退避。 */
	resetBackoff(): void {
		this.backoffMs = 0;
		this.clearRetryTimer();
	}

	/** 退出清理：停定时器；在飞请求的结果由调用方的 generation 判定作废。 */
	dispose(): void {
		this.clearRetryTimer();
	}

	private async runPump(): Promise<void> {
		if (this.pumping || this.deps.isDisposed()) return;
		this.pumping = true;
		let progressed = false;
		try {
			for (;;) {
				if (this.deps.isDisposed()) return;
				const runtime = this.deps.getRuntime();
				if (!runtime) return;
				const operation = pickEligibleOperation(runtime.outbox.operations);
				if (!operation) return;
				const outcome = await this.processOperation(runtime, operation, this.deps.getGeneration());
				if (outcome !== "progress") {
					if (outcome === "stop") this.scheduleRetry();
					return;
				}
				progressed = true;
			}
		} catch (error) {
			this.deps.log("personal todo pump failed", { message: error instanceof Error ? error.message : String(error) });
			this.scheduleRetry();
		} finally {
			this.pumping = false;
			if (progressed) this.resetBackoff();
		}
	}

	private async processOperation(runtime: PersonalTodoAccountRuntime, operation: PersonalTodoQueuedOperation, generation: number): Promise<PumpOutcome> {
		const sendingPatch = { phase: "sending" as PersonalTodoOutboxPhase, attempts: operation.attempts + 1, lastAttemptAt: this.deps.nowIso() };
		if (!(await this.markOperation(runtime, operation.opId, sendingPatch))) return "stop";
		const sending = runtime.outbox.operations.find((entry) => entry.opId === operation.opId);
		if (!sending || sending.phase !== "sending") return "progress";
		const acquired = await this.deps.acquire(runtime);
		if (this.isStale(runtime, generation)) return "stale";
		if (!acquired.ok) {
			await this.markOperation(runtime, operation.opId, { phase: operation.phase, lastError: acquired.error, lastAttemptAt: operation.lastAttemptAt });
			runtime.lastError = acquired.error;
			if (acquired.stale) {
				this.deps.onIdentityStale(runtime);
				return "stale";
			}
			return "stop";
		}
		if (operation.phase === "unknown") {
			const receipt = await this.deps.transport.receipt({ lease: acquired.lease, requestId: operation.requestId, operation: operation.operation.kind });
			if (this.isStale(runtime, generation)) return "stale";
			if (!receipt.ok) {
				const notFound = receipt.failure.httpStatus === 404 || receipt.failure.wireCode === "REQUEST_NOT_FOUND";
				if (!notFound) {
					await this.markOperation(runtime, operation.opId, { phase: "unknown", lastError: transportFailureToError(receipt.failure) });
					return "stop";
				}
				// 服务端没有该请求：下面用同一 requestId（create 另带同一 client_ref）安全重发
			} else if (receipt.value.state === "pending") {
				await this.markOperation(runtime, operation.opId, { phase: "unknown", lastError: { code: "unknownOutcome", message: "云端仍在处理该请求" } });
				return "stop";
			} else if (receipt.value.state === "applied") {
				// 回执恢复：整族 revision 只能拿耐久回执记录的 post-op 值作证据（见 applyConfirmed）
				const applied = await this.applyConfirmed(runtime, sending, acquired.lease, receipt.value.result, { itemId: receipt.value.itemId, subId: receipt.value.subId, rootRevisionAfter: receipt.value.rootRevisionAfter });
				if (!applied) return "stop";
				// 本地 id → 服务端 id 的映射随事件下发，渲染层据此迁移占位/选中/草稿
				this.deps.emit(runtime, "queue", [applied.to], false, applied.identityRemap);
				return "progress";
			} else {
				await this.markOperation(runtime, operation.opId, { phase: "unknown", lastError: { code: "unknownOutcome", message: "无法证明云端结果，请稍后重试" } });
				return "stop";
			}
		}
		const result = await this.deps.transport.mutate({ lease: acquired.lease, body: buildMutateBody(sending.operation, sending.requestId, sending.clientRef) });
		if (this.isStale(runtime, generation)) return "stale";
		if (result.ok) {
			// 直接 ACK：响应里的整族 revision 就在本次提交的同一次原子写里，可作重基线证据
			const applied = await this.applyConfirmed(runtime, sending, acquired.lease, result.value, null);
			if (!applied) return "stop";
			this.deps.emit(runtime, "queue", [applied.to], false, applied.identityRemap);
			return "progress";
		}
		const failure = result.failure;
		if (failure.code === "conflict") {
			runtime.write = { available: true, reason: null, verified: runtime.write.verified };
			await this.markOperation(runtime, operation.opId, { phase: "conflict", conflictRevision: failure.conflictCurrent, lastError: transportFailureToError(failure) });
			// 面板要并列「我的草稿 vs 云端版本」：尽力刷新该条，让 confirmed 是云端真内容（失败不影响冲突留稿）
			await this.refreshConflictedItem(runtime, sending.itemId, acquired.lease, generation);
			this.deps.emit(runtime, "conflict", [sending.itemId], false);
			return "progress";
		}
		if (failure.code === "cloudRejected" || failure.code === "invalidInput" || failure.code === "internalError") {
			await this.markOperation(runtime, operation.opId, { phase: "error", lastError: transportFailureToError(failure) });
			this.deps.emit(runtime, "error", [sending.itemId], false);
			return "progress";
		}
		if (failure.code === "writeUnavailable") {
			runtime.write = { available: false, reason: failure.wireCode ?? "NOT_ENABLED", verified: true };
			await this.markOperation(runtime, operation.opId, { phase: "pending", lastError: transportFailureToError(failure) });
			this.deps.emit(runtime, "error", [sending.itemId], false);
			return "stop";
		}
		// offline / unknownOutcome：请求可能已生效 → unknown，下次先查回执再决定
		await this.markOperation(runtime, operation.opId, { phase: "unknown", lastError: transportFailureToError(failure) });
		this.deps.emit(runtime, "error", [sending.itemId], false);
		return "stop";
	}

	private async markOperation(runtime: PersonalTodoAccountRuntime, opId: string, patch: Partial<PersonalTodoQueuedOperation>): Promise<boolean> {
		return this.deps.serialize(async () => {
			const operations = updateOperation(runtime.outbox.operations, opId, { ...patch, updatedAt: this.deps.nowIso() });
			const saved = await runtime.store.saveOutbox({ operations });
			if (!saved.ok) {
				runtime.lastError = writeFailedError("待传队列写入失败");
				return false;
			}
			runtime.outbox = { operations };
			this.deps.onStoreWritten(runtime, "outbox");
			return true;
		});
	}

	/**
	 * 云端确认：清队列（移入台账）、刷新缓存、重映射同链后续操作；确认后 UI 才能显示已保存。
	 *
	 * `receipt` 为 null 表示直接 ACK（提交与响应同一次原子写，整族 revision 即 post-op）；
	 * 非 null 是回执恢复路径，其中：
	 * - `rootRevisionAfter` 是耐久回执里的 post-op 证据：只有它与当前云端整族 revision 相等，
	 *   才证明「本机这次写之后无人再写」，才允许把后续操作重基线；否则一律保留原基准，
	 *   让云端 409 把冲突交给用户（绝不用当前 root revision 跳过别人的写）；
	 * - `itemId`/`subId` 是服务端已证实的身份：用于定位整族根项，并在响应缺 `changed` 时
	 *   作为子项 id 重映射的回退依据（不猜 id）。
	 *
	 * 若确认把本地 id 换成服务端 id（未确认 create），返回旧→新身份映射，由调用方随事件下发：
	 * 渲染层据此丢掉占位行并把选中与未提交草稿迁到新 id（否则会留下同标题幽灵行，
	 * 后续编辑携带空 revision 被拒）。
	 */
	private async applyConfirmed(
		runtime: PersonalTodoAccountRuntime,
		operation: PersonalTodoQueuedOperation,
		lease: CloudMemoryAuthLease,
		success: WireMutateSuccess | null,
		receipt: { itemId: string | null; subId: string | null; rootRevisionAfter: string | null } | null,
	): Promise<{ to: string; identityRemap: { from: string; to: string }[] | undefined } | null> {
		const receiptItemId = receipt?.itemId ?? null;
		const receiptSubId = receipt?.subId ?? null;
		const evidence = receipt ? { rootRevisionAfter: receipt.rootRevisionAfter } : null;
		const newItemId = await this.deps.serialize(async () => {
			const root = await this.resolveConfirmedRoot(runtime, operation, lease, success, receiptItemId);
			if (!root) return null;
			const oldItemId = operation.itemId;
			const items = upsertItem(
				runtime.cache.items.filter((item) => item.id !== oldItemId),
				root,
			);
			await this.deps.persistCache(runtime, { ...runtime.cache, items });
			this.deps.noteLocalItemWrite(runtime, root.id);
			runtime.write = { available: true, reason: null, verified: true };
			let operations = runtime.outbox.operations.filter((entry) => entry.opId !== operation.opId);
			const changed = this.resolveChangedTarget(operation, success, receiptSubId);
			const subtodoRemap = operation.operation.kind === "subtodoAdd" && operation.localSubtodoId && changed.id ? { localId: operation.localSubtodoId, serverId: changed.id } : null;
			const provenRevision = evidence === null ? root.revision : evidence.rootRevisionAfter !== null && evidence.rootRevisionAfter === root.revision ? root.revision : null;
			if (provenRevision === null && evidence !== null) this.deps.log("personal todo receipt lacks rebase evidence", { itemId: root.id, requestId: operation.requestId, rootRevisionAfter: evidence.rootRevisionAfter, currentRevision: root.revision });
			operations = remapQueuedChain(operations, { oldItemId, newItemId: root.id, revision: provenRevision, subtodoRemap, conflictRevision: root.revision });
			const savedOutbox = await runtime.store.saveOutbox({ operations });
			if (savedOutbox.ok) {
				runtime.outbox = { operations };
				this.deps.onStoreWritten(runtime, "outbox");
			} else runtime.lastError = writeFailedError("待传队列写入失败");
			const entries = appendLedgerEntry(runtime.ledger.entries, { requestId: operation.requestId, itemId: root.id, kind: operation.operation.kind, revision: root.revision, confirmedAt: this.deps.nowIso() });
			const savedLedger = await runtime.store.saveLedger({ entries });
			if (savedLedger.ok) {
				runtime.ledger = { entries };
				this.deps.onStoreWritten(runtime, "ledger");
			} else runtime.lastError = writeFailedError("已确认台账写入失败");
			// 本地 id 被服务端 id 替换时给出明确映射（不靠标题猜）
			return { to: root.id, identityRemap: oldItemId === root.id ? undefined : [{ from: oldItemId, to: root.id }] };
		});
		if (!newItemId) return null;
		return newItemId;
	}

	/**
	 * 确认结果的变更身份：契约 `changed:{kind,id,parent_id,parent_subtodo_id}` 优先；
	 * 旧响应没有该对象时，从已证实字段推导（子项操作的响应 item 就是该子项，不会把本地 sub_id 当身份）。
	 */
	private resolveChangedTarget(operation: PersonalTodoQueuedOperation, success: WireMutateSuccess | null, receiptSubId: string | null): { id: string | null; kind: string | null } {
		const kind = operation.operation.kind;
		const isSubtodoOperation = kind === "subtodoAdd" || kind === "subtodoPatch" || kind === "subtodoStatus";
		if (!success) return isSubtodoOperation && receiptSubId ? { id: receiptSubId, kind } : { id: null, kind: null };
		if (success.changedId) return { id: success.changedId, kind: success.changedKind ?? kind };
		if (isSubtodoOperation) {
			// 旧响应无 changed：响应 item 是子项时用它；再退回回执里服务端已证实的 sub_id（都不猜）
			if (success.item.parentId !== null) return { id: success.item.id, kind };
			if (receiptSubId) return { id: receiptSubId, kind };
			return { id: null, kind: null };
		}
		if (success.item.isRoot) return { id: success.item.id, kind };
		return { id: null, kind: null };
	}

	/** 确认响应解析：优先整族 root；只有子项/无结果时按 id 拉取整族。 */
	private async resolveConfirmedRoot(runtime: PersonalTodoAccountRuntime, operation: PersonalTodoQueuedOperation, lease: CloudMemoryAuthLease, success: WireMutateSuccess | null, receiptItemId: string | null) {
		if (success?.root) return success.root;
		if (success?.item.isRoot) return success.item;
		const rootId = success ? (success.item.parentId ?? receiptItemId ?? operation.itemId) : (receiptItemId ?? operation.itemId);
		const result = await this.deps.transport.get({ lease, id: rootId });
		if (this.deps.isDisposed() || this.deps.getRuntime() !== runtime) return null;
		if (!result.ok) {
			runtime.lastError = transportFailureToError(result.failure);
			return null;
		}
		await this.deps.persistCache(runtime, { ...runtime.cache, items: upsertItem(runtime.cache.items, result.value) });
		this.deps.noteLocalItemWrite(runtime, result.value.id);
		return result.value;
	}

	/** 冲突后刷新该事项的云端快照（best-effort）：拿不到就保留旧缓存；不阻塞、不改队列、不放宽 CAS。 */
	private async refreshConflictedItem(runtime: PersonalTodoAccountRuntime, itemId: string, lease: CloudMemoryAuthLease, generation: number): Promise<void> {
		try {
			const result = await this.deps.transport.get({ lease, id: itemId });
			if (this.isStale(runtime, generation) || !result.ok) return;
			const items = upsertItem(runtime.cache.items, result.value);
			await this.deps.persistCache(runtime, { ...runtime.cache, items });
			this.deps.noteLocalItemWrite(runtime, result.value.id);
		} catch {
			// 刷新失败只影响冲突面板的新鲜度，冲突状态与草稿照常保留
		}
	}

	private isStale(runtime: PersonalTodoAccountRuntime, generation: number): boolean {
		return this.deps.isDisposed() || this.deps.getRuntime() !== runtime || this.deps.getGeneration() !== generation;
	}

	private scheduleRetry(): void {
		if (this.deps.isDisposed() || this.retryTimer) return;
		const base = this.deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
		const max = this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;
		this.backoffMs = nextBackoffMs(this.backoffMs, base, max);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.kick();
		}, this.backoffMs);
		this.retryTimer.unref?.();
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}
