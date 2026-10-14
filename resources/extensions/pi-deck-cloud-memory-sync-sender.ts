/**
 * pi-deck-cloud-memory-sync-sender —— N08 发送器公开入口（保持 B 现有 import 路径与 API 兼容）。
 *
 * 实现拆分为：sender-loop（生命周期/调度）、sender-delivery（发送动作/回执）、sender-chunk（长记录）、
 * batch（纯组包策略）、chunk-transport / transport（HTTP）。公开 start/wake/stop/getStatus(deps 不变)。
 */

import { createSenderRuntime } from "./pi-deck-cloud-memory-sync-sender-loop";
import type { SyncSender, SyncSenderDeps } from "./pi-deck-cloud-memory-sync-sender-types";

export type { SyncConnectionSnapshot, SyncSender, SyncSenderDeps, SyncSenderPhase, SyncSenderStatus } from "./pi-deck-cloud-memory-sync-sender-types";

export function createSyncSender(deps: SyncSenderDeps): SyncSender {
	return createSenderRuntime(deps);
}
