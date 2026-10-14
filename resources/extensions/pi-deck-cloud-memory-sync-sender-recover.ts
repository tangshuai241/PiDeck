/**
 * pi-deck-cloud-memory-sync-sender-recover —— 在途 envelope 恢复：按原 requestId/原集合对账，
 * 不重新组批；本地文件与 envelope 内容不符的条目单条标冲突并保留证据。
 */

import { MAX_CHUNK_RECORD_BYTES } from "./pi-deck-cloud-memory-sync-batch";
import { recoverEnvelopeBatch, type DeliveryDeps, type DeliveryOutcome } from "./pi-deck-cloud-memory-sync-sender-delivery";
import type { SyncOpenBatch, SyncOutboxEntry, SyncQueue } from "./pi-deck-cloud-memory-sync-types";

export async function recoverOpenBatch(deps: { queue: SyncQueue; delivery: DeliveryDeps; alive: () => boolean }, open: SyncOpenBatch): Promise<DeliveryOutcome> {
	const entries: SyncOutboxEntry[] = [];
	let envelopeConflicts = 0;
	for (const item of open.items) {
		if (!deps.alive()) return { kind: "aborted" };
		let entry: SyncOutboxEntry | null;
		try {
			entry = await deps.queue.readEntry(item.sourceId);
		} catch {
			return { kind: "retry", reason: "queue_entry_corrupt" };
		}
		if (entry === null) continue; // 已确认或已不存在
		if (entry.record.contentHash !== item.contentHash) {
			try {
				await deps.queue.markConflict(item.sourceId, "batch_envelope_mismatch");
			} catch {
				// 保留 unknown，下轮再试。
			}
			envelopeConflicts += 1;
			continue;
		}
		entries.push(entry);
	}
	if (entries.length === 0) {
		await deps.queue.clearOpenBatch(open.requestId);
		return { kind: "progress", confirmed: 0, conflicts: envelopeConflicts };
	}
	const outcome = await recoverEnvelopeBatch(deps.delivery, open.requestId, open.mode, entries);
	if (outcome.kind === "progress") return { kind: "progress", confirmed: outcome.confirmed, conflicts: outcome.conflicts + envelopeConflicts };
	return outcome;
}

/** 单条超过 chunk record 上限的条目单独记为 rejected，不丢原件、不重试死循环。 */
export function pickChunkEntry(oversized: Map<string, { bytes: number; entry: SyncOutboxEntry }>, rejected: Map<string, number>, log: (event: string, fields?: Record<string, unknown>) => void): SyncOutboxEntry | null {
	for (const [sourceId, item] of oversized) {
		if (rejected.has(sourceId)) continue;
		if (item.bytes > MAX_CHUNK_RECORD_BYTES) {
			rejected.set(sourceId, item.bytes);
			oversized.delete(sourceId);
			log("sync.send.chunk_rejected", { bytes: item.bytes });
			continue;
		}
		return item.entry;
	}
	return null;
}

/** 已确认/已冲突的长记录从 oversized 视图移除；读取失败保留证据。 */
export async function removeSettledOversized(queue: SyncQueue, oversized: Map<string, { bytes: number; entry: SyncOutboxEntry }>): Promise<void> {
	for (const [sourceId] of oversized) {
		try {
			const entry = await queue.readEntry(sourceId);
			if (entry === null || entry.state === "conflict") oversized.delete(sourceId);
		} catch {
			// 损坏保留证据。
		}
	}
}
