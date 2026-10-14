/**
 * 原生 RPC 状态的作用域适配（domain owner）。
 *
 * 投影策略（分槽、绑定、去重、新鲜度）全在 `cloudMemoryStatusProjection` 纯策略里；
 * 这里只解决「当前连接是谁」：只有当前账号 + 云实例的条目才进聚合，换账号/登出即清空。
 * 宿主与 Pi 之间仍只有 stdio JSON-RPC —— 本模块不读队列文件、扩展日志或 GUI 桥。
 */

import type { CloudMemoryNativeSummary } from "../../shared/types/cloudMemory";
import { CloudMemoryStatusProjection, type RuntimeBinding } from "./cloudMemoryStatusProjection";

export type CloudMemoryNativeStatusDeps = {
	/** 当前连接作用域；未连接（未启用/未登录）返回 null，此时不接受任何状态。 */
	getScope: () => { account: string; cloudInstanceId: string } | null;
	now?: () => number;
};

export class CloudMemoryNativeStatus {
	private readonly projection = new CloudMemoryStatusProjection();

	constructor(private readonly deps: CloudMemoryNativeStatusDeps) {}

	/** 消费一条 Pi 原生状态消息；作用域不符或身份不符一律拒绝。 */
	ingest(binding: RuntimeBinding, payload: unknown): boolean {
		const scope = this.deps.getScope();
		if (!scope) return false;
		return this.projection.accept(binding, payload, scope);
	}

	/** 进程停止/被替换：整槽移除该 agent 的状态。 */
	forget(agentId: string): void {
		this.projection.remove(agentId);
	}

	/** 换账号/换实例/登出：清空全部状态。 */
	clear(): void {
		this.projection.clear();
	}

	/** 当前作用域的聚合摘要；没有新鲜状态或未连接时返回 null（未知 != 0）。 */
	summary(): CloudMemoryNativeSummary | null {
		const scope = this.deps.getScope();
		if (!scope) return null;
		const snapshot = this.projection.snapshot(scope, (this.deps.now ?? Date.now)());
		if (!snapshot) return null;
		return {
			sessions: snapshot.sessions,
			lastReceiptAt: snapshot.lastReceiptAt,
			personaRevision: snapshot.personaRevision,
			registered: snapshot.registered,
			failed: snapshot.failed,
			lineagePartial: snapshot.lineagePartial,
			needsNewSession: snapshot.needsNewSession,
			pendingCount: snapshot.pendingCount,
			statuses: snapshot.statuses,
			syncStates: snapshot.syncStates,
		};
	}
}
