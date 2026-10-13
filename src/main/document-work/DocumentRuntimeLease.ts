/**
 * 运行时排他租约：一个 runtime 同时只允许一轮文稿执行。
 *
 * 为什么需要它（评审结论）：只按 work 加锁时，同一 runtime 上的两件工作可以同时
 * bind/派发，得到两次批准；`unknown` 分发之后如果清了 active 就直接放行，下一轮
 * （甚至另一件工作）会再发一次 bind，用户的确认就被花了两次。
 *
 * 原子性：`acquire` 的「读 → 比较 → 写」必须整体串行，否则两件工作会同时读到
 * `missing` 并各自写入，等于没有排他。锁顺序固定为
 * `tx:<workId>`（调用方持有） → `lease:<sessionId>`（本模块） → store 内部锁，
 * 因此同层不会互相等待、也不会出现环。
 *
 * 生命周期：占用 → bind → 执行 → 权威结算。只有两种情形解除：
 * - 明确的终态结算（archived / failed / interrupted / cancelled）；
 * - runtime 换代（agentId / runtimeGeneration / nativeSessionId 任一变化）。
 * `unknown` 不解除：重启或换 work 都不自动开放，等用户明确取消或换 runtime。
 * 租约文件损坏时一律 fail-closed：既不当作 `missing` 放行，也不允许清除。
 */
import { workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import type { DocumentRuntimeLease, SessionRuntimeTriple } from "../../shared/types/documentWork";
import type { DocumentWorkStore } from "./DocumentWorkStore";

export type LeaseAcquireInput = {
	sessionId: string;
	target: SessionRuntimeTriple;
	nativeSessionId?: string;
	workId: string;
	requestId: string;
	attemptId: string;
};

function sameRuntime(lease: DocumentRuntimeLease, target: SessionRuntimeTriple, nativeSessionId: string | undefined): boolean {
	if (lease.agentId !== target.agentId) return false;
	if (lease.runtimeGeneration !== target.runtimeGeneration) return false;
	// 原生会话 id 任一缺失时不把它当作同一 runtime 的证据。
	if (!lease.nativeSessionId || !nativeSessionId) return false;
	return lease.nativeSessionId === nativeSessionId;
}

export class DocumentRuntimeLeaseRegistry {
	/**
	 * `beforeAcquire` 是并发回归测试的注入点：它在**锁内、读之前**触发，
	 * 让两个 acquire 必然交错（生产不传）。刻意不做成默认钩子，避免给生产路径加分支。
	 */
	constructor(
		private readonly store: DocumentWorkStore,
		private readonly beforeAcquire?: () => Promise<void> | void,
	) {}

	/**
	 * 占用运行时。整段「读取 → 比较 → 写入」在 `lease:<sessionId>` 锁内完成：
	 * 同一 runtime 上的两件工作只会有一个成功，另一个拿到 RUNTIME_BUSY。
	 * 同一 attempt 重复占用视为成功（幂等重放不会因为自己持有而被拒）。
	 */
	async acquire(input: LeaseAcquireInput): Promise<WorkResult<DocumentRuntimeLease>> {
		return this.store.runExclusive(`lease:${input.sessionId}`, async () => {
			await this.beforeAcquire?.();
			const state = await this.store.readRuntimeLeaseState(input.sessionId);
			if (state.kind === "corrupt") return workFailure<DocumentRuntimeLease>("RUNTIME_BUSY", "lease_corrupt");
			if (state.kind === "ok") {
				const existing = state.lease;
				if (existing.workId === input.workId && existing.requestId === input.requestId) return workSuccess(existing);
				if (sameRuntime(existing, input.target, input.nativeSessionId)) return workFailure<DocumentRuntimeLease>("RUNTIME_BUSY", "runtime_leased");
				// 换代：旧租约对应的进程已经不在了（身份不同才可能到这里），清掉后再占用。
				await this.store.clearRuntimeLease(input.sessionId);
			}
			const lease: DocumentRuntimeLease = {
				sessionId: input.sessionId,
				agentId: input.target.agentId,
				runtimeGeneration: input.target.runtimeGeneration,
				...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
				workId: input.workId,
				requestId: input.requestId,
				attemptId: input.attemptId,
				acquiredAt: Date.now(),
			};
			await this.store.saveRuntimeLease(lease);
			return workSuccess(lease);
		});
	}

	/**
	 * 只释放自己持有的租约；别人的 attempt 不能被误放。
	 * 租约损坏时拒绝清除（fail-closed），调用方应保持阻塞并提示用户。
	 */
	async release(sessionId: string, requestId: string): Promise<boolean> {
		return this.store.runExclusive(`lease:${sessionId}`, () => this.store.clearRuntimeLease(sessionId, requestId));
	}

	/** 当前是否被别人占着（本 work 的本次请求不算冲突）；损坏时同样视为被占用。 */
	async heldByOther(sessionId: string, workId: string, requestId?: string): Promise<DocumentRuntimeLease | "corrupt" | undefined> {
		const state = await this.store.readRuntimeLeaseState(sessionId);
		if (state.kind === "corrupt") return "corrupt";
		if (state.kind === "missing") return undefined;
		const lease = state.lease;
		if (lease.workId === workId && (requestId === undefined || lease.requestId === requestId)) return undefined;
		return lease;
	}

	/**
	 * 启动恢复：丢掉 runtime 已经换代的租约，其余（含 `unknown` 与损坏文件）保持阻塞。
	 * 返回仍然有效的租约，供调用方把对应操作继续当成未结算处理。
	 */
	async reconcileOnStartup(currentBySession: (sessionId: string) => { target: SessionRuntimeTriple; nativeSessionId?: string } | undefined): Promise<DocumentRuntimeLease[]> {
		const remaining: DocumentRuntimeLease[] = [];
		for (const state of await this.store.listRuntimeLeaseStates()) {
			// 损坏的租约保持阻塞：不自动开放，等用户明确取消或换 runtime。
			if (state.kind === "corrupt") continue;
			const lease = state.lease;
			const current = currentBySession(lease.sessionId);
			if (!current || sameRuntime(lease, current.target, current.nativeSessionId)) {
				remaining.push(lease);
				continue;
			}
			await this.store.runExclusive(`lease:${lease.sessionId}`, () => this.store.clearRuntimeLease(lease.sessionId, lease.requestId));
		}
		return remaining;
	}
}
