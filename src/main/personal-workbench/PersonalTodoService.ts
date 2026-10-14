/**
 * 个人待办 Service（P02）：账号作用域、缓存优先读取、耐久入队与云端确认。
 *
 * 职责边界：
 * - 账号来自 cloudMemory 的已连接身份（origin + cloudInstanceId + account），本服务不读凭据文件、
 *   不做登录；换账号/登出即切作用域：旧账号在飞结果按 runtime/generation 判定作废，缓存与队列留在旧账号目录；
 * - 写入先耐久入队（outbox 原子写），再由 `personalTodoRunner` 后台发送；只有云端确认才把草稿从队列
 *   移入台账，UI 永远能区分「待云端确认」与「已保存」；
 * - 读取缓存优先：list 立即返回本地窗口（含本地草稿），后台刷新完成后经 onChanged 推送变化。
 *
 * 不做什么：不调用模型、不新增轮询 Agent（只有队列非空时的有界退避定时器）、不把令牌写日志或回传渲染层、
 * 不把本地缓存当第二份主账（缓存只存云端确认记录）。
 */

import type {
	PersonalTodo,
	PersonalTodoChangedEvent,
	PersonalTodoChangedReason,
	PersonalTodoErrorInfo,
	PersonalTodoGetResult,
	PersonalTodoListResult,
	PersonalTodoQuery,
	PersonalTodoResolveConflictInput,
	PersonalTodoResolveConflictResult,
	PersonalTodoRetryInput,
	PersonalTodoRetryResult,
	PersonalTodoStatusResult,
	PersonalTodoStatusView,
	PersonalTodoSubmitInput,
	PersonalTodoSubmitResult,
	PersonalTodoView,
} from "../../shared/types/personalTodo";
import type { CloudMemoryAuthLease, CloudMemoryAuthPort, CloudMemoryAuthSnapshot } from "../cloudMemory/cloudMemoryAuthSeam";
import { sameCloudMemoryAuthIdentity } from "../cloudMemory/cloudMemoryAuthSeam";
import { personalTodoAccountKey, resolvePersonalTodoPaths } from "./personalTodoAccount";
import { buildViews, createClientRef, createLocalSubtodoId, createLocalTodoId, createRequestId, filterViews, projectOperations, summarize, syncStateOf } from "./personalTodoProjection";
import { diffItemIds, hasQueuedOperations, headOperationForItem, mergePageItems, normalizeLoadedOperations, operationsForItem, removeOperationsForItem, updateOperation, upsertItem, withBaseRevision } from "./personalTodoQueue";
import { clampLimit, conflictError, cloudRejected, emptySummary, emptyWriteStatus, internalError, invalidInput, mapAuthError, notConnectedError, staleAccountError, transportFailureToError, writeFailedError, type PersonalTodoAccountRuntime } from "./personalTodoRuntime";
import { PersonalTodoQueueRunner, type PersonalTodoAcquireResult } from "./personalTodoRunner";
import { PersonalTodoAccountStore, type PersonalTodoCacheFile, type PersonalTodoQueuedOperation, type PersonalTodoStoreIssue } from "./personalTodoStore";
import type { PersonalTodoTransport, PersonalTodoTransportFailure } from "./personalTodoTransport";

const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 120_000;
const DEFAULT_MIN_REFRESH_MS = 3_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** 客户端 id 工厂（测试注入确定性实现）。 */
export type PersonalTodoIdFactory = { requestId(): string; localTodoId(): string; localSubtodoId(): string };

export type PersonalTodoServiceDeps = {
	/** 应用数据目录（userData）；每个账号在其下建独立子目录。 */
	userDataDir: string;
	auth: CloudMemoryAuthPort;
	transport: PersonalTodoTransport;
	now?: () => Date;
	log?: (message: string, details?: Record<string, unknown>) => void;
	/** 变化推送（main/index.ts 接 IPC；未注入时只走拉取）。 */
	onChanged?: (event: PersonalTodoChangedEvent) => void;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
	minRefreshIntervalMs?: number;
	ids?: PersonalTodoIdFactory;
};

export class PersonalTodoService {
	private readonly deps: PersonalTodoServiceDeps;
	private readonly ids: PersonalTodoIdFactory;
	private readonly runner: PersonalTodoQueueRunner;
	private active: PersonalTodoAccountRuntime | null = null;
	private runtimeLoad: { key: string; promise: Promise<PersonalTodoAccountRuntime | null> } | null = null;
	private generation = 0;
	private disposed = false;
	private refreshInFlight = false;
	/** 状态写锁：outbox/cache/ledger 的「读—改—写」在同一串行链上，避免并发 submit 与发送器互相覆盖快照。 */
	private writeChain: Promise<unknown> = Promise.resolve();

	constructor(deps: PersonalTodoServiceDeps) {
		this.deps = deps;
		this.ids = deps.ids ?? { requestId: createRequestId, localTodoId: createLocalTodoId, localSubtodoId: createLocalSubtodoId };
		this.runner = new PersonalTodoQueueRunner({
			transport: deps.transport,
			getRuntime: () => this.active,
			getGeneration: () => this.generation,
			isDisposed: () => this.disposed,
			acquire: (runtime) => this.acquire(runtime),
			persistCache: (runtime, cache) => this.persistCache(runtime, cache),
			noteLocalItemWrite: (runtime, itemId) => this.noteLocalItemWrite(runtime, itemId),
			emit: (runtime, reason, itemIds, reload, identityRemap) => this.emit(runtime, reason, itemIds, reload, identityRemap),
			onIdentityStale: (runtime) => {
				void this.ensureRuntime().catch(() => undefined);
				this.emit(runtime, "identity", [], true);
			},
			serialize: (task) => this.runSerialized(task),
			onStoreWritten: (runtime, file) => runtime.storeIssues.delete(file),
			log: (message, details) => this.deps.log?.(message, details),
			nowIso: () => this.nowIso(),
			retryBaseDelayMs: deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
			retryMaxDelayMs: deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS,
		});
	}

	/** 云端连接状态变化（连接/登出/换账号）时由装配层调用：只做身份比对，不做写盘。 */
	handleIdentityMayHaveChanged(): void {
		void this.ensureRuntime().catch(() => undefined);
	}

	/** 退出清理：停定时器并让在飞结果作废（不阻塞退出）。 */
	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.runner.dispose();
		this.active = null;
	}

	// ── 公开 API ────────────────────────────────────────────────────────────────

	async getStatus(): Promise<PersonalTodoStatusResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		return { ok: true, status: this.statusOf(runtime) };
	}

	async list(query: PersonalTodoQuery): Promise<PersonalTodoListResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		const order = query.order ?? "created_desc";
		const limit = clampLimit(query.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
		if (query.cursor) {
			const page = await this.refreshPage(runtime, query.cursor, limit, order);
			if (!page.ok) return { ok: false, error: page.error };
			return this.listResult(runtime, filterViews(this.buildAllViews(runtime), query), "cloud");
		}
		if (runtime.cache.items.length === 0) {
			const page = await this.refreshPage(runtime, null, limit, order);
			if (!page.ok) return { ok: false, error: page.error };
			return this.listResult(runtime, filterViews(this.buildAllViews(runtime), query), "cloud");
		}
		this.scheduleRefresh(runtime, limit, order);
		return this.listResult(runtime, filterViews(this.buildAllViews(runtime), query), "cache");
	}

	async get(id: string): Promise<PersonalTodoGetResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		const cached = this.viewOf(runtime, id);
		if (cached) {
			this.scheduleRefresh(runtime, DEFAULT_PAGE_LIMIT, "created_desc");
			return { ok: true, scope: runtime.scope, item: cached, summary: this.summaryOf(runtime), write: runtime.write };
		}
		const fetched = await this.fetchItem(runtime, id);
		if (!fetched) return { ok: false, error: runtime.lastError ?? internalError("读取云端记录失败") };
		const view = this.viewOf(runtime, fetched.id);
		if (!view) return { ok: false, error: internalError("读取云端记录失败") };
		return { ok: true, scope: runtime.scope, item: view, summary: this.summaryOf(runtime), write: runtime.write };
	}

	async submit(input: PersonalTodoSubmitInput): Promise<PersonalTodoSubmitResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		return this.runSerialized(async () => {
			const built = this.buildQueuedOperation(runtime, input);
			if (!built.ok) return built;
			return this.enqueue(runtime, built.operation);
		});
	}

	async retry(input: PersonalTodoRetryInput): Promise<PersonalTodoRetryResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		const outcome = await this.runSerialized(async () => {
			const targets = runtime.outbox.operations.filter((operation) => (input.id ? operation.itemId === input.id : true) && (operation.phase === "unknown" || operation.phase === "error"));
			if (targets.length === 0) return { ok: true as const, retried: 0, itemIds: [] as string[] };
			let operations = runtime.outbox.operations;
			for (const target of targets) operations = updateOperation(operations, target.opId, { phase: "pending", lastError: null, updatedAt: this.nowIso() });
			const saved = await runtime.store.saveOutbox({ operations });
			if (!saved.ok) return { ok: false as const, error: writeFailedError("待传队列写入失败") };
			runtime.outbox = { operations };
			this.noteStoreWritten(runtime, "outbox");
			return { ok: true as const, retried: targets.length, itemIds: [...new Set(targets.map((target) => target.itemId))] };
		});
		if (!outcome.ok) return outcome;
		this.runner.resetBackoff();
		if (outcome.itemIds.length > 0) this.emit(runtime, "queue", outcome.itemIds, false);
		this.runner.kick();
		return { ok: true, summary: this.summaryOf(runtime), write: runtime.write, retried: outcome.retried };
	}

	async resolveConflict(input: PersonalTodoResolveConflictInput): Promise<PersonalTodoResolveConflictResult> {
		const runtime = await this.ensureRuntime();
		if (!runtime) return { ok: false, error: notConnectedError() };
		const outcome = await this.runSerialized(async () => {
			const head = headOperationForItem(runtime.outbox.operations, input.id);
			if (input.choice === "takeCloud") {
				if (head) {
					const operations = removeOperationsForItem(runtime.outbox.operations, input.id);
					const saved = await runtime.store.saveOutbox({ operations });
					if (!saved.ok) return { ok: false as const, error: writeFailedError("待传队列写入失败") };
					runtime.outbox = { operations };
					this.noteStoreWritten(runtime, "outbox");
				}
				return { ok: true as const };
			}
			if (!head) return { ok: false as const, error: invalidInput("该事项没有待处理冲突", "id") };
			const confirmed = runtime.cache.items.find((item) => item.id === input.id) ?? null;
			const revision = head.conflictRevision ?? confirmed?.revision;
			if (!revision) return { ok: false as const, error: conflictError("", "缺少云端最新版本，请先刷新列表") };
			const operations = updateOperation(runtime.outbox.operations, head.opId, { ...withBaseRevision(head, revision), phase: "pending", conflictRevision: null, lastError: null, updatedAt: this.nowIso() });
			const saved = await runtime.store.saveOutbox({ operations });
			if (!saved.ok) return { ok: false as const, error: writeFailedError("待传队列写入失败") };
			runtime.outbox = { operations };
			this.noteStoreWritten(runtime, "outbox");
			return { ok: true as const };
		});
		if (!outcome.ok) return outcome;
		if (input.choice === "takeCloud") {
			void this.refreshItem(runtime, input.id);
		} else {
			this.runner.resetBackoff();
			this.emit(runtime, "queue", [input.id], false);
			this.runner.kick();
		}
		return { ok: true, item: this.viewOf(runtime, input.id), summary: this.summaryOf(runtime) };
	}

	// ── 视图与状态 ──────────────────────────────────────────────────────────────

	private viewOf(runtime: PersonalTodoAccountRuntime, itemId: string): PersonalTodoView | null {
		const confirmed = runtime.cache.items.find((item) => item.id === itemId) ?? null;
		const operations = operationsForItem(runtime.outbox.operations, itemId);
		if (!confirmed && operations.length === 0) return null;
		const views = buildViews({ items: confirmed ? [confirmed] : [], operations });
		return views[0] ?? null;
	}

	private buildAllViews(runtime: PersonalTodoAccountRuntime): PersonalTodoView[] {
		return buildViews({ items: runtime.cache.items, operations: runtime.outbox.operations });
	}

	private summaryOf(runtime: PersonalTodoAccountRuntime) {
		return summarize(runtime.outbox.operations, runtime.ledger.entries);
	}

	private statusOf(runtime: PersonalTodoAccountRuntime): PersonalTodoStatusView {
		return { supported: runtime.supported, scope: runtime.scope, summary: this.summaryOf(runtime), write: runtime.write, lastFetchedAt: runtime.cache.fetchedAt, lastError: runtime.lastError ?? this.storeIssueError(runtime) };
	}

	/** 装载时发现的本地文件损坏：即使没有网络错误也要如实展示（隔离路径可见）。 */
	private storeIssueError(runtime: PersonalTodoAccountRuntime): PersonalTodoErrorInfo | null {
		for (const issue of runtime.storeIssues.values()) {
			return {
				code: "internalError",
				message: issue.message,
				detail: { file: issue.file, blocked: issue.blocked, quarantinePath: issue.quarantinePath ?? "" },
			};
		}
		return null;
	}

	private listResult(runtime: PersonalTodoAccountRuntime, views: PersonalTodoView[], source: "cloud" | "cache"): PersonalTodoListResult {
		return { ok: true, scope: runtime.scope, items: views, nextCursor: runtime.cache.cursor, source, fetchedAt: runtime.cache.fetchedAt, summary: this.summaryOf(runtime), write: runtime.write };
	}

	// ── 运行时装载与账号切换 ─────────────────────────────────────────────────────

	private async ensureRuntime(): Promise<PersonalTodoAccountRuntime | null> {
		const snapshot = this.deps.auth.getSnapshot();
		const key = snapshot ? personalTodoAccountKey(snapshot) : null;
		if (!snapshot || !key) {
			if (this.active) {
				this.active = null;
				this.generation += 1;
				this.runner.dispose();
				this.emit(null, "identity", [], true);
			}
			return null;
		}
		if (this.active && this.active.scope.accountKey === key) {
			this.active.authSnapshot = snapshot;
			return this.active;
		}
		if (this.runtimeLoad && this.runtimeLoad.key === key) return this.runtimeLoad.promise;
		const promise = this.loadRuntime(snapshot, key);
		this.runtimeLoad = { key, promise };
		try {
			return await promise;
		} finally {
			if (this.runtimeLoad && this.runtimeLoad.promise === promise) this.runtimeLoad = null;
		}
	}

	private async loadRuntime(snapshot: CloudMemoryAuthSnapshot, accountKey: string): Promise<PersonalTodoAccountRuntime | null> {
		const generation = ++this.generation;
		const paths = resolvePersonalTodoPaths(this.deps.userDataDir, accountKey);
		const store = new PersonalTodoAccountStore({ paths });
		const [cache, outbox, ledger] = await Promise.all([store.loadCache(), store.loadOutbox(), store.loadLedger()]);
		if (this.disposed || generation !== this.generation) return this.active;
		const storeIssues = new Map<"cache" | "outbox" | "ledger", PersonalTodoStoreIssue>();
		if (cache.issue) storeIssues.set("cache", cache.issue);
		if (outbox.issue) storeIssues.set("outbox", outbox.issue);
		if (ledger.issue) storeIssues.set("ledger", ledger.issue);
		const runtime: PersonalTodoAccountRuntime = {
			scope: { origin: snapshot.origin, account: snapshot.account, cloudInstanceId: snapshot.cloudInstanceId, accountKey },
			authSnapshot: snapshot,
			paths,
			store,
			cache: cache.value,
			outbox: { operations: normalizeLoadedOperations(outbox.value.operations) },
			ledger: ledger.value,
			write: emptyWriteStatus(),
			supported: true,
			lastError: null,
			lastRefreshAttemptAt: 0,
			nextItemWriteSeq: 0,
			itemWriteSeq: new Map(),
			storeIssues,
		};
		this.active = runtime;
		void store.saveIdentity({ origin: snapshot.origin, account: snapshot.account, cloudInstanceId: snapshot.cloudInstanceId }, accountKey);
		this.emit(runtime, "identity", [], true);
		if (hasQueuedOperations(runtime.outbox.operations)) this.runner.kick();
		return runtime;
	}

	// ── 云端读取 ────────────────────────────────────────────────────────────────

	private async acquire(runtime: PersonalTodoAccountRuntime): Promise<PersonalTodoAcquireResult> {
		const current = this.deps.auth.getSnapshot();
		if (!current || !sameCloudMemoryAuthIdentity(current, runtime.authSnapshot)) return { ok: false, stale: true, error: staleAccountError() };
		const result = await this.deps.auth.acquireLease(runtime.authSnapshot);
		if (result.ok) return { ok: true, lease: result.lease };
		return { ok: false, stale: result.stale, error: mapAuthError(result.error) };
	}

	private async persistCache(runtime: PersonalTodoAccountRuntime, cache: PersonalTodoCacheFile): Promise<boolean> {
		const saved = await runtime.store.saveCache(cache);
		runtime.cache = cache;
		if (!saved.ok) {
			runtime.lastError = writeFailedError("本地缓存写入失败");
			return false;
		}
		this.noteStoreWritten(runtime, "cache");
		return true;
	}

	/** 本地写入序号：让并发中的列表快照不能覆盖刚刚确认的记录。 */
	private noteLocalItemWrite(runtime: PersonalTodoAccountRuntime, itemId: string): void {
		runtime.nextItemWriteSeq += 1;
		runtime.itemWriteSeq.set(itemId, runtime.nextItemWriteSeq);
	}

	/** 写入成功后清除该文件的装载损坏告警。 */
	private noteStoreWritten(runtime: PersonalTodoAccountRuntime, file: "cache" | "outbox" | "ledger"): void {
		runtime.storeIssues.delete(file);
	}

	/** 取一页（cursor=null 即刷新第一页）；失败返回结构化错误并记 lastError。 */
	private async refreshPage(runtime: PersonalTodoAccountRuntime, cursor: string | null, limit: number, order: PersonalTodoQuery["order"]): Promise<{ ok: true } | { ok: false; error: PersonalTodoErrorInfo }> {
		runtime.lastRefreshAttemptAt = Date.now();
		const startedWriteSeq = runtime.nextItemWriteSeq;
		const acquired = await this.acquire(runtime);
		if (!acquired.ok) {
			if (acquired.stale) return { ok: true };
			runtime.lastError = acquired.error;
			return { ok: false, error: acquired.error };
		}
		const result = await this.deps.transport.list({ lease: acquired.lease, cursor, limit, order: order ?? "created_desc" });
		if (this.active !== runtime || this.disposed) return { ok: true };
		if (!result.ok) return { ok: false, error: this.recordTransportFailure(runtime, result.failure) };
		const page = result.value;
		const diff = await this.runSerialized(async () => {
			const before = runtime.cache.items;
			const nextCache: PersonalTodoCacheFile = { fetchedAt: this.nowIso(), cursor: page.nextCursor, items: mergePageItems(before, page.items, cursor !== null, (id) => (runtime.itemWriteSeq.get(id) ?? 0) > startedWriteSeq) };
			await this.persistCache(runtime, nextCache);
			runtime.lastError = null;
			runtime.supported = true;
			if (page.writeAvailable !== null) runtime.write = { available: page.writeAvailable, reason: page.writeReason, verified: true };
			return diffItemIds(before, nextCache.items);
		});
		if (diff.changedIds.length > 0 || diff.removed) this.emit(runtime, "cloud", diff.changedIds, diff.removed);
		return { ok: true };
	}

	private scheduleRefresh(runtime: PersonalTodoAccountRuntime, limit: number, order: PersonalTodoQuery["order"]): void {
		if (this.refreshInFlight || this.disposed) return;
		if (Date.now() - runtime.lastRefreshAttemptAt < (this.deps.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_MS)) return;
		this.refreshInFlight = true;
		void this.refreshPage(runtime, null, limit, order)
			.catch(() => undefined)
			.finally(() => {
				this.refreshInFlight = false;
			});
	}

	private async fetchItem(runtime: PersonalTodoAccountRuntime, id: string): Promise<PersonalTodo | null> {
		const acquired = await this.acquire(runtime);
		if (!acquired.ok) {
			runtime.lastError = acquired.error;
			return null;
		}
		const result = await this.deps.transport.get({ lease: acquired.lease, id });
		if (this.active !== runtime || this.disposed) return null;
		if (!result.ok) {
			this.recordTransportFailure(runtime, result.failure);
			return null;
		}
		const nextCache: PersonalTodoCacheFile = { ...runtime.cache, items: upsertItem(runtime.cache.items, result.value) };
		await this.runSerialized(() => this.persistCache(runtime, nextCache));
		this.noteLocalItemWrite(runtime, result.value.id);
		return result.value;
	}

	/** 后台刷新单条（冲突「采用云端」时使用；结果经 onChanged 推送）。 */
	private async refreshItem(runtime: PersonalTodoAccountRuntime, id: string): Promise<void> {
		const item = await this.fetchItem(runtime, id);
		if (item && this.active === runtime && !this.disposed) this.emit(runtime, "cloud", [item.id], false);
	}

	private recordTransportFailure(runtime: PersonalTodoAccountRuntime, failure: PersonalTodoTransportFailure): PersonalTodoErrorInfo {
		if (failure.code === "writeUnavailable" && (failure.httpStatus === 404 || failure.httpStatus === 501 || failure.wireCode === "NOT_ENABLED")) runtime.supported = false;
		const error = failure.code === "writeUnavailable" && !runtime.supported ? { code: "unsupported" as const, message: "云端服务未启用个人待办" } : transportFailureToError(failure);
		runtime.lastError = error;
		return error;
	}

	// ── 本地入队 ────────────────────────────────────────────────────────────────

	private buildQueuedOperation(runtime: PersonalTodoAccountRuntime, input: PersonalTodoSubmitInput): { ok: true; operation: PersonalTodoQueuedOperation } | { ok: false; error: PersonalTodoErrorInfo; item?: PersonalTodoView } {
		const operation = input.operation;
		const now = this.nowIso();
		const base = { phase: "pending" as const, attempts: 0, lastError: null, conflictRevision: null, localSubtodoId: null, createdAt: now, updatedAt: now, lastAttemptAt: null };
		const requestId = input.clientRequestId ?? this.ids.requestId();
		if (operation.kind === "create") {
			const itemId = this.ids.localTodoId();
			return { ok: true, operation: { ...base, opId: requestId, requestId, itemId, operation, clientRef: createClientRef(requestId), baseRevision: null } };
		}
		const confirmed = runtime.cache.items.find((item) => item.id === operation.id) ?? null;
		const queued = operationsForItem(runtime.outbox.operations, operation.id);
		if (!confirmed && queued.length === 0) return { ok: false, error: invalidInput("找不到该事项", "id") };
		// 离线 create 链：只对「本账号正在待传、尚未确认的本地 create」接受本地空基准，
		// 让它后面的编辑/完成/加子项能继续入队；确认后由 send 路径重映射真实 id 与 post-op revision。
		const head = queued[0] ?? null;
		const localCreateChain = Boolean(head && head.operation.kind === "create" && head.baseRevision === null);
		// 非本地 create 链的基准必须是真实 revision；空串只作为「本地未确认」的标记，不会发给云端
		const chainBase = head ? (localCreateChain ? "" : (head.baseRevision ?? "")) : (confirmed?.revision ?? "");
		if (!localCreateChain && chainBase.length === 0) return { ok: false, error: invalidInput("找不到该事项", "id") };
		if (operation.expectedRevision !== chainBase) {
			return { ok: false, error: conflictError(chainBase, "本地版本已变化，请重新打开该事项后再保存"), item: this.viewOf(runtime, operation.id) ?? undefined };
		}
		if (operation.kind === "status" && operation.status === "done") {
			// 父项完成预检用「基线 + 已入队操作」的叠加结果：离线 create 链也要按同一父子规则拦下
			const effective = projectOperations(confirmed, queued);
			if (effective && effective.subtodos.some((subtodo) => subtodo.status === "open")) return { ok: false, error: cloudRejected("存在未完成子待办，不能完成父项", { reason: "SUBTODO_INCOMPLETE" }), item: this.viewOf(runtime, operation.id) ?? undefined };
		}
		const built: PersonalTodoQueuedOperation = { ...base, opId: requestId, requestId, itemId: operation.id, operation, clientRef: null, baseRevision: chainBase };
		if (operation.kind === "subtodoAdd") built.localSubtodoId = this.ids.localSubtodoId();
		return { ok: true, operation: built };
	}

	private async enqueue(runtime: PersonalTodoAccountRuntime, operation: PersonalTodoQueuedOperation): Promise<PersonalTodoSubmitResult> {
		const operations = [...runtime.outbox.operations, operation];
		const saved = await runtime.store.saveOutbox({ operations });
		if (!saved.ok) return { ok: false, error: writeFailedError("待传队列写入失败，本次修改未保存"), item: this.viewOf(runtime, operation.itemId) ?? undefined };
		runtime.outbox = { operations };
		this.noteStoreWritten(runtime, "outbox");
		const view = this.viewOf(runtime, operation.itemId);
		if (!view) return { ok: false, error: internalError("本地草稿构建失败") };
		this.emit(runtime, "queue", [operation.itemId], false);
		this.runner.kick();
		return { ok: true, item: view, summary: this.summaryOf(runtime), write: runtime.write, accepted: true, requestId: operation.requestId };
	}

	// ── 串行链、时间与事件 ───────────────────────────────────────────────────────

	/** 串行链：所有「读—改—写」状态变更都在同一条 promise 链上排队。 */
	private runSerialized<T>(task: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(task, task);
		this.writeChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private nowIso(): string {
		return (this.deps.now?.() ?? new Date()).toISOString();
	}

	private emit(runtime: PersonalTodoAccountRuntime | null, reason: PersonalTodoChangedReason, itemIds: string[], reload: boolean, identityRemap?: { from: string; to: string }[]): void {
		const sink = this.deps.onChanged;
		if (!sink) return;
		const views = runtime ? itemIds.map((itemId) => this.viewOf(runtime, itemId)).filter((view): view is PersonalTodoView => view !== null) : [];
		sink({
			scope: runtime?.scope ?? null,
			reason,
			items: views.slice(0, 50),
			summary: runtime ? this.summaryOf(runtime) : emptySummary(),
			write: runtime?.write ?? emptyWriteStatus(),
			reload: reload || views.length > 50,
			...(identityRemap && identityRemap.length > 0 ? { identityRemap } : {}),
		});
	}
}
