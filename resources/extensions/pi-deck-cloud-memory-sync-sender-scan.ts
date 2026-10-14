/**
 * pi-deck-cloud-memory-sync-sender-scan —— 队列候选扫描与 inline 组包（跨 tick 游标、耗尽回绕）。
 * 从 sender-loop 拆出，保持单文件 ≤400 行；无 HTTP，便于针对性测试。
 */

import { packInlineBatch } from "./pi-deck-cloud-memory-sync-batch";
import type { SyncOutboxEntry, SyncQueue } from "./pi-deck-cloud-memory-sync-types";

const SCAN_PAGES_PER_TICK = 5;
const CANDIDATE_FACTOR = 4;

export type InlineSelection = {
	readonly batch: SyncOutboxEntry[];
	readonly hasMore: boolean;
	readonly oversized: Array<{ sourceId: string; bytes: number; entry: SyncOutboxEntry }>;
	readonly invalidCount: number;
};

export type InlineSelector = {
	/** 强制从队首重扫（通常在一个批次成功后调用，已确认条目已不存在）。 */
	reset(): void;
	select(): Promise<InlineSelection>;
};

export function createInlineSelector(deps: { queue: SyncQueue; maxBatchRecords: number; maxBatchBytes: number; maxInlineRecordBytes: number }): InlineSelector {
	let scanCursor: string | null = null;
	return {
		reset(): void {
			scanCursor = null;
		},
		async select(): Promise<InlineSelection> {
			const target = deps.maxBatchRecords * CANDIDATE_FACTOR;
			const flat: SyncOutboxEntry[] = [];
			let invalidCount = 0;
			let cursor: string | null = scanCursor;
			let exhausted = false;
			for (let page = 0; page < SCAN_PAGES_PER_TICK; page += 1) {
				const result = await deps.queue.listPending({ limit: deps.maxBatchRecords, maxBytes: deps.maxBatchBytes, cursor, maxScan: target });
				invalidCount += result.invalid.length;
				for (const entry of result.entries) {
					if (entry.state === "conflict" || entry.state === "auth_blocked") continue;
					flat.push(entry);
				}
				if (!result.hasMore || !result.nextCursor) {
					exhausted = true;
					break;
				}
				cursor = result.nextCursor;
				if (flat.length >= target) break;
			}
			// 游标跨 tick 持续；走到队列末尾才回绕，避免前部 conflict/超大条目饿死后续。
			scanCursor = exhausted ? null : cursor;
			const packed = packInlineBatch(flat, { maxBatchRecords: deps.maxBatchRecords, maxBatchBytes: deps.maxBatchBytes, maxInlineRecordBytes: deps.maxInlineRecordBytes });
			const consumed = packed.batch.length + packed.oversized.length;
			const hasMore = !exhausted || packed.stalled || consumed < flat.length;
			return { batch: packed.batch, hasMore, oversized: packed.oversized, invalidCount };
		},
	};
}
