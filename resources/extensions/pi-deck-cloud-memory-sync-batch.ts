/**
 * pi-deck-cloud-memory-sync-batch —— 发送批次的纯策略与 chunk 切分（无 IO，可单测）。
 *
 * 组包按“真实 UTF-8 正文”计量：request_id 用同长度的占位串，避免“按条目字节估算后加 wrapper 超限”。
 * chunk 协议按冻结契约：固定 32768 字节片、record payload 最大 16MiB、单条 requestId 与 inline 一致。
 */

import type { SyncOutboxEntry, SyncRecord } from "./pi-deck-cloud-memory-sync-types";

/** request_id 真实长度占位（req_ + 64 hex），用于精确估算批正文。 */
const REQUEST_ID_PLACEHOLDER = `req_${"0".repeat(64)}`;

export const CHUNK_SIZE_BYTES = 32768;
export const MAX_CHUNK_RECORD_BYTES = 16 * 1024 * 1024;

/** 单条记录的 JSON UTF-8 字节数。 */
export function estimateRecordJsonBytes(record: SyncRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/** 该批 HTTP 正文的 UTF-8 字节数（含 request_id 与包裹）。 */
export function estimateInlineBodyBytes(records: readonly SyncRecord[]): number {
	return Buffer.byteLength(JSON.stringify({ request_id: REQUEST_ID_PLACEHOLDER, records }), "utf8");
}

/** 冲突/暂停中的条目不参与发送；其它状态（pending/unknown）都可进入批次。 */
export function isSendableState(state: SyncOutboxEntry["state"]): boolean {
	return state !== "conflict" && state !== "auth_blocked";
}

export type InlineCaps = {
	readonly maxBatchRecords: number;
	readonly maxBatchBytes: number;
	readonly maxInlineRecordBytes: number;
};

export type PackedInlineBatch = {
	readonly batch: SyncOutboxEntry[];
	/** 超单条 inline 上限、必须走 chunk 的条目（带 entry 便于直接投递）。 */
	readonly oversized: Array<{ sourceId: string; bytes: number; entry: SyncOutboxEntry }>;
	/** 因条数/总字节停止继续装入（页面还有候选）。 */
	readonly stalled: boolean;
};

/**
 * 从有序 entries 里装一批 inline 记录：跳过 conflict/auth_blocked，单条超限转入 oversized，
 * 总字节按真实正文计量；一条超限不阻塞其它正常条。
 */
export function packInlineBatch(entries: readonly SyncOutboxEntry[], caps: InlineCaps): PackedInlineBatch {
	const batch: SyncOutboxEntry[] = [];
	const oversized: Array<{ sourceId: string; bytes: number; entry: SyncOutboxEntry }> = [];
	let stalled = false;
	for (const entry of entries) {
		if (!isSendableState(entry.state)) continue;
		const recordBytes = estimateRecordJsonBytes(entry.record);
		if (recordBytes > caps.maxInlineRecordBytes) {
			oversized.push({ sourceId: entry.record.sourceId, bytes: recordBytes, entry });
			continue;
		}
		if (batch.length > 0) {
			if (batch.length >= caps.maxBatchRecords) {
				stalled = true;
				break;
			}
			const candidate = [...batch, entry];
			if (estimateInlineBodyBytes(candidate.map((item) => item.record)) > caps.maxBatchBytes) {
				stalled = true;
				break;
			}
		}
		batch.push(entry);
	}
	return { batch, oversized, stalled };
}

/** 记录的 canonical payload：JSON.stringify 的 UTF-8 字节，chunk 与 recordSha256 的基础。 */
export function buildRecordPayload(record: SyncRecord): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(record));
}

export function chunkCountFor(totalBytes: number, chunkSize = CHUNK_SIZE_BYTES): number {
	return Math.max(1, Math.ceil(totalBytes / chunkSize));
}

/** 第 index 片的 base64；调用方保证 index < chunkCount。 */
export function chunkBase64At(payload: Uint8Array, index: number, chunkSize = CHUNK_SIZE_BYTES): string {
	const start = index * chunkSize;
	return Buffer.from(payload.subarray(start, Math.min(start + chunkSize, payload.length))).toString("base64");
}

/** chunk 可接受的记录上界（record JSON UTF-8），与队列 envelope 的 16MiB 不是同一口径。 */
export function isChunkableRecord(record: SyncRecord): boolean {
	return estimateRecordJsonBytes(record) <= MAX_CHUNK_RECORD_BYTES;
}
