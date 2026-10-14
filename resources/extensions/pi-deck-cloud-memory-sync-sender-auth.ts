/**
 * pi-deck-cloud-memory-sync-sender-auth —— 单 sender 租约与 auth 暂停的窄封装。
 * 租约只有已验证死亡才能接管；释放只认自己的 token；auth 只写 token hash 指纹，不存明文。
 */

import { sha256Hex } from "./pi-deck-cloud-memory-sync-identity";
import type { SyncQueue } from "./pi-deck-cloud-memory-sync-types";
import type { SyncConnectionSnapshot } from "./pi-deck-cloud-memory-sync-sender-types";

export type AuthScope = { accountId: string; cloudInstanceId: string };
export type LeaseHolder = { token: string | null };

export type EndpointResolution = { kind: "ok"; baseUrl: string; token: string } | { kind: "disabled" } | { kind: "scope_mismatch" } | { kind: "noop" };

/** 读配置快照并判定本 tick 能否发送；读失败/未启用按 disabled，不冒充可发送。 */
export async function resolveSendEndpoint(deps: { readConnection: () => Promise<SyncConnectionSnapshot | null>; scope: AuthScope; alive: () => boolean }): Promise<EndpointResolution> {
	const conn = await deps.readConnection();
	if (!deps.alive()) return { kind: "noop" };
	if (!conn || !conn.enabled || !conn.syncEnabled) return { kind: "disabled" };
	if (conn.accountId !== deps.scope.accountId || conn.cloudInstanceId !== deps.scope.cloudInstanceId) return { kind: "scope_mismatch" };
	const baseUrl = conn.baseUrl;
	const token = conn.token;
	if (!baseUrl || !token) return { kind: "disabled" };
	return { kind: "ok", baseUrl, token };
}

/** 指纹绑定 scope，只用于比较；不写日志、不落明文 token。 */
export function tokenFingerprint(scope: AuthScope, token: string): string {
	return sha256Hex(Buffer.from(`${scope.accountId}|${scope.cloudInstanceId}|${token}`, "utf8"));
}

export async function ensureSenderLease(deps: {
	queue: SyncQueue;
	alive: () => boolean;
	holder: LeaseHolder;
	leaseTtlMs: number;
	onOwnerBlocked: (reason: string) => void;
	onError: (reason: string) => void;
}): Promise<boolean> {
	try {
		const existing = deps.holder.token;
		if (existing !== null && (await deps.queue.renewSender(existing, deps.leaseTtlMs))) return true;
		deps.holder.token = null;
		if (!deps.alive()) return false;
		const claim = await deps.queue.claimSender(deps.leaseTtlMs);
		if (claim.status === "claimed") {
			if (!deps.alive()) {
				// stop 发生在 claim await 期间：立即释放刚拿到的租约，不留悬挂锁。
				try {
					await deps.queue.releaseSender(claim.lease.token);
				} catch {
					// 等 TTL/存活校验。
				}
				return false;
			}
			deps.holder.token = claim.lease.token;
			return true;
		}
		if (!deps.alive()) return false;
		deps.onOwnerBlocked(claim.reason);
		return false;
	} catch {
		if (deps.alive()) deps.onError("queue_lease_failed");
		return false;
	}
}

export async function writeAuthBlocked(queue: SyncQueue, scope: AuthScope, token: string): Promise<void> {
	await queue.setAuthBlocked(true, "http_401", tokenFingerprint(scope, token));
}
