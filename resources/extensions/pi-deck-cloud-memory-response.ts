/**
 * pi-deck-cloud-memory-response —— 云端记忆工具回包的**有界读取**与 unknown 收窄。
 *
 * 为什么不塞进 wrapper / policy：
 * - 读取必须带字节上界（恶意/故障服务不能让我们无限缓冲），且要能单测 reader 路径；
 * - 回包形状是第三方数据，所有字段在这里收窄并加上条数/单条字段上限；
 * - 坏条目必须整体报 invalid_items，不能静默丢成「成功空集」；
 * - 新契约字段（preview_truncated / sources / budget / partial / 分页与哈希）缺失时保持 null，
 *   如实表达「服务端未提供」，不猜、不补默认值。
 */

import { isRecord } from "./pi-deck-cloud-memory-config";

/** 单次回包最多读 256KiB 字节；超出即报 response_too_large，绝不继续缓冲。 */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** 安全条数上限 50：与正文预算（max_tokens）分别标记，超出视为坏回包。 */
export const MAX_SEARCH_ITEMS = 50;
export const MAX_ITEM_ID_CHARS = 256;
export const MAX_ITEM_TEXT_CHARS = 16 * 1024;
export const MAX_ITEM_META_CHARS = 1024;
export const MAX_SOURCE_CONTENT_CHARS = 32_000;
/** 解析上界（保护性）；展示条数由 policy 的 MAX_SOURCE_REFS_PER_ITEM 控制，多余条数显式标出。 */
export const MAX_PARSED_SOURCE_REFS = 32;
export const MAX_SOURCE_PIECES = 20;

/** 来源类型（云端 recall items 可选字段）；未知值一律归 null，不猜。 */
export const SOURCE_TYPES = ["user_statement", "user_question", "assistant_answer", "assistant_inference", "user_confirmed"] as const;
export type MemorySourceType = (typeof SOURCE_TYPES)[number];
/** 确认状态：self_reported 只是用户自述（不等于外部核实），未知/缺失一律 null（不得当已确认）。 */
export const CONFIRMATIONS = ["self_reported", "explicit_user_confirmation", "unconfirmed"] as const;
export type MemoryConfirmation = (typeof CONFIRMATIONS)[number];

export type ServerTiming = { hindsight_ms: number | null; server_total_ms: number | null };
export type MemorySourceRef = { sourceId: string; role: string | null; occurredAt: string | null; revision: string | number | null; textSha256: string | null };
export type SearchItem = {
	text: string;
	id: string;
	documentId: string | null;
	sourceId: string | null;
	scope: string | null;
	mentionedAt: string | null;
	sourceType: MemorySourceType | null;
	confirmation: MemoryConfirmation | null;
	validFrom: string | null;
	validTo: string | null;
	/** 项目标签（与 scope 分开：scope 是可见范围，project 是资料分组）。 */
	project: string | null;
	supersededBy: string | null;
	/** true = 该条目属于历史语境（问句/回答/推断），不得当作用户已确认的个人事实；null = 无 metadata（沿用旧行为）。 */
	historicalContext: boolean | null;
	/** true = valid_from 在未来：可展示但不得当作已生效事实。 */
	notYetValid: boolean | null;
	/** null = 服务端未标记完整性；true = 预览被截断。 */
	previewTruncated: boolean | null;
	/** 数组 = 可核验原话引用；"missing" = 显式无来源；"unknown" = 服务端未返回来源信息。 */
	sources: MemorySourceRef[] | "missing" | "unknown";
	synthetic?: boolean;
};
export type SearchBudget = { maxTokens: number | null; limit: number | null; partial: boolean | null };
/** 服务端可选指标：upstream_returned 是上游返回数，不是全库候选数；dropped.outdated 是过期未返回计数。 */
export type SearchIndicators = { dropped: number | null; droppedOutdated: number | null; upstreamReturned: number | null };
export type SearchOutcome =
	| { kind: "items"; items: SearchItem[]; budget: SearchBudget; indicators: SearchIndicators; serverTiming: ServerTiming | null }
	| { kind: "unavailable" }
	| { kind: "not_found" }
	| { kind: "auth_required" }
	| { kind: "aborted"; reason: string }
	| { kind: "error"; reason: string };

export type SourcePiece = { sourceId: string | null; role: string | null; occurredAt: string | null; revision: string | number | null; textSha256: string | null };
/** 同一 memory 关联的多条来源的身份（不拼接正文）；用 record 下标选中一条。 */
export type SourceRecordRef = { sourceId: string | null; role: string | null; occurredAt: string | null; revision: string | number | null; textSha256: string | null; included: boolean | null; type: MemorySourceType | null; confirmation: MemoryConfirmation | null };
export type SourcePayload = {
	sourceId: string | null;
	role: string | null;
	occurredAt: string | null;
	revision: string | number | null;
	project: string | null;
	content: string;
	offset: number | null;
	nextOffset: number | null;
	totalChars: number | null;
	textSha256: string | null;
	/** 来源类型 / 确认状态（顶层透传；未知一律 null）。 */
	sourceType: MemorySourceType | null;
	confirmation: MemoryConfirmation | null;
	/** 首段 text_sha256；offset>0 续读必须带上它。 */
	baseSha256: string | null;
	partial: boolean | null;
	/** 服务端选中的多来源下标（0 基）。 */
	recordIndex: number | null;
	/** 本次响应是否包含选中来源的正文。 */
	included: boolean | null;
	records: SourceRecordRef[];
	/** true = 服务端未返回多来源列表（不是「只有一条」）。 */
	recordsUnknown: boolean;
	pieces: SourcePiece[];
	/** true = 服务端未返回多消息身份拆分（不是「没有多条消息」）。 */
	piecesUnknown: boolean;
};
export type SourceOutcome =
	| { kind: "source"; source: SourcePayload }
	| { kind: "missing" }
	| { kind: "unavailable" }
	| { kind: "auth_required" }
	| { kind: "conflict" }
	| { kind: "aborted"; reason: string }
	| { kind: "error"; reason: string };

export type BoundedBodyResult = { kind: "ok"; text: string } | { kind: "error"; reason: string };

type ResponseReader = { read: () => Promise<unknown>; cancel: () => Promise<unknown>; releaseLock: () => void };

function isReadableBody(value: unknown): value is { getReader: () => unknown } {
	return isRecord(value) && typeof value.getReader === "function";
}

function isResponseReader(value: unknown): value is ResponseReader {
	return isRecord(value) && typeof value.read === "function" && typeof value.cancel === "function" && typeof value.releaseLock === "function";
}

function isTextCapable(value: unknown): value is { text: () => Promise<unknown> } {
	return isRecord(value) && typeof value.text === "function";
}

function isHeaderGetter(value: unknown): value is { get: (name: string) => unknown } {
	return isRecord(value) && typeof value.get === "function";
}

function chunkBytes(value: unknown): Uint8Array | null {
	if (!ArrayBuffer.isView(value)) return null;
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * 有界读取：优先按 stream reader 逐块读并累计字节数，超出上限立即 cancel；
 * 没有 reader 的 Response 实现退回 text()，读完再按字节数拒绝。
 */
export async function readBoundedResponseText(response: unknown, maxBytes: number): Promise<BoundedBodyResult> {
	if (!isRecord(response)) return { kind: "error", reason: "invalid_response" };

	const headers = response.headers;
	if (isHeaderGetter(headers)) {
		const declared = headers.get("content-length");
		if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
			return { kind: "error", reason: "response_too_large" };
		}
	}

	const body = response.body;
	if (isReadableBody(body)) {
		const reader = body.getReader();
		if (isResponseReader(reader)) {
			const decoder = new TextDecoder();
			let received = 0;
			let text = "";
			try {
				for (;;) {
					const step = await reader.read();
					if (!isRecord(step)) continue;
					if (step.done === true) break;
					const bytes = chunkBytes(step.value);
					if (!bytes) continue;
					received += bytes.byteLength;
					if (received > maxBytes) {
						try {
							await reader.cancel();
						} catch {
							// 连接已经断开：取消失败不影响拒绝结果。
						}
						return { kind: "error", reason: "response_too_large" };
					}
					text += decoder.decode(bytes, { stream: true });
				}
				text += decoder.decode();
			} finally {
				try {
					reader.releaseLock();
				} catch {
					// 已释放或流已关闭。
				}
			}
			return { kind: "ok", text };
		}
	}

	if (isTextCapable(response)) {
		const text = await response.text();
		if (typeof text !== "string") return { kind: "error", reason: "invalid_response" };
		if (new TextEncoder().encode(text).byteLength > maxBytes) return { kind: "error", reason: "response_too_large" };
		return { kind: "ok", text };
	}
	return { kind: "error", reason: "invalid_response" };
}

function finiteNonNegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** timing 对象存在即产出结构；单个缺字段保持 null（不是 0/不省略）。 */
export function parseServerTiming(value: unknown): ServerTiming | null {
	if (!isRecord(value)) return null;
	return { hindsight_ms: finiteNonNegative(value.hindsight_ms), server_total_ms: finiteNonNegative(value.server_total_ms) };
}

function boundedString(value: unknown, maxChars: number): string | null {
	return typeof value === "string" && value.length <= maxChars ? value : null;
}

function optionalBoundedString(value: unknown): string | undefined | null {
	// 云端/Hindsight 以 null 表示未知时间或缺少来源属性，与字段缺席含义相同。
	if (value === undefined || value === null) return undefined;
	return boundedString(value, MAX_ITEM_META_CHARS);
}

function optionalBoundedId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return boundedString(value, MAX_ITEM_ID_CHARS);
}

function optionalRevision(value: unknown): string | number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= MAX_ITEM_META_CHARS) return value;
	return null;
}

/** 布尔可选值：按给定顺序取第一个真布尔；全缺保持 null（不猜）。 */
function optionalBoolean(...values: unknown[]): boolean | null {
	for (const value of values) {
		if (typeof value === "boolean") return value;
	}
	return null;
}

/** 固定枚举收窄：未知值返回 null（「未知且合法」不等于已确认）。 */
function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	if (typeof value !== "string") return null;
	for (const item of allowed) {
		if (item === value) return item;
	}
	return null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** ISO 时间（日期或时间戳）；ISO 形状优先，否则只要 Date.parse 合法也接受（保持原样，不换算时区）。 */
function optionalIsoDate(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const text = boundedString(value, MAX_ITEM_META_CHARS);
	if (!text) return null;
	if (ISO_DATE_RE.test(text)) return text;
	return Number.isFinite(Date.parse(text)) ? text : null;
}

/** superseded_by：接受 source_id 字符串或 {source_id} 形态；其它归 null。 */
function optionalSupersededBy(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return boundedString(value, MAX_ITEM_ID_CHARS);
	if (isRecord(value)) return boundedString(value.source_id, MAX_ITEM_ID_CHARS);
	return null;
}

function parseSourceRef(value: unknown): MemorySourceRef | null {
	if (!isRecord(value)) return null;
	const sourceId = boundedString(value.source_id, MAX_ITEM_ID_CHARS);
	if (!sourceId) return null;
	return {
		sourceId,
		role: optionalBoundedString(value.role) ?? null,
		occurredAt: optionalBoundedString(value.occurred_at) ?? null,
		revision: optionalRevision(value.revision),
		// 来源哈希可选：保留它，formatter 会显式标出自述/确认状态，不与核实混为一谈。
		textSha256: optionalBoundedString(value.text_sha256) ?? null,
	};
}

function parseSources(value: unknown): MemorySourceRef[] | "missing" | "unknown" {
	if (value === "missing") return "missing";
	if (Array.isArray(value)) {
		if (value.length === 0) return "missing";
		if (value.length > MAX_PARSED_SOURCE_REFS) return "unknown";
		const refs: MemorySourceRef[] = [];
		for (const raw of value) {
			const ref = parseSourceRef(raw);
			if (!ref) return "unknown";
			refs.push(ref);
		}
		return refs;
	}
	return "unknown";
}

function parseRecallItem(value: unknown): SearchItem | null {
	if (!isRecord(value)) return null;
	const id = boundedString(value.id, MAX_ITEM_ID_CHARS);
	const text = boundedString(value.text, MAX_ITEM_TEXT_CHARS);
	if (!id || !text || text.trim().length === 0) return null;
	const documentId = optionalBoundedString(value.document_id);
	const mentionedAt = optionalBoundedString(value.mentioned_at);
	const sourceId = optionalBoundedString(value.source_id);
	const scope = optionalBoundedString(value.scope);
	if (documentId === null || mentionedAt === null || sourceId === null || scope === null) return null;
	if (value.synthetic !== undefined && typeof value.synthetic !== "boolean") return null;
	const preview = typeof value.preview_truncated === "boolean" ? value.preview_truncated : null;
	return {
		id,
		text,
		documentId: documentId ?? null,
		mentionedAt: mentionedAt ?? null,
		sourceId: sourceId ?? null,
		scope: scope ?? null,
		sourceType: enumOrNull(value.source_type, SOURCE_TYPES),
		confirmation: enumOrNull(value.confirmation, CONFIRMATIONS),
		validFrom: optionalIsoDate(value.valid_from),
		validTo: optionalIsoDate(value.valid_to),
		project: optionalBoundedString(value.project) ?? null,
		supersededBy: optionalSupersededBy(value.superseded_by),
		historicalContext: optionalBoolean(value.historical_context),
		notYetValid: optionalBoolean(value.not_yet_valid),
		previewTruncated: preview,
		sources: parseSources(value.sources),
		synthetic: value.synthetic,
	};
}

const SAFE_REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** 云端错误字段只接受短标识符形态，避免把可能回显 query 的自由文本写进日志。 */
function bodyErrorReason(body: Record<string, unknown>): string {
	for (const key of ["code", "error", "reason"]) {
		const value = body[key];
		if (typeof value === "string" && SAFE_REASON_RE.test(value)) return value;
	}
	return "cloud_error";
}

/** HTTP 状态到工具状态：401/403 认证待恢复；404 一律按「不存在或无权」处理，不区分；409 是版本冲突。 */
function transportStatus(status: number): { kind: "auth_required" } | { kind: "not_found" } | { kind: "conflict" } | { kind: "error"; reason: string } | null {
	if (status === 401 || status === 403) return { kind: "auth_required" };
	if (status === 404) return { kind: "not_found" };
	if (status === 409) return { kind: "conflict" };
	if (status >= 400) return { kind: "error", reason: `http_${Math.trunc(status)}` };
	return null;
}

function parseBudget(body: Record<string, unknown>): SearchBudget {
	const budget = isRecord(body.budget) ? body.budget : {};
	const maxTokens = finiteNonNegative(budget.max_tokens ?? body.max_tokens ?? body.budget_max_tokens);
	const limit = finiteNonNegative(budget.limit ?? body.limit);
	const partialSource = budget.partial ?? body.partial;
	return { maxTokens, limit, partial: typeof partialSource === "boolean" ? partialSource : null };
}

/** dropped/upstream_returned 是可选指标；缺席保持 null，不猜候选总数。dropped 也可以是 {outdated} 对象。 */
function parseIndicators(body: Record<string, unknown>): SearchIndicators {
	const metrics = isRecord(body.metrics) ? body.metrics : body;
	const droppedRaw = metrics.dropped;
	const droppedInfo = isRecord(droppedRaw) ? droppedRaw : null;
	return {
		dropped: droppedInfo ? null : finiteNonNegative(droppedRaw),
		droppedOutdated: droppedInfo ? finiteNonNegative(droppedInfo.outdated) : null,
		upstreamReturned: finiteNonNegative(metrics.upstream_returned ?? metrics.upstreamReturned),
	};
}

/**
 * 收窄 search_memory 回包。任何形状不符都返回结构化 error，绝不伪装成功；
 * available:false（服务未开）单独归为 unavailable；任一条目坏掉 → invalid_items。
 */
export function parseSearchResponse(status: number, body: unknown): SearchOutcome {
	if (!Number.isFinite(status) || status >= 400) {
		const failure = transportStatus(Number.isFinite(status) ? status : 500);
		if (failure === null) return { kind: "error", reason: "invalid_status" };
		// 搜索理论上不返回 409；真碰上就当成版本/状态冲突的真实错误，不伪装成成功。
		if (failure.kind === "conflict") return { kind: "error", reason: "revision_conflict" };
		return failure;
	}
	if (!isRecord(body)) return { kind: "error", reason: "invalid_response" };
	if (body.available === false) return { kind: "unavailable" };
	if (body.ok !== true) return { kind: "error", reason: bodyErrorReason(body) };
	if (!Array.isArray(body.items)) return { kind: "error", reason: "invalid_response" };
	const rawItems: unknown[] = body.items;
	if (rawItems.length > MAX_SEARCH_ITEMS) return { kind: "error", reason: "too_many_items" };
	const items: SearchItem[] = [];
	for (const raw of rawItems) {
		const item = parseRecallItem(raw);
		if (!item) return { kind: "error", reason: "invalid_items" };
		items.push(item);
	}
	return { kind: "items", items, budget: parseBudget(body), indicators: parseIndicators(body), serverTiming: parseServerTiming(body.timing) };
}

function parsePieces(value: unknown): { pieces: SourcePiece[]; piecesUnknown: boolean } {
	if (!Array.isArray(value)) return { pieces: [], piecesUnknown: true };
	const pieces: SourcePiece[] = [];
	for (const raw of value.slice(0, MAX_SOURCE_PIECES)) {
		if (!isRecord(raw)) return { pieces: [], piecesUnknown: true };
		pieces.push({
			sourceId: optionalBoundedId(raw.source_id),
			role: optionalBoundedString(raw.role) ?? null,
			occurredAt: optionalBoundedString(raw.occurred_at) ?? null,
			revision: optionalRevision(raw.revision),
			textSha256: optionalBoundedString(raw.text_sha256) ?? null,
		});
	}
	return { pieces, piecesUnknown: false };
}

/**
 * 收窄 get_memory_source 回包。
 * 分页固定来源版本：服务端若给出与新游标不一致的内容，由调用方按 offset/next_offset 呈现，
 * 本层只如实透出字段，不在本地拼接两个版本。
 */
function parseSourceRecords(value: unknown): { records: SourceRecordRef[]; recordsUnknown: boolean } {
	if (!Array.isArray(value)) return { records: [], recordsUnknown: true };
	const records: SourceRecordRef[] = [];
	for (const raw of value.slice(0, MAX_SOURCE_PIECES)) {
		if (!isRecord(raw)) return { records: [], recordsUnknown: true };
		records.push({
			sourceId: optionalBoundedId(raw.source_id),
			role: optionalBoundedString(raw.role) ?? null,
			occurredAt: optionalBoundedString(raw.occurred_at) ?? null,
			revision: optionalRevision(raw.revision),
			textSha256: optionalBoundedString(raw.text_sha256) ?? null,
			included: typeof raw.included === "boolean" ? raw.included : null,
			type: enumOrNull(raw.type ?? raw.source_type, SOURCE_TYPES),
			confirmation: enumOrNull(raw.confirmation, CONFIRMATIONS),
		});
	}
	return { records, recordsUnknown: false };
}

/**
 * 收窄 get_memory_source 回包。
 * 分页固定来源版本：paging/base_sha256 如实透出，本层不拼接两个版本。
 */
export function parseSourceResponse(status: number, body: unknown): SourceOutcome {
	if (!Number.isFinite(status) || status >= 400) {
		const failure = transportStatus(Number.isFinite(status) ? status : 500);
		if (failure === null) return { kind: "error", reason: "invalid_status" };
		if (failure.kind === "not_found") return { kind: "missing" };
		return failure;
	}
	if (!isRecord(body)) return { kind: "error", reason: "invalid_response" };
	if (body.available === false) return { kind: "unavailable" };
	const nested = isRecord(body.source) ? body.source : null;
	if (body.ok !== true && nested === null) return { kind: "error", reason: bodyErrorReason(body) };
	const payload = nested ?? body;
	const paging = isRecord(payload.paging) ? payload.paging : isRecord(body.paging) ? body.paging : {};

	const content = boundedString(payload.content, MAX_SOURCE_CONTENT_CHARS);
	if (content === null) return { kind: "error", reason: "invalid_source_content" };
	const pieces = parsePieces(payload.pieces);
	const records = parseSourceRecords(payload.records ?? body.records);
	return {
		kind: "source",
		source: {
			sourceId: optionalBoundedId(payload.source_id),
			role: optionalBoundedString(payload.role) ?? null,
			occurredAt: optionalBoundedString(payload.occurred_at) ?? null,
			revision: optionalRevision(payload.revision),
			project: optionalBoundedString(payload.project) ?? null,
			content,
			offset: finiteNonNegative(payload.offset ?? paging.offset),
			nextOffset: finiteNonNegative(payload.next_offset ?? paging.next_offset),
			totalChars: finiteNonNegative(payload.total_chars ?? paging.total_chars),
			textSha256: optionalBoundedString(payload.text_sha256) ?? null,
			sourceType: enumOrNull(body.source_type, SOURCE_TYPES) ?? enumOrNull(payload.source_type, SOURCE_TYPES),
			confirmation: enumOrNull(body.confirmation, CONFIRMATIONS) ?? enumOrNull(payload.confirmation, CONFIRMATIONS),
			baseSha256: optionalBoundedString(payload.base_sha256 ?? paging.base_sha256) ?? null,
			partial: optionalBoolean(payload.partial, paging.partial),
			recordIndex: finiteNonNegative(payload.record_index ?? body.record_index),
			included: optionalBoolean(payload.included, body.included),
			records: records.records,
			recordsUnknown: records.recordsUnknown,
			pieces: pieces.pieces,
			piecesUnknown: pieces.piecesUnknown,
		},
	};
}
