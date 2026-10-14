/**
 * pi-deck-cloud-memory-sync-sender-host —— sender 生命周期宿主（start/wake/stop + 状态心跳）。
 *
 * 为什么单列：runtime 只负责「什么时候该发」，本模块负责「sender 怎么起停」：
 * - 同一 scope（profile key + deviceId）只保有一个 sender，queue 由 bridge 复用同一实例；
 * - `ensure` 启动并唤醒（重启也会主动发送旧 pending）；`stop` 与它严格配对：
 *   停 timer（含心跳）、abort 自己在飞 HTTP、按 token 释放租约（由 D 的 sender.stop 完成）；
 * - 连接快照每次 tick 现读（支持 Promise）：失败/绑定不合法 → null → sender 暂停；
 *   `readConnection` 只读文件，绝不调用 ensure/stop（避免递归与死锁）；
 * - 状态去重由上层按内容变化做；这里只提供低频心跳保持 freshness，停止时立即清 timer。
 */

import { clearInterval as clearNodeInterval, setInterval as setNodeInterval } from "node:timers";
import type { CaptureScope } from "./pi-deck-cloud-memory-sync-bridge";
import { createSyncSender, type SyncConnectionSnapshot, type SyncSender, type SyncSenderStatus } from "./pi-deck-cloud-memory-sync-sender";
import type { SyncQueue, SyncScopeInput } from "./pi-deck-cloud-memory-sync-types";

export const DEFAULT_SYNC_HEARTBEAT_MS = 5 * 60_000;

export type SenderStatusMeta = { heartbeat: boolean };

/** 心跳清理句柄：注入接口返回 cleanup closure，避免把手柄类型做强转。 */
export type SenderHeartbeat = { stop: () => void };
export type SenderTimerPort = { every: (handler: () => void, ms: number) => SenderHeartbeat };

const DEFAULT_TIMER_PORT: SenderTimerPort = {
	every(handler, ms) {
		const handle = setNodeInterval(handler, ms);
		return { stop: () => clearNodeInterval(handle) };
	},
};

export type SenderHostPorts = {
	/** 取（并复用）同一 scope 的队列句柄（含 stateDir/sessionId，供 bridge 定位目录）。 */
	queueFor: (scope: CaptureScope) => Promise<SyncQueue>;
	/** 连接快照：每次调用都现读（可为 Promise）；失败/绑定不合法返回 null（sender 暂停）。 */
	readConnection: () => SyncConnectionSnapshot | null | Promise<SyncConnectionSnapshot | null>;
	/** 状态回调：heartbeat=true 是低频保活（上层不得用「内容未变化」把它丢掉）。 */
	onStatus: (status: SyncSenderStatus, meta: SenderStatusMeta) => void;
	/** 测试接缝；默认 D 的 createSyncSender。 */
	createSender?: typeof createSyncSender;
	heartbeatMs?: number;
	/** 测试接缝：默认 node:timers；返回 { stop } 由宿主在 stop 时调用。 */
	timerPort?: SenderTimerPort;
};

export type SenderHost = {
	ensure(input: { key: string; scope: SyncScopeInput; queueScope: CaptureScope }): Promise<"started" | "already_running" | "failed">;
	stop(reason: string): Promise<boolean>;
	wake(): void;
	status(): SyncSenderStatus | null;
	currentScope(): SyncScopeInput | null;
	/** 心跳是否在跑（测试/诊断用）。 */
	heartbeatRunning(): boolean;
};

const DISABLED_CONNECTION: SyncConnectionSnapshot = { enabled: false, syncEnabled: false, baseUrl: null, token: null, accountId: null, cloudInstanceId: null };

export function createSenderHost(ports: SenderHostPorts): SenderHost {
	const heartbeatMs = Math.max(1, ports.heartbeatMs ?? DEFAULT_SYNC_HEARTBEAT_MS);
	const timerPort = ports.timerPort ?? DEFAULT_TIMER_PORT;
	let host: { key: string; sender: SyncSender; scope: SyncScopeInput } | null = null;
	let heartbeat: SenderHeartbeat | null = null;

	function stopHeartbeat(): void {
		if (!heartbeat) return;
		heartbeat.stop();
		heartbeat = null;
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		heartbeat = timerPort.every(() => {
			if (!host) return;
			ports.onStatus(host.sender.getStatus(), { heartbeat: true });
		}, heartbeatMs);
	}

	return {
		async ensure(input) {
			if (host && host.key === input.key) {
				host.sender.wake();
				return "already_running";
			}
			// 换 scope：先停旧的（abort/释放租约/清心跳），绝不把新账号 token 用于旧 scope。
			if (host) await this.stop("scope_changed");
			try {
				const queue = await ports.queueFor(input.queueScope);
				const sender = (ports.createSender ?? createSyncSender)({
					queue,
					scope: input.scope,
					// 每次 tick 现读连接（D 的 sender 支持 Promise 返回）；失败/绑定不合法 → disabled 快照 → 暂停。
					getConnection: async () => (await ports.readConnection()) ?? DISABLED_CONNECTION,
					onStatus: (status) => ports.onStatus(status, { heartbeat: false }),
				});
				host = { key: input.key, sender, scope: input.scope };
				await sender.start();
				startHeartbeat();
				return "started";
			} catch {
				host = null;
				stopHeartbeat();
				return "failed";
			}
		},

		async stop(_reason) {
			const current = host;
			host = null;
			stopHeartbeat();
			if (!current) return false;
			try {
				await current.sender.stop();
				return true;
			} catch {
				return false;
			}
		},

		wake() {
			host?.sender.wake();
		},

		status() {
			return host?.sender.getStatus() ?? null;
		},

		currentScope() {
			return host?.scope ?? null;
		},

		heartbeatRunning() {
			return heartbeat !== null;
		},
	};
}
