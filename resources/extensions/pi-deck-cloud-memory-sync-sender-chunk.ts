/**
 * pi-deck-cloud-memory-sync-sender-chunk —— 单条长记录的分块上传编排（N08 内聚模块）。
 *
 * 顺序：unknown 先查主 receipt → GET chunk 状态（跳过已收片）→ 缺片 PUT → complete → 再取回执。
 * 409 按 code 区分：UPLOAD_INCOMPLETE=退避重来、ALREADY_COMPLETED=取回执、其余=单条内容冲突。
 * 每片请求前用 checkCurrent() 复核 stopped/账号实例/启用状态与 token；中断重启按同 requestId 续传。
 */

import { sha256Hex } from "./pi-deck-cloud-memory-sync-identity";
import { buildRecordPayload, chunkBase64At, chunkCountFor, MAX_CHUNK_RECORD_BYTES } from "./pi-deck-cloud-memory-sync-batch";
import { completeChunkUpload, getChunkStatus, initChunkUpload, putChunk, type SyncChunkResult } from "./pi-deck-cloud-memory-sync-chunk-transport";
import { getConversationImportReceipt, requestIdForBatch, type SyncFetch } from "./pi-deck-cloud-memory-sync-transport";
import type { SyncReceipt, SyncRecord } from "./pi-deck-cloud-memory-sync-types";

export type ChunkDeliveryResult =
	| { kind: "confirmed"; receipt: SyncReceipt }
	| { kind: "unauthorized"; status: number }
	| { kind: "conflict" }
	| { kind: "too_large"; bytes: number }
	| { kind: "aborted" }
	| { kind: "stale" }
	| { kind: "failure"; reason: string };

type ChunkDeps = {
	baseUrl: string;
	token: string;
	record: SyncRecord;
	wasUnknown: boolean;
	fetchImpl: SyncFetch;
	signal: AbortSignal;
	/** 每片请求前复核：未停、同 scope、enabled/syncEnabled、baseUrl/token 未变。 */
	checkCurrent?: () => Promise<boolean>;
};

function pickReceipt(receipts: readonly SyncReceipt[], sourceId: string): SyncReceipt | null {
	return receipts.find((receipt) => receipt.sourceId === sourceId) ?? null;
}

async function fetchMainReceipt(deps: ChunkDeps, requestId: string): Promise<{ kind: "receipt"; receipt: SyncReceipt } | { kind: "missing" } | { kind: "unauthorized"; status: number } | { kind: "conflict" } | { kind: "aborted" } | { kind: "failure"; reason: string }> {
	const result = await getConversationImportReceipt({ baseUrl: deps.baseUrl, token: deps.token, requestId, fetchImpl: deps.fetchImpl, signal: deps.signal });
	if (result.kind === "ok") {
		const receipt = pickReceipt(result.receipts, deps.record.sourceId);
		return receipt ? { kind: "receipt", receipt } : { kind: "failure", reason: "receipt_unmatched" };
	}
	if (result.kind === "not_found") return { kind: "missing" };
	if (result.kind === "unauthorized") return { kind: "unauthorized", status: result.status };
	if (result.kind === "conflict") return { kind: "conflict" };
	if (result.reason === "aborted") return { kind: "aborted" };
	return { kind: "failure", reason: result.reason };
}

/** chunk 端点失败统一转交：401/403 暂停、内容 409 冲突、incomplete 退避、already_completed 取回执。 */
async function resolveChunkFailure(deps: ChunkDeps, requestId: string, result: SyncChunkResult): Promise<ChunkDeliveryResult> {
	switch (result.kind) {
		case "unauthorized":
			return { kind: "unauthorized", status: result.status };
		case "conflict":
			if (result.reason === "incomplete") return { kind: "failure", reason: "chunk_incomplete" };
			if (result.reason === "already_completed") {
				const main = await fetchMainReceipt(deps, requestId);
				if (main.kind === "receipt") return { kind: "confirmed", receipt: main.receipt };
				if (main.kind === "missing") return { kind: "failure", reason: "receipt_unavailable" };
				return main;
			}
			return { kind: "conflict" };
		case "failure":
			return result.reason === "aborted" ? { kind: "aborted" } : { kind: "failure", reason: result.reason };
		case "not_found":
			return { kind: "failure", reason: "chunk_not_found" };
		case "status":
			return { kind: "failure", reason: "unexpected_chunk_status" };
		case "ok":
			return { kind: "failure", reason: "unexpected_chunk_ok" };
	}
}

export async function deliverChunkRecord(deps: ChunkDeps): Promise<ChunkDeliveryResult> {
	const requestId = requestIdForBatch([deps.record]);
	if (deps.wasUnknown) {
		const main = await fetchMainReceipt(deps, requestId);
		if (main.kind === "receipt") return { kind: "confirmed", receipt: main.receipt };
		if (main.kind !== "missing") return main;
	}

	const payload = buildRecordPayload(deps.record);
	if (payload.byteLength > MAX_CHUNK_RECORD_BYTES) return { kind: "too_large", bytes: payload.byteLength };
	const recordSha256 = sha256Hex(payload);
	const totalBytes = payload.byteLength;
	const chunkCount = chunkCountFor(totalBytes);

	const statusResult = await getChunkStatus({ baseUrl: deps.baseUrl, token: deps.token, requestId, fetchImpl: deps.fetchImpl, signal: deps.signal });
	let received: number[] = [];
	let completed = false;
	if (statusResult.kind === "status") {
		received = statusResult.info.received;
		completed = statusResult.info.completed;
		if (completed && statusResult.info.receipt) return { kind: "confirmed", receipt: statusResult.info.receipt };
	} else if (statusResult.kind === "not_found") {
		const init = await initChunkUpload({ baseUrl: deps.baseUrl, token: deps.token, requestId, sourceId: deps.record.sourceId, contentHash: deps.record.contentHash, recordSha256, totalBytes, chunkCount, fetchImpl: deps.fetchImpl, signal: deps.signal });
		if (init.kind !== "ok") return resolveChunkFailure(deps, requestId, init);
	} else {
		return resolveChunkFailure(deps, requestId, statusResult);
	}

	if (completed) {
		const main = await fetchMainReceipt(deps, requestId);
		if (main.kind === "receipt") return { kind: "confirmed", receipt: main.receipt };
		if (main.kind === "missing") return { kind: "failure", reason: "receipt_unavailable" };
		return main;
	}

	const already = new Set(received);
	for (let index = 0; index < chunkCount; index += 1) {
		if (already.has(index)) continue;
		if (deps.checkCurrent && !(await deps.checkCurrent())) return { kind: "stale" };
		const put = await putChunk({ baseUrl: deps.baseUrl, token: deps.token, requestId, index, dataBase64: chunkBase64At(payload, index), fetchImpl: deps.fetchImpl, signal: deps.signal });
		if (put.kind !== "ok") return resolveChunkFailure(deps, requestId, put);
	}
	if (deps.checkCurrent && !(await deps.checkCurrent())) return { kind: "stale" };
	const complete = await completeChunkUpload({ baseUrl: deps.baseUrl, token: deps.token, requestId, fetchImpl: deps.fetchImpl, signal: deps.signal });
	if (complete.kind !== "ok") return resolveChunkFailure(deps, requestId, complete);
	if (complete.receipt) return { kind: "confirmed", receipt: complete.receipt };

	const main = await fetchMainReceipt(deps, requestId);
	if (main.kind === "receipt") return { kind: "confirmed", receipt: main.receipt };
	if (main.kind === "missing") return { kind: "failure", reason: "receipt_unavailable" };
	return main;
}
