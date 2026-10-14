/**
 * 阅读 wire 适配（P03 ←→ DeepRead）：snake_case ↔ camelCase 的唯一转换点。
 *
 * 契约来源：`execution/P03/deepread-wire-contract.md`（DeepRead owner 发布，7 端点 + 状态语义）
 * 与 `execution/P03/reading-contract.md`（既有 books/reader-meta/content/resolve-quote）。
 *
 * 边界：
 * - 旧接口容忍字段缺省（analysis/editions 等），但不猜语义；
 * - 新接口严格按 wire 契约：成功必须 HTTP 200 + `ok:true`；写端点还必须 `state:"applied"`
 *   且带回 note revision 才算已保存（pending/unknown 即使 HTTP 200 也只算未确认）；
 * - 错误优先采用服务端 `error.code`/`detail.reason`（同一枚举），缺失时按状态码兜底；
 *   未部署只认「裸 404/405/501」（响应体没有结构化 `error.code`）归 unsupported，认证失败归 needsConnection；
 *   有结构化 `error.code` 的 404/405/501 按真实语义分类（如 notFound），不降级成 unsupported；不回显服务端 message；
 * - 偏移/日期/revision 原样携带，不重算。
 */

import type {
	ReadingAnalysisSummary,
	ReadingChapter,
	ReadingEdition,
	ReadingEditionView,
	ReadingErrorCode,
	ReadingErrorInfo,
	ReadingHistorySession,
	ReadingHistorySource,
	ReadingIdentity,
	ReadingNoteSummary,
	ReadingNoteWriteOperation,
	ReadingQuoteCandidate,
	ReadingQuoteResult,
	ReadingSpineItem,
	ReadingTocItem,
	ReadingWork,
} from "../../../shared/types/reading";
import type { ReadingHistoryPageQuery } from "./readingHttpClientTypes";
// 段落名规范化是边界归一（中文别名→canonical），定义在 readingValidation，这里转出给调用方
import { canonicalNoteSection } from "./readingValidation";

export { canonicalNoteSection };

const ERROR_CODES: readonly ReadingErrorCode[] = ["unavailable", "needsConnection", "invalidInput", "notFound", "unsupported", "staleVersion", "conflict", "unknownOutcome", "writeFailed", "secureStorageUnavailable", "internalError"];

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(record: object, snake: string, camel: string): unknown {
	const value = Reflect.get(record, snake);
	return value === undefined ? Reflect.get(record, camel) : value;
}

function readWireString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length <= maxLength ? value : null;
}

function readWireNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIntOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export type ReadingWireFeature = "notes" | "history" | null;

/** 服务端错误体（新端点统一 `{ok:false,error:{code,message,detail}}`）。 */
export function parseWireErrorBody(payload: unknown): { code: ReadingErrorCode | null; reason: string | null; currentRevision: string | null } {
	const error = isRecord(payload) ? Reflect.get(payload, "error") : null;
	if (!isRecord(error)) return { code: null, reason: null, currentRevision: null };
	const codeRaw = Reflect.get(error, "code");
	const code = typeof codeRaw === "string" && (ERROR_CODES as readonly string[]).includes(codeRaw) ? (codeRaw as ReadingErrorCode) : null;
	const detail = Reflect.get(error, "detail");
	const detailRecord = isRecord(detail) ? detail : null;
	return {
		code,
		reason: detailRecord ? readWireString(pick(detailRecord, "reason", "reason"), 128) : null,
		currentRevision: detailRecord ? readWireString(pick(detailRecord, "current_revision", "currentRevision"), 128) : null,
	};
}

/** 服务端是否给了结构化 `error.code`：有 code 说明端点已部署，这次请求的 404/405/501 是真实业务结果。 */
function hasWireErrorCode(payload: unknown): boolean {
	const error = isRecord(payload) ? Reflect.get(payload, "error") : null;
	return isRecord(error) && typeof Reflect.get(error, "code") === "string";
}

/** HTTP/网络错误 → 结构化错误（优先服务端 code；feature 非空时「裸」404/405/501 才视为未部署）。 */
export function mapReadingHttpError(input: { status: number | null; json: unknown; feature: ReadingWireFeature }): ReadingErrorInfo {
	const { status, feature } = input;
	if (status === null) return { code: "unavailable", message: "阅读服务不可达" };
	const wire = parseWireErrorBody(input.json);
	const detail: ReadingErrorInfo["detail"] = { status };
	if (wire.reason) detail.reason = wire.reason;
	if (wire.currentRevision) detail.current_revision = wire.currentRevision;
	if (status === 401) return { code: "needsConnection", message: "阅读服务需要连接", detail };
	if (wire.code === "staleVersion" || wire.reason === "NOTE_REVISION_CONFLICT") return { code: "staleVersion", message: "笔记已被更新，请刷新后重试", detail };
	if (wire.code === "conflict" || wire.reason === "REQUEST_CONFLICT") return { code: "conflict", message: "该请求与原提交内容不一致", detail };
	// 未部署只认「裸 404/405/501」：响应体没有结构化 error.code 才是服务不认识该端点；
	// 结构化 error.code（如 notFound）说明端点已部署，按真实语义继续分类，避免把业务 404 当成能力不存在。
	if (feature !== null && (status === 404 || status === 405 || status === 501) && !hasWireErrorCode(input.json)) return { code: "unsupported", message: "阅读服务暂未提供该能力", detail };
	if (status === 404) return { code: "notFound", message: "找不到对应内容", detail };
	if (status === 403) return { code: "invalidInput", message: "阅读服务拒绝了该请求", detail: { ...detail, reason: wire.reason ?? "forbidden" } };
	if (status === 400) return { code: "invalidInput", message: "阅读请求参数不合法", detail };
	if (status === 409) return { code: wire.code ?? "conflict", message: "内容已变化，请刷新后重试", detail };
	if (status >= 500) return { code: "unavailable", message: "阅读服务内部错误", detail };
	return { code: "internalError", message: `阅读服务返回 ${status}`, detail };
}

function parseIdentity(raw: unknown, fallback: { workId: string; editionId: string }): ReadingIdentity | null {
	if (!isRecord(raw)) return null;
	const contentVersion = readWireString(pick(raw, "content_version", "contentVersion"), 128);
	if (!contentVersion) return null;
	return {
		workId: fallback.workId,
		editionId: readWireString(pick(raw, "edition_id", "editionId"), 128) ?? fallback.editionId,
		contentVersion,
		filename: readWireString(Reflect.get(raw, "filename"), 512),
		size: readIntOrNull(Reflect.get(raw, "size")),
	};
}

/** `GET /api/catalog` → 作品与版本（editions 字段缺失时用 books 兜底合并）。 */
export function parseWireLibrary(payload: unknown, booksPayload: unknown = null): ReadingWork[] {
	const works: ReadingWork[] = [];
	const editionsByWork = new Map<string, Map<string, ReadingEdition>>();
	if (isRecord(payload)) {
		const rawWorks = Reflect.get(payload, "works");
		if (Array.isArray(rawWorks)) {
			for (const entry of rawWorks) {
				if (!isRecord(entry)) continue;
				const workId = readWireString(pick(entry, "work_id", "workId"), 128);
				const title = readWireString(Reflect.get(entry, "title"), 512);
				if (!workId || title === null) continue;
				const editions = new Map<string, ReadingEdition>();
				const rawEditions = Reflect.get(entry, "editions");
				if (Array.isArray(rawEditions)) {
					for (const edition of rawEditions) {
						const parsed = parseWireEdition(edition);
						if (parsed) editions.set(parsed.editionId, parsed);
					}
				}
				editionsByWork.set(workId, editions);
				works.push({ workId, title, author: readWireString(Reflect.get(entry, "author"), 256), editionCount: readIntOrNull(pick(entry, "edition_count", "editionCount")) ?? editions.size, editions: [] });
			}
		}
	}
	if (isRecord(booksPayload)) {
		const rawBooks = Reflect.get(booksPayload, "books");
		if (Array.isArray(rawBooks)) {
			for (const book of rawBooks) {
				if (!isRecord(book)) continue;
				const workId = readWireString(pick(book, "work_id", "workId"), 128);
				const editionId = readWireString(pick(book, "edition_id", "editionId"), 128);
				const rel = readWireString(pick(book, "rel", "path"), 1024);
				if (!workId || !editionId || !rel) continue;
				let editions = editionsByWork.get(workId);
				if (!editions) {
					editions = new Map();
					editionsByWork.set(workId, editions);
					works.push({ workId, title: readWireString(Reflect.get(book, "title"), 512) ?? rel, author: null, editionCount: 0, editions: [] });
				}
				if (!editions.has(editionId)) editions.set(editionId, { editionId, rel, size: readIntOrNull(Reflect.get(book, "size")) ?? 0, mtime: readWireNumber(Reflect.get(book, "mtime")) ?? 0, title: readWireString(Reflect.get(book, "title"), 512) });
			}
		}
	}
	return works.map((work) => {
		const editions = [...(editionsByWork.get(work.workId)?.values() ?? [])];
		return { ...work, editions, editionCount: editions.length > 0 ? editions.length : work.editionCount };
	});
}

function parseWireEdition(raw: unknown): ReadingEdition | null {
	if (!isRecord(raw)) return null;
	const editionId = readWireString(pick(raw, "edition_id", "editionId"), 128) ?? readWireString(Reflect.get(raw, "id"), 128);
	const rel = readWireString(pick(raw, "rel", "path"), 1024) ?? readWireString(Reflect.get(raw, "file"), 1024);
	if (!editionId || !rel) return null;
	return { editionId, rel, size: readIntOrNull(Reflect.get(raw, "size")) ?? 0, mtime: readWireNumber(Reflect.get(raw, "mtime")) ?? 0, title: readWireString(Reflect.get(raw, "title"), 512) };
}

/** `GET /api/books/reader-meta` → 版本身份 + 目录 + spine + analysis。 */
export function parseWireEditionView(payload: unknown, fallback: { workId: string; editionId: string }): ReadingEditionView | null {
	if (!isRecord(payload)) return null;
	const identity = parseIdentity(Reflect.get(payload, "identity"), fallback);
	if (!identity) return null;
	const toc: ReadingTocItem[] = [];
	const rawToc = Reflect.get(payload, "toc");
	if (Array.isArray(rawToc)) {
		for (const entry of rawToc) {
			if (!isRecord(entry)) continue;
			const href = readWireString(Reflect.get(entry, "href"), 1024);
			const title = readWireString(Reflect.get(entry, "title"), 1024);
			if (!href || title === null) continue;
			toc.push({
				pos: readIntOrNull(Reflect.get(entry, "pos")) ?? toc.length,
				href,
				title,
				isChapter: Reflect.get(entry, "is_chapter") === true,
				chapterNum: readIntOrNull(pick(entry, "chapter_num", "chapterNum")),
				mapStatus: Reflect.get(entry, "map_status") === "chapter" ? "chapter" : "frontmatter",
			});
		}
	}
	const spine: ReadingSpineItem[] = [];
	const rawSpine = Reflect.get(payload, "spine");
	if (Array.isArray(rawSpine)) {
		for (const entry of rawSpine) {
			if (!isRecord(entry)) continue;
			const href = readWireString(Reflect.get(entry, "href"), 1024);
			if (!href) continue;
			spine.push({ index: readIntOrNull(Reflect.get(entry, "index")) ?? spine.length, href });
		}
	}
	return { identity, toc, spine, analysis: parseWireAnalysis(Reflect.get(payload, "analysis")) };
}

function parseWireAnalysis(raw: unknown): ReadingAnalysisSummary | null {
	if (!isRecord(raw)) return null;
	const files = Reflect.get(raw, "files");
	const fileCount = Array.isArray(files) ? files.length : readIntOrNull(files);
	return { found: Reflect.get(raw, "found") === true, matchQuality: readWireString(pick(raw, "match_quality", "matchQuality"), 64), fileCount, matchBasis: readWireString(pick(raw, "match_basis", "matchBasis"), 128) };
}

/** `GET /api/books/content` → 章节正文（offset_unit 原样声明）。 */
export function parseWireChapter(payload: unknown, fallback: { workId: string; editionId: string }): { identity: ReadingIdentity; chapter: ReadingChapter } | null {
	if (!isRecord(payload)) return null;
	const identity = parseIdentity(Reflect.get(payload, "identity"), fallback);
	const rawChapter = Reflect.get(payload, "chapter");
	if (!identity || !isRecord(rawChapter)) return null;
	const href = readWireString(Reflect.get(rawChapter, "href"), 1024);
	const title = readWireString(Reflect.get(rawChapter, "title"), 1024);
	const text = Reflect.get(rawChapter, "text");
	if (href === null || title === null || typeof text !== "string") return null;
	return {
		identity,
		chapter: {
			chapterNum: readIntOrNull(pick(rawChapter, "chapter_num", "chapterNum")),
			title,
			href,
			text,
			wordCount: readIntOrNull(pick(rawChapter, "word_count", "wordCount")) ?? 0,
			textDigest: readWireString(pick(rawChapter, "text_digest", "textDigest"), 128),
			offsetUnit: "unicode_code_point",
		},
	};
}

/** `POST /api/books/resolve-quote` → 候选与偏移（code point，原样）。 */
export function parseWireQuote(payload: unknown, fallback: { workId: string; editionId: string }): Omit<ReadingQuoteResult & { ok: true }, "ok"> | null {
	if (!isRecord(payload)) return null;
	const identity = parseIdentity(Reflect.get(payload, "identity"), fallback);
	if (!identity) return null;
	const candidates: ReadingQuoteCandidate[] = [];
	const rawCandidates = Reflect.get(payload, "candidates");
	if (Array.isArray(rawCandidates)) {
		for (const entry of rawCandidates) {
			if (!isRecord(entry)) continue;
			const href = readWireString(Reflect.get(entry, "href"), 1024);
			if (href === null) continue;
			candidates.push({
				chapterNum: readIntOrNull(pick(entry, "chapter_num", "chapterNum")),
				href,
				title: readWireString(Reflect.get(entry, "title"), 1024) ?? "",
				matchStatus: readWireString(pick(entry, "match_status", "matchStatus"), 64) ?? "unknown",
				matchLevel: readWireString(pick(entry, "match_level", "matchLevel"), 64) ?? "unknown",
				start: readIntOrNull(Reflect.get(entry, "start")),
				end: readIntOrNull(Reflect.get(entry, "end")),
				chapterWordCount: readIntOrNull(pick(entry, "chapter_word_count", "chapterWordCount")),
			});
		}
	}
	return { identity, status: readWireString(Reflect.get(payload, "status"), 64) ?? "unknown", candidates, candidatesTruncated: Reflect.get(payload, "candidates_truncated") === true, note: readWireString(Reflect.get(payload, "note"), 512) };
}

function parseNoteSummary(raw: unknown): ReadingNoteSummary | null {
	if (!isRecord(raw)) return null;
	const noteId = readWireString(pick(raw, "note_id", "noteId"), 128);
	const name = readWireString(pick(raw, "name", "title"), 512);
	if (!noteId || name === null) return null;
	const chapterLabel = readWireString(pick(raw, "chapter_label", "chapterLabel"), 512);
	const unlocatedRaw = Reflect.get(raw, "unlocated");
	const linkRaw = pick(raw, "link_status", "linkStatus");
	return {
		noteId,
		source: "deepread",
		name,
		chapterLabel,
		revision: readWireString(Reflect.get(raw, "revision"), 128),
		updatedAt: readWireString(pick(raw, "updated_at", "updatedAt"), 64),
		// unlocated 由服务端判定；缺字段时才用「无标签」兜底（不猜锚点）
		unlocated: typeof unlocatedRaw === "boolean" ? unlocatedRaw : chapterLabel === null,
		linkStatus: linkRaw === "linked" || linkRaw === "pending" ? linkRaw : null,
	};
}

/** `GET /api/notes/by-work` → 本 work 的 notes + 归属未知的 unattributed（可单独显示）。 */
export function parseWireNoteList(payload: unknown): { notes: ReadingNoteSummary[]; unattributed: ReadingNoteSummary[]; truncated: boolean } | null {
	if (!isRecord(payload)) return null;
	const rawNotes = Reflect.get(payload, "notes");
	if (!Array.isArray(rawNotes)) return null;
	const notes: ReadingNoteSummary[] = [];
	for (const entry of rawNotes) {
		const note = parseNoteSummary(entry);
		if (note) notes.push(note);
	}
	const unattributed: ReadingNoteSummary[] = [];
	const rawUnattributed = Reflect.get(payload, "unattributed");
	if (Array.isArray(rawUnattributed)) {
		for (const entry of rawUnattributed) {
			const note = parseNoteSummary(entry);
			if (note) unattributed.push(note);
		}
	}
	return { notes, unattributed, truncated: Reflect.get(payload, "truncated") === true };
}

export function parseWireNoteRead(payload: unknown): { note: ReadingNoteSummary; content: string; truncated: boolean } | null {
	if (!isRecord(payload)) return null;
	const note = parseNoteSummary(Reflect.get(payload, "note") ?? payload);
	const content = Reflect.get(payload, "content");
	if (!note || typeof content !== "string") return null;
	return { note, content, truncated: Reflect.get(payload, "truncated") === true };
}

export type WireNoteWriteOutcome = {
	/** HTTP 200 且 ok:true 才是成功；写端点还需 state:"applied" 与 note revision。 */
	ok: boolean;
	state: "applied" | "pending" | "unknown" | null;
	note: ReadingNoteSummary | null;
	error: ReadingErrorInfo | null;
	requestId: string | null;
	replayed: boolean;
};

/** `POST /api/notes/write` → 统一结果（含 HTTP 200 的捕获失败：ok:false + state）。 */
export function parseWireNoteWriteOutcome(payload: unknown): WireNoteWriteOutcome | null {
	if (!isRecord(payload)) return null;
	const ok = Reflect.get(payload, "ok") === true;
	const stateRaw = Reflect.get(payload, "state");
	const state = stateRaw === "applied" || stateRaw === "pending" || stateRaw === "unknown" ? stateRaw : null;
	const note = parseNoteSummary(Reflect.get(payload, "note"));
	const wire = parseWireErrorBody(payload);
	const error: ReadingErrorInfo | null = ok
		? null
		: {
				code: wire.code ?? "unknownOutcome",
				message: wire.code === "conflict" ? "该请求与原提交内容不一致" : wire.code === "staleVersion" ? "笔记已被更新，请刷新后重试" : "服务端尚未确认该笔记写入",
				...(wire.reason || wire.currentRevision ? { detail: { ...(wire.reason ? { reason: wire.reason } : {}), ...(wire.currentRevision ? { current_revision: wire.currentRevision } : {}) } } : {}),
			};
	return { ok, state, note: note ?? null, error, requestId: readWireString(pick(payload, "request_id", "requestId"), 128), replayed: Reflect.get(payload, "replayed") === true };
}

/** `GET /api/notes/request` → 对账状态（只读，不触发重放写）。 */
export function parseWireNoteRequest(payload: unknown): { state: "applied" | "pending" | "unknown" | null; note: ReadingNoteSummary | null; requestId: string | null; updatedAt: string | null } | null {
	if (!isRecord(payload)) return null;
	const stateRaw = Reflect.get(payload, "state");
	return {
		state: stateRaw === "applied" || stateRaw === "pending" || stateRaw === "unknown" ? stateRaw : null,
		note: parseNoteSummary(Reflect.get(payload, "note")),
		requestId: readWireString(pick(payload, "request_id", "requestId"), 128),
		updatedAt: readWireString(pick(payload, "updated_at", "updatedAt"), 64),
	};
}

export function parseWireHistorySources(payload: unknown): ReadingHistorySource[] {
	const raw = isRecord(payload) ? Reflect.get(payload, "sources") : null;
	if (!Array.isArray(raw)) return [];
	const out: ReadingHistorySource[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const source = Reflect.get(entry, "source");
		if (source !== "deepread-current" && source !== "deepread-legacy") continue;
		out.push({ source, label: readWireString(Reflect.get(entry, "label"), 128) ?? source, root: readWireString(Reflect.get(entry, "root"), 1024) ?? "", count: readIntOrNull(Reflect.get(entry, "count")) ?? 0, readable: Reflect.get(entry, "readable") !== false });
	}
	return out;
}

function parseHistorySessionItem(raw: unknown, fallbackSource: ReadingHistorySource["source"] | null): ReadingHistorySession | null {
	if (!isRecord(raw)) return null;
	const id = readWireString(Reflect.get(raw, "id"), 128);
	if (!id) return null;
	const sourceRaw = Reflect.get(raw, "source");
	const source: ReadingHistorySource["source"] = sourceRaw === "deepread-current" || sourceRaw === "deepread-legacy" ? sourceRaw : (fallbackSource ?? "deepread-current");
	const countsRaw = Reflect.get(raw, "counts");
	return {
		source,
		id,
		title: readWireString(Reflect.get(raw, "title"), 512),
		bookLabel: readWireString(pick(raw, "book_label", "bookLabel"), 512) ?? readWireString(Reflect.get(raw, "book"), 512),
		chapterLabel: readWireString(pick(raw, "chapter_label", "chapterLabel"), 512) ?? readWireString(Reflect.get(raw, "chapter"), 512),
		attribution: Reflect.get(raw, "attribution") === "bound" ? "bound" : "unattributed",
		provider: readWireString(Reflect.get(raw, "provider"), 128),
		model: readWireString(Reflect.get(raw, "model"), 128),
		updatedAt: readWireString(pick(raw, "updated_at", "updatedAt"), 64),
		counts: isRecord(countsRaw) ? (countsRaw as Record<string, number>) : null,
		readable: Reflect.get(raw, "readable") !== false,
		error: readWireString(Reflect.get(raw, "error"), 512),
	};
}

export function parseWireHistoryList(payload: unknown): { source: ReadingHistorySource["source"]; sessions: ReadingHistorySession[]; nextCursor: string | null } | null {
	if (!isRecord(payload)) return null;
	const sourceRaw = Reflect.get(payload, "source");
	const source: ReadingHistorySource["source"] | null = sourceRaw === "deepread-current" || sourceRaw === "deepread-legacy" ? sourceRaw : null;
	const rawItems = Reflect.get(payload, "sessions") ?? Reflect.get(payload, "items");
	if (!Array.isArray(rawItems)) return null;
	const sessions: ReadingHistorySession[] = [];
	for (const entry of rawItems) {
		const parsed = parseHistorySessionItem(entry, source);
		if (parsed) sessions.push(parsed);
	}
	return { source: source ?? sessions[0]?.source ?? "deepread-current", sessions, nextCursor: readWireString(pick(payload, "next_cursor", "nextCursor"), 512) };
}

/** `GET /api/history/session`（或别名）→ 摘要 + 原始文本 + truncated（raw 缺失时用响应文本兜底）。 */
export function parseWireHistorySessionDetail(payload: unknown, responseText: string): { session: ReadingHistorySession | null; raw: string; truncated: boolean } | null {
	if (!isRecord(payload)) return null;
	const session = parseHistorySessionItem(Reflect.get(payload, "session") ?? payload, null);
	const raw = readWireString(Reflect.get(payload, "raw"), 4 * 1024 * 1024) ?? responseText;
	return { session, raw, truncated: Reflect.get(payload, "truncated") === true };
}

/** `POST /api/notes/write` 请求体：DeepRead wire snake_case。 */
export function buildNoteWriteBody(operation: ReadingNoteWriteOperation, requestId: string): Record<string, unknown> {
	if (operation.op === "create") {
		return {
			request_id: requestId,
			op: "create",
			work_id: operation.workId,
			edition_id: operation.editionId,
			concept: operation.concept,
			...(operation.chapter === undefined || operation.chapter === null ? {} : { chapter: operation.chapter }),
			...(operation.quote === undefined || operation.quote === null ? {} : { quote: operation.quote }),
			...(operation.understanding === undefined || operation.understanding === null ? {} : { understanding: operation.understanding }),
		};
	}
	return {
		request_id: requestId,
		op: operation.op,
		work_id: operation.workId,
		edition_id: operation.editionId,
		note_id: operation.noteId,
		section: canonicalNoteSection(operation.section),
		content: operation.content,
		expected_revision: operation.expectedRevision,
	};
}

export function buildHistoryQuery(query: ReadingHistoryPageQuery): string {
	const params = new URLSearchParams({ source: query.source, limit: String(query.limit) });
	if (query.cursor) params.set("cursor", query.cursor);
	return params.toString();
}

export function buildHistorySessionQuery(source: string, id: string): string {
	return new URLSearchParams({ source, id }).toString();
}
