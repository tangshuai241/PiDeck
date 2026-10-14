/**
 * pi-deck-cloud-memory-sync-transport —— N08 原话导入的 HTTP 传输层（注入 fetch，纯函数）。
 *
 * 协议（frozen-contract 开发字段补充）：
 * - POST {baseUrl}/api/cloud/conversation-imports，正文 { request_id, records: SyncRecord[] }。
 * - GET  {baseUrl}/api/cloud/conversation-imports/:request_id，返回 { ok, request_id, records: SyncReceipt[] }。
 * - records 使用共享原话结构的 camelCase 字段；回执逐条绑定 stored/accountId/cloudInstanceId/sourceId/revision/contentHash/textSha256。
 *
 * 安全与资源：redirect:"error"；响应流式读取、超过 256KiB 立即取消；结果只含状态与受限元信息
 * （409 的 sourceId 列表），不记录 token、URL query 或正文；request_id 由该批 sourceId+contentHash 稳定哈希生成。
 * 服务端默认 body 上限 64KiB 量级，批总字节默认取 60KiB 且按 UTF-8 实测量组包，不依赖生产配置放大。
 */

import { SOURCE_ID_PATTERN, canonicalJson, sha256Hex } from "./pi-deck-cloud-memory-sync-identity";
import { estimateRecordJsonBytes } from "./pi-deck-cloud-memory-sync-batch";
import { isRecord, parseReceipt } from "./pi-deck-cloud-memory-sync-outbox-fs";
import type { SyncReceipt, SyncRecord } from "./pi-deck-cloud-memory-sync-types";

export const IMPORT_PATH = "/api/cloud/conversation-imports";
/** 单批正文保守上界（服务端默认 64KiB，留余量）。 */
export const MAX_BATCH_BYTES = 60 * 1024;
/** 服务端 inline 单条上限（48KiB）；超过的条目走 chunk 协议。 */
export const MAX_INLINE_RECORD_BYTES = 48 * 1024;
/** 响应流式读取上限；超过即取消并按失败处理，不拼接半包。 */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** 契约每批最多 20 条。 */
export const MAX_BATCH_RECORDS = 20;

/** 与 sync-batch 同一实现的字节估算（旧调用点兼容）。 */
export const estimateRecordBytes = estimateRecordJsonBytes;

export type SyncBodyReader = {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void> | void;
};

export type SyncFetchResponse = { ok: boolean; status: number; body: SyncBodyReader | null };
export type SyncFetchInit = { method: "GET" | "POST" | "PUT"; headers: Record<string, string>; body: string | null; redirect: "error"; signal: AbortSignal };
export type SyncFetch = (url: string, init: SyncFetchInit) => Promise<SyncFetchResponse>;

export type SyncTransportFailure = "network_error" | "http_error" | "parse_error" | "batch_too_large" | "record_too_large" | "aborted";

export type SyncTransportResult =
	| { kind: "ok"; status: number; requestId: string; receipts: SyncReceipt[] }
	| { kind: "unauthorized"; status: number }
	| { kind: "not_found"; status: number }
	| { kind: "conflict"; status: number; sourceIds: string[] }
	| { kind: "failure"; reason: SyncTransportFailure; status: number | null };

export type SyncFetchResponseRaw = { kind: "response"; status: number; ok: boolean; text: string | null };

/** 原始请求结果：只给内部与 chunk 传输复用；文本读取仍受 256KiB 上界。 */
export type SyncFetchRaw = SyncFetchResponseRaw | { kind: "network"; reason: "network_error" | "aborted" };

/** 默认 fetch：把 Response 的 body 流包装成可限额读取的 reader，不做任何缓存。 */
export function createDefaultSyncFetch(): SyncFetch {
	return async (url, init) => {
		const response = await fetch(url, init);
		const stream = response.body;
		if (stream === null) return { ok: response.ok, status: response.status, body: null };
		const reader = stream.getReader();
		return {
			ok: response.ok,
			status: response.status,
			body: {
				read: async () => {
					const step = await reader.read();
					return step.done ? { done: true } : { done: false, value: step.value };
				},
				cancel: (reason?: unknown) => reader.cancel(reason),
			},
		};
	};
}

/** 该批的稳定 request_id：sourceId+contentHash 排序后的 canonical JSON 完整 SHA-256。 */
export function requestIdForBatch(records: readonly SyncRecord[]): string {
	const pairs = records
		.map((record) => [record.sourceId, record.contentHash] as const)
		.sort((left, right) => (left[0] === right[0] ? 0 : left[0] < right[0] ? -1 : 1));
	return `req_${sha256Hex(Buffer.from(canonicalJson(pairs), "utf8"))}`;
}

export function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function readBodyBounded(body: SyncBodyReader | null, maxBytes: number): Promise<{ kind: "ok"; text: string } | { kind: "empty" } | { kind: "too_large" }> {
	if (body === null) return { kind: "empty" };
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const step = await body.read();
		if (step.done) break;
		const value = step.value;
		if (!value || value.byteLength === 0) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			try {
				await body.cancel("response_too_large");
			} catch {
				// 取消失败不影响“超限即不解析”的结论。
			}
			return { kind: "too_large" };
		}
		chunks.push(value);
	}
	if (total === 0) return { kind: "empty" };
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { kind: "ok", text: new TextDecoder().decode(merged) };
}

/** 发一次请求并限额读回文本；不做状态分类，供导入与 chunk 端点共用。 */
export async function fetchResponseText(deps: { url: string; method: "GET" | "POST" | "PUT"; token: string; body: string | null; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncFetchRaw> {
	const headers: Record<string, string> = { authorization: `Bearer ${deps.token}`, accept: "application/json" };
	if (deps.body !== null) headers["content-type"] = "application/json";
	let response: SyncFetchResponse;
	try {
		response = await deps.fetchImpl(deps.url, { method: deps.method, headers, body: deps.body, redirect: "error", signal: deps.signal });
	} catch {
		return { kind: "network", reason: deps.signal.aborted ? "aborted" : "network_error" };
	}
	const read = await readBodyBounded(response.body, MAX_RESPONSE_BYTES).catch((): { kind: "empty" } => ({ kind: "empty" }));
	return { kind: "response", status: response.status, ok: response.ok, text: read.kind === "ok" ? read.text : null };
}

/** 从 409 正文里提取受限 sourceId 列表（≤50，仅 src_ 形态）；无列表返回空数组，由调用方拆单条定位。 */
export function parseConflictSourceIds(text: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	const found = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && SOURCE_ID_PATTERN.test(value)) found.add(value);
	};
	const arrays = [parsed.source_ids, parsed.sourceIds];
	for (const candidate of arrays) {
		if (!Array.isArray(candidate)) continue;
		const list: unknown[] = candidate;
		for (const item of list) add(item);
	}
	if (Array.isArray(parsed.conflicts)) {
		const list: unknown[] = parsed.conflicts;
		for (const item of list) {
			if (isRecord(item)) {
				if ("source_id" in item) add(item.source_id);
				if ("sourceId" in item) add(item.sourceId);
			} else add(item);
		}
	}
	return [...found].slice(0, 50);
}

function parseEnvelope(text: string, expectedRequestId: string): SyncReceipt[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed.ok !== true) return null;
	if (parsed.request_id !== expectedRequestId) return null;
	const records = parsed.records;
	if (!Array.isArray(records)) return null;
	const receipts: SyncReceipt[] = [];
	for (const item of records) {
		const receipt = parseReceipt(item);
		if (!receipt) return null;
		receipts.push(receipt);
	}
	return receipts;
}

function classify(raw: SyncFetchRaw, requestId: string): SyncTransportResult {
	if (raw.kind === "network") return { kind: "failure", reason: raw.reason, status: null };
	if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized", status: raw.status };
	if (raw.status === 404) return { kind: "not_found", status: 404 };
	if (raw.status === 409) return { kind: "conflict", status: 409, sourceIds: raw.text === null ? [] : parseConflictSourceIds(raw.text) };
	if (!raw.ok) return { kind: "failure", reason: "http_error", status: raw.status };
	if (raw.text === null) return { kind: "failure", reason: "parse_error", status: raw.status };
	const receipts = parseEnvelope(raw.text, requestId);
	if (receipts === null) return { kind: "failure", reason: "parse_error", status: raw.status };
	return { kind: "ok", status: raw.status, requestId, receipts };
}

async function request(deps: { url: string; method: "GET" | "POST"; token: string; requestId: string; body: string | null; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncTransportResult> {
	if (deps.body !== null && Buffer.byteLength(deps.body, "utf8") > MAX_BATCH_BYTES) return { kind: "failure", reason: "batch_too_large", status: null };
	const raw = await fetchResponseText({ url: deps.url, method: deps.method, token: deps.token, body: deps.body, fetchImpl: deps.fetchImpl, signal: deps.signal });
	return classify(raw, deps.requestId);
}

export function postConversationImport(deps: { baseUrl: string; token: string; requestId: string; records: readonly SyncRecord[]; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncTransportResult> {
	// 防御：inline 单条 48KiB 是服务端上界；超限明确失败，由调用方走 chunk。
	if (deps.records.some((record) => estimateRecordJsonBytes(record) > MAX_INLINE_RECORD_BYTES)) return Promise.resolve({ kind: "failure", reason: "record_too_large", status: null });
	const body = JSON.stringify({ request_id: deps.requestId, records: deps.records });
	return request({ url: endpoint(deps.baseUrl, IMPORT_PATH), method: "POST", token: deps.token, requestId: deps.requestId, body, fetchImpl: deps.fetchImpl, signal: deps.signal });
}

export function getConversationImportReceipt(deps: { baseUrl: string; token: string; requestId: string; fetchImpl: SyncFetch; signal: AbortSignal }): Promise<SyncTransportResult> {
	return request({ url: endpoint(deps.baseUrl, `${IMPORT_PATH}/${encodeURIComponent(deps.requestId)}`), method: "GET", token: deps.token, requestId: deps.requestId, body: null, fetchImpl: deps.fetchImpl, signal: deps.signal });
}
