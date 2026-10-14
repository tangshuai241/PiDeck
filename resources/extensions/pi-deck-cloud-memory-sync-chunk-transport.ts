/**
 * pi-deck-cloud-memory-sync-chunk-transport —— 长记录分块上传的 HTTP 层（冻结契约）。
 *
 * - POST {base}/api/cloud/conversation-import-chunks {request_id,sourceId,contentHash,recordSha256,totalBytes,chunkCount}
 * - GET  {base}/.../:request_id → { received:number[], completed, receipt? }
 * - PUT  {base}/.../:request_id/:index {data_base64}
 * - POST {base}/.../:request_id/complete {}
 *
 * 固定 32768 字节片（base64 后连同 JSON 包装仍在单请求 64KiB 内）；不记录 payload/base64/token。
 * 401/403 暂停、409 单条冲突、其它失败按 inline 同策略退回调用方重试。
 */

import { parseReceipt } from "./pi-deck-cloud-memory-sync-outbox-fs";
import { isRecord } from "./pi-deck-cloud-memory-sync-outbox-fs";
import { fetchResponseText, endpoint, type SyncFetch, type SyncFetchResponseRaw, type SyncTransportFailure } from "./pi-deck-cloud-memory-sync-transport";
import { CHUNK_SIZE_BYTES, MAX_CHUNK_RECORD_BYTES } from "./pi-deck-cloud-memory-sync-batch";
import type { SyncReceipt } from "./pi-deck-cloud-memory-sync-types";

export const CHUNK_PATH = "/api/cloud/conversation-import-chunks";
export { CHUNK_SIZE_BYTES, MAX_CHUNK_RECORD_BYTES };

export type SyncChunkConflictReason = "incomplete" | "already_completed" | "content";

export type SyncChunkResult =
	| { kind: "ok"; receipt: SyncReceipt | null }
	| { kind: "status"; info: SyncChunkStatusInfo }
	| { kind: "not_found"; status: number }
	| { kind: "unauthorized"; status: number }
	| { kind: "conflict"; status: number; reason: SyncChunkConflictReason }
	| { kind: "failure"; reason: SyncTransportFailure; status: number | null };

export type SyncChunkStatusInfo = { received: number[]; completed: boolean; receipt: SyncReceipt | null };

function parseIndexList(value: unknown): number[] {
	const out: number[] = [];
	if (!Array.isArray(value)) return out;
	const list: unknown[] = value;
	for (const item of list) {
		if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && out.length < 1024) out.push(item);
	}
	return out;
}

/** 回执字段可能是单条、数组或 null（status.receipt 为 SyncReceipt[]，complete 为 records:[receipt]）。 */
function parseReceiptList(value: unknown): SyncReceipt[] | null {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		const list: unknown[] = value;
		const out: SyncReceipt[] = [];
		for (const item of list) {
			const receipt = parseReceipt(item);
			if (!receipt) return null;
			out.push(receipt);
		}
		return out;
	}
	const single = parseReceipt(value);
	return single === null ? null : [single];
}

function parseStatusInfo(text: string | null): SyncChunkStatusInfo | null {
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const received = parseIndexList(parsed.received);
	const receipts = parseReceiptList(parsed.receipt);
	if (receipts === null) return null;
	return { received, completed: parsed.completed === true, receipt: receipts[0] ?? null };
}

function parseOkReceipt(text: string | null): { receipt: SyncReceipt | null } | null {
	if (text === null) return { receipt: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return { receipt: null };
	const fromRecords = parseReceiptList(parsed.records);
	if (fromRecords === null) return null;
	if (fromRecords.length > 0) return { receipt: fromRecords[0] };
	const fromReceipt = parseReceiptList(parsed.receipt);
	if (fromReceipt === null) return null;
	return { receipt: fromReceipt[0] ?? null };
}

/** 409 分类：UPLOAD_INCOMPLETE / ALREADY_COMPLETED 不是内容冲突，其余按单条冲突处理。 */
function parseConflictReason(text: string | null): SyncChunkConflictReason {
	if (text === null) return "content";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "content";
	}
	if (!isRecord(parsed)) return "content";
	const code = typeof parsed.code === "string" ? parsed.code : typeof parsed.error === "string" ? parsed.error : null;
	if (code === "UPLOAD_INCOMPLETE") return "incomplete";
	if (code === "ALREADY_COMPLETED") return "already_completed";
	return "content";
}

function classifyResponse(raw: SyncFetchResponseRaw): SyncChunkResult | null {
	if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized", status: raw.status };
	if (raw.status === 404) return { kind: "not_found", status: 404 };
	if (raw.status === 409) return { kind: "conflict", status: 409, reason: parseConflictReason(raw.text) };
	if (!raw.ok) return { kind: "failure", reason: "http_error", status: raw.status };
	return null;
}

async function callChunkEndpoint(deps: { url: string; method: "GET" | "POST" | "PUT"; token: string; body: string | null; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<{ raw: SyncFetchResponseRaw } | { failure: SyncChunkResult }> {
	const raw = await fetchResponseText({ url: deps.url, method: deps.method, token: deps.token, body: deps.body, fetchImpl: deps.fetchImpl, signal: deps.signal });
	if (raw.kind === "network") return { failure: { kind: "failure", reason: raw.reason, status: null } };
	const failure = classifyResponse(raw);
	if (failure) return { failure };
	return { raw };
}

export async function initChunkUpload(deps: {
	baseUrl: string;
	token: string;
	requestId: string;
	sourceId: string;
	contentHash: string;
	recordSha256: string;
	totalBytes: number;
	chunkCount: number;
	fetchImpl: SyncFetch;
	signal: AbortSignal;
}): Promise<SyncChunkResult> {
	const call = await callChunkEndpoint({
		url: endpoint(deps.baseUrl, CHUNK_PATH),
		method: "POST",
		token: deps.token,
		body: JSON.stringify({ request_id: deps.requestId, sourceId: deps.sourceId, contentHash: deps.contentHash, recordSha256: deps.recordSha256, totalBytes: deps.totalBytes, chunkCount: deps.chunkCount }),
		fetchImpl: deps.fetchImpl,
		signal: deps.signal,
	});
	if ("failure" in call) return call.failure;
	const parsed = parseOkReceipt(call.raw.text);
	if (parsed === null) return { kind: "failure", reason: "parse_error", status: call.raw.status };
	return { kind: "ok", receipt: parsed.receipt };
}

export async function getChunkStatus(deps: { baseUrl: string; token: string; requestId: string; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncChunkResult> {
	const call = await callChunkEndpoint({ url: endpoint(deps.baseUrl, `${CHUNK_PATH}/${encodeURIComponent(deps.requestId)}`), method: "GET", token: deps.token, body: null, fetchImpl: deps.fetchImpl, signal: deps.signal });
	if ("failure" in call) return call.failure;
	const info = parseStatusInfo(call.raw.text);
	if (info === null) return { kind: "failure", reason: "parse_error", status: call.raw.status };
	return { kind: "status", info };
}

export async function putChunk(deps: { baseUrl: string; token: string; requestId: string; index: number; dataBase64: string; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncChunkResult> {
	const call = await callChunkEndpoint({
		url: endpoint(deps.baseUrl, `${CHUNK_PATH}/${encodeURIComponent(deps.requestId)}/${deps.index}`),
		method: "PUT",
		token: deps.token,
		body: JSON.stringify({ data_base64: deps.dataBase64 }),
		fetchImpl: deps.fetchImpl,
		signal: deps.signal,
	});
	if ("failure" in call) return call.failure;
	const parsed = parseOkReceipt(call.raw.text);
	if (parsed === null) return { kind: "failure", reason: "parse_error", status: call.raw.status };
	return { kind: "ok", receipt: parsed.receipt };
}

export async function completeChunkUpload(deps: { baseUrl: string; token: string; requestId: string; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncChunkResult> {
	const call = await callChunkEndpoint({
		url: endpoint(deps.baseUrl, `${CHUNK_PATH}/${encodeURIComponent(deps.requestId)}/complete`),
		method: "POST",
		token: deps.token,
		body: JSON.stringify({}),
		fetchImpl: deps.fetchImpl,
		signal: deps.signal,
	});
	if ("failure" in call) return call.failure;
	const parsed = parseOkReceipt(call.raw.text);
	if (parsed === null) return { kind: "failure", reason: "parse_error", status: call.raw.status };
	return { kind: "ok", receipt: parsed.receipt };
}
