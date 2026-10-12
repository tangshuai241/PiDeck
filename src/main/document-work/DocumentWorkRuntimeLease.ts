/**
 * TPA 独立文稿：同一运行时上的排他租约。
 *
 * 为什么需要：按 workId 的互斥只保证"同一件工作的准备/分发串行"，挡不住
 * **两件不同的工作在同一个运行时上同时看到 idle**——两边都会通过 `runtimeFlags`
 * 与 `activeOperationId` 检查，然后各发一次绑定，互相覆盖绑定再各跑一个回合。
 *
 * 租约以运行时身份（sessionId + agentId + generation + 原生会话 id）为键，覆盖
 * "占用 → 绑定 → 实际运行 → 权威结算"整段：结算（含 failed/interrupted/unknown）
 * 才释放。未知分发不会因此变得可重放——重放保护来自 requestId 台账与操作终态，
 * 租约只负责"同时只有一件工作在使用这个运行时"。
 *
 * 锁顺序固定：**先** 拿按 workId 的互斥（`KeyedMutex`），**再** 拿运行时租约。
 * 租约是纯同步的 Map 操作，不 await，因此不会与互斥形成环。
 *
 * 租约只作用于文稿域的受控入口，不影响用户在普通聊天/Plan 里的正常模型任务。
 */
import type { DocumentWorkRuntimeTarget } from "./DocumentWorkRuntimeAdapter";

export type RuntimeLeaseHolder = { workId: string; attemptId: string; acquiredAt: number };

/** 运行时的稳定标识：换绑（agentId/世代/原生会话变化）自然换键。 */
export function runtimeLeaseKey(target: DocumentWorkRuntimeTarget): string {
	return [target.sessionId, target.agentId, String(target.runtimeGeneration), target.piSessionId ?? "(no-native)"].join("\u0000");
}

export class DocumentWorkRuntimeLease {
	private readonly held = new Map<string, RuntimeLeaseHolder>();
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? (() => Date.now());
	}

	/** 申请租约；已被**另一件**工作持有时返回失败（调用方转 RUNTIME_BUSY）。 */
	acquire(input: { target: DocumentWorkRuntimeTarget; workId: string; attemptId: string }): { ok: true } | { ok: false; holder: RuntimeLeaseHolder } {
		const key = runtimeLeaseKey(input.target);
		const holder = this.held.get(key);
		// 同一 attempt 重复申请是幂等的（重试路径不会把自己挡在外面）。
		if (holder && holder.attemptId !== input.attemptId) return { ok: false, holder };
		this.held.set(key, { workId: input.workId, attemptId: input.attemptId, acquiredAt: holder?.acquiredAt ?? this.now() });
		return { ok: true };
	}

	/** 释放：只释放自己持有的那一份（按 attemptId 配对，不会误放别人的租约）。 */
	release(input: { target: DocumentWorkRuntimeTarget; attemptId: string }): boolean {
		const key = runtimeLeaseKey(input.target);
		const holder = this.held.get(key);
		if (!holder || holder.attemptId !== input.attemptId) return false;
		this.held.delete(key);
		return true;
	}

	/** 按工作释放（取消/清理路径；对该工作占用的所有运行时都释放）。 */
	releaseWork(workId: string): number {
		let released = 0;
		for (const [key, holder] of [...this.held]) {
			if (holder.workId !== workId) continue;
			this.held.delete(key);
			released++;
		}
		return released;
	}

	/** 退出清理：释放全部租约。 */
	releaseAll(): void {
		this.held.clear();
	}

	holder(target: DocumentWorkRuntimeTarget): RuntimeLeaseHolder | undefined {
		return this.held.get(runtimeLeaseKey(target));
	}

	/** 直接暴露持有者映射的只读快照（诊断/测试）。 */
	snapshot(): Record<string, RuntimeLeaseHolder> {
		return Object.fromEntries([...this.held]);
	}
}
