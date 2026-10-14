/**
 * 阅读域边界校验（P03 纯函数）：服务地址、id、章节引用、位置与笔记入参。
 *
 * 为什么独立：这些判定决定「什么算合法阅读请求」，必须能脱离 Electron/fetch 单测；
 * 校验失败一律返回结构化 invalidInput（带字段名），不抛裸异常。
 *
 * 边界：
 * - 服务地址只允许回环 http/https（默认 127.0.0.1:18965）：拒绝用户名/密码、查询、片段、
 *   非回环主机与控制字符；不允许把任意远端当阅读源。
 * - workId/editionId/noteId 只允许 [A-Za-z0-9_.:-]{1,128}（不含路径分隔符），并由服务端登记数据定位；
 * - chapter 只接受 1 起章号或 toc href；正文/备注类文本有明确长度上界且拒绝控制字符。
 */

import {
	READING_DEFAULT_BASE_URL,
	type ReadingBindSessionInput,
	type ReadingBindingRef,
	type ReadingConnectInput,
	type ReadingErrorInfo,
	type ReadingHistorySourceName,
	type ReadingNoteDraftRef,
	type ReadingNoteWriteInput,
	type ReadingNoteWriteOperation,
	type ReadingPositionSaveInput,
} from "../../../shared/types/reading";

const MAX_BASE_URL_CHARS = 2048;
const MAX_ID_CHARS = 128;
const MAX_HREF_CHARS = 512;
const MAX_CONCEPT_CHARS = 200;
const MAX_SECTION_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;
const MAX_QUOTE_CHARS = 5_000;

/** 除换行/制表外的 C0 与 DEL：拒绝日志注入与字段走私。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function readingInvalidInput(message: string, field: string): { ok: false; error: ReadingErrorInfo } {
	return { ok: false, error: { code: "invalidInput", message, detail: { field } } };
}

/** 段落名规范化：wire 只认 quote|understanding|connection|explore（中文别名等价），落库前统一。 */
export function canonicalNoteSection(section: string): string {
	const aliases: Record<string, string> = { 引用原文: "quote", 我的理解: "understanding", 让我想到: "connection", 待探索: "explore" };
	return aliases[section] ?? section;
}

/** 服务 origin（用于草稿按服务隔离）；非法地址返回空串（上层已有地址校验兜底）。 */
export function readingOriginOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return "";
	}
}

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, maxLength: number, allowNewlines: boolean): string | null {
	if (typeof value !== "string" || value.length > maxLength) return null;
	if (CONTROL_CHARS.test(value)) return null;
	if (!allowNewlines && /[\r\n\t]/.test(value)) return null;
	return value;
}

/** 服务地址白名单：回环 http/https，只允许到主机与端口。 */
export function normalizeReadingBaseUrl(value: unknown): { ok: true; baseUrl: string } | { ok: false; error: ReadingErrorInfo } {
	if (value === undefined || value === null) return { ok: true, baseUrl: READING_DEFAULT_BASE_URL };
	if (typeof value !== "string" || !value.trim()) return readingInvalidInput("请填写阅读服务地址", "baseUrl");
	const trimmed = value.trim();
	if (trimmed.length > MAX_BASE_URL_CHARS) return readingInvalidInput("阅读服务地址过长", "baseUrl");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return readingInvalidInput("阅读服务地址不是合法 URL", "baseUrl");
	}
	if (url.username || url.password) return readingInvalidInput("阅读服务地址不能包含账号或密码", "baseUrl");
	if (url.search || url.hash) return readingInvalidInput("阅读服务地址不能带查询参数或片段", "baseUrl");
	if (url.pathname !== "/" && url.pathname !== "") return readingInvalidInput("阅读服务地址只填到主机名与端口", "baseUrl");
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
	if (!loopback) return readingInvalidInput("阅读服务只允许本机回环地址", "baseUrl");
	if (url.protocol !== "https:" && url.protocol !== "http:") return readingInvalidInput("阅读服务地址只允许 http 或 https", "baseUrl");
	return { ok: true, baseUrl: url.origin };
}

export function parseReadingConnectInput(raw: unknown): { ok: true; input: ReadingConnectInput } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("连接参数不完整", "input");
	const baseUrl = normalizeReadingBaseUrl(Reflect.get(raw, "baseUrl"));
	if (!baseUrl.ok) return baseUrl;
	const rawPassword = Reflect.get(raw, "password");
	const password = typeof rawPassword === "string" ? rawPassword : "";
	if (password.length > 512 || /[\r\n]/.test(password)) return readingInvalidInput("密码格式不合法", "password");
	const remember = Reflect.get(raw, "rememberPassword");
	if (typeof remember !== "boolean") return readingInvalidInput("记住密码的取值不合法", "rememberPassword");
	return { ok: true, input: { baseUrl: baseUrl.baseUrl, password, rememberPassword: remember } };
}

/** 服务端签发的稳定 id（work/edition/note）；只做形态与长度校验，语义由服务端登记数据定位。 */
export function parseReadingId(value: unknown, field: string): { ok: true; id: string } | { ok: false; error: ReadingErrorInfo } {
	if (typeof value !== "string") return readingInvalidInput(`缺少${field}`, field);
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_ID_CHARS || !ID_PATTERN.test(trimmed)) return readingInvalidInput(`${field} 不合法`, field);
	return { ok: true, id: trimmed };
}

/** 章节引用：1 起章号或 toc href（只允许 toc/已登记数据给出的相对 href）。 */
export function parseReadingChapterRef(value: unknown): { ok: true; chapter: string } | { ok: false; error: ReadingErrorInfo } {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000) return { ok: true, chapter: String(value) };
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) {
			const num = Number(trimmed);
			if (num < 1 || num > 10_000) return readingInvalidInput("章号必须在 1..10000", "chapter");
			return { ok: true, chapter: trimmed };
		}
		// href：必须含字母或路径分隔符（拒 "-1"/"0" 这类裸号），且不得含空白/控制字符
		if (trimmed && trimmed.length <= MAX_HREF_CHARS && /[A-Za-z/]/.test(trimmed) && !CONTROL_CHARS.test(trimmed) && !/[\r\n\t]/.test(trimmed)) return { ok: true, chapter: trimmed };
	}
	return readingInvalidInput("章节引用必须是章号或目录 href", "chapter");
}

export function parseEditionRef(raw: unknown): { ok: true; workId: string; editionId: string } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少版本引用", "editionId");
	const workId = parseReadingId(Reflect.get(raw, "workId"), "workId");
	if (!workId.ok) return workId;
	const editionId = parseReadingId(Reflect.get(raw, "editionId"), "editionId");
	if (!editionId.ok) return editionId;
	return { ok: true, workId: workId.id, editionId: editionId.id };
}

export function parseReadingChapterRequest(raw: unknown): { ok: true; workId: string; editionId: string; chapter: string } | { ok: false; error: ReadingErrorInfo } {
	const ref = parseEditionRef(raw);
	if (!ref.ok) return ref;
	const chapter = parseReadingChapterRef(isRecord(raw) ? Reflect.get(raw, "chapter") : undefined);
	if (!chapter.ok) return chapter;
	return { ok: true, workId: ref.workId, editionId: ref.editionId, chapter: chapter.chapter };
}

export function parseReadingResolveQuoteInput(raw: unknown): { ok: true; workId: string; editionId: string; text: string; chapterHref: string | null; expectedVersion: string } | { ok: false; error: ReadingErrorInfo } {
	const ref = parseEditionRef(raw);
	if (!ref.ok) return ref;
	const record = raw as object;
	const text = readText(Reflect.get(record, "text"), MAX_QUOTE_CHARS, true);
	if (!text || !text.trim()) return readingInvalidInput("请提供要核验的原文", "text");
	const expected = parseReadingId(Reflect.get(record, "expectedVersion"), "expectedVersion");
	if (!expected.ok) return expected;
	const hrefRaw = Reflect.get(record, "chapterHref");
	let chapterHref: string | null = null;
	if (hrefRaw !== undefined && hrefRaw !== null) {
		const href = readText(hrefRaw, MAX_HREF_CHARS, false);
		if (!href) return readingInvalidInput("章节 href 不合法", "chapterHref");
		chapterHref = href;
	}
	return { ok: true, workId: ref.workId, editionId: ref.editionId, text, chapterHref, expectedVersion: expected.id };
}

export function parseReadingNoteWriteInput(raw: unknown): { ok: true; input: ReadingNoteWriteInput } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少笔记写入参数", "operation");
	const operationRaw = Reflect.get(raw, "operation");
	if (!isRecord(operationRaw)) return readingInvalidInput("缺少笔记操作", "operation");
	const op = Reflect.get(operationRaw, "op");
	const clientRequestIdRaw = Reflect.get(raw, "clientRequestId");
	let clientRequestId: string | undefined;
	if (clientRequestIdRaw !== undefined && clientRequestIdRaw !== null) {
		const requestId = readText(clientRequestIdRaw, 80, false);
		if (!requestId || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) return readingInvalidInput("请求 id 不合法", "clientRequestId");
		clientRequestId = requestId;
	}
	if (op === "create") {
		const workId = parseReadingId(Reflect.get(operationRaw, "workId"), "workId");
		if (!workId.ok) return workId;
		const editionId = parseReadingId(Reflect.get(operationRaw, "editionId"), "editionId");
		if (!editionId.ok) return editionId;
		const concept = readText(Reflect.get(operationRaw, "concept"), MAX_CONCEPT_CHARS, false);
		if (!concept || !concept.trim()) return readingInvalidInput("笔记概念不能为空", "concept");
		const chapter = optionalText(operationRaw, "chapter", MAX_SECTION_CHARS);
		if (chapter === "invalid") return readingInvalidInput("章节标签不合法", "chapter");
		const quote = optionalText(operationRaw, "quote", MAX_QUOTE_CHARS, true);
		if (quote === "invalid") return readingInvalidInput("引用原文不合法", "quote");
		const understanding = optionalText(operationRaw, "understanding", MAX_CONTENT_CHARS, true);
		if (understanding === "invalid") return readingInvalidInput("笔记正文不合法", "understanding");
		const operation: ReadingNoteWriteOperation = { op: "create", workId: workId.id, editionId: editionId.id, concept: concept.trim(), chapter, quote, understanding };
		return { ok: true, input: clientRequestId ? { operation, clientRequestId } : { operation } };
	}
	if (op === "update" || op === "append") {
		const workId = parseReadingId(Reflect.get(operationRaw, "workId"), "workId");
		if (!workId.ok) return workId;
		const editionId = parseReadingId(Reflect.get(operationRaw, "editionId"), "editionId");
		if (!editionId.ok) return editionId;
		const noteId = parseReadingId(Reflect.get(operationRaw, "noteId"), "noteId");
		if (!noteId.ok) return noteId;
		const section = readText(Reflect.get(operationRaw, "section"), MAX_SECTION_CHARS, false);
		if (!section || !section.trim()) return readingInvalidInput("段落名不能为空", "section");
		const content = readText(Reflect.get(operationRaw, "content"), MAX_CONTENT_CHARS, true);
		if (content === null) return readingInvalidInput("段落内容不合法", "content");
		const expected = parseReadingId(Reflect.get(operationRaw, "expectedRevision"), "expectedRevision");
		if (!expected.ok) return expected;
		const operation: ReadingNoteWriteOperation = { op, workId: workId.id, editionId: editionId.id, noteId: noteId.id, section: canonicalNoteSection(section.trim()), content, expectedRevision: expected.id };
		return { ok: true, input: clientRequestId ? { operation, clientRequestId } : { operation } };
	}
	return readingInvalidInput("未知的笔记操作", "op");
}

function optionalText(record: object, key: string, maxLength: number, allowNewlines = false): string | null | "invalid" {
	if (!Object.hasOwn(record, key)) return null;
	const value = Reflect.get(record, key);
	if (value === null || value === undefined) return null;
	return readText(value, maxLength, allowNewlines) ?? "invalid";
}

export function parseReadingPositionSaveInput(raw: unknown): { ok: true; input: ReadingPositionSaveInput } | { ok: false; error: ReadingErrorInfo } {
	const ref = parseEditionRef(raw);
	if (!ref.ok) return ref;
	const record = raw as object;
	const contentVersion = parseReadingId(Reflect.get(record, "contentVersion"), "contentVersion");
	if (!contentVersion.ok) return contentVersion;
	const fractionRaw = Reflect.get(record, "fraction");
	if (typeof fractionRaw !== "number" || !Number.isFinite(fractionRaw) || fractionRaw < 0 || fractionRaw > 1) return readingInvalidInput("阅读位置必须在 0..1", "fraction");
	const spineHref = optionalText(record, "spineHref", MAX_HREF_CHARS);
	if (spineHref === "invalid") return readingInvalidInput("spine href 不合法", "spineHref");
	const chapterTextDigest = optionalText(record, "chapterTextDigest", MAX_ID_CHARS);
	if (chapterTextDigest === "invalid") return readingInvalidInput("章节摘要不合法", "chapterTextDigest");
	const chapterNumRaw = Reflect.get(record, "chapterNum");
	let chapterNum: number | null = null;
	if (chapterNumRaw !== undefined && chapterNumRaw !== null) {
		if (typeof chapterNumRaw !== "number" || !Number.isInteger(chapterNumRaw) || chapterNumRaw < 0) return readingInvalidInput("章节号不合法", "chapterNum");
		chapterNum = chapterNumRaw;
	}
	return { ok: true, input: { workId: ref.workId, editionId: ref.editionId, contentVersion: contentVersion.id, fraction: fractionRaw, spineHref, chapterNum, chapterTextDigest } };
}

/** 旧会话列表查询：source 必填（wire 契约 §6，两源分页各自独立）。limit 1..100，默认 30。 */
export function parseReadingHistoryQuery(raw: unknown): { ok: true; source: ReadingHistorySourceName; cursor: string | null; limit: number } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("历史查询参数不完整", "query");
	const sourceRaw = Reflect.get(raw, "source");
	if (sourceRaw !== "deepread-current" && sourceRaw !== "deepread-legacy") return readingInvalidInput("历史来源必填且必须已登记", "source");
	const cursorRaw = Reflect.get(raw, "cursor");
	let cursor: string | null = null;
	if (cursorRaw !== undefined && cursorRaw !== null && cursorRaw !== "") {
		const cursorText = readText(cursorRaw, 512, false);
		if (!cursorText) return readingInvalidInput("游标不合法", "cursor");
		cursor = cursorText;
	}
	const limitRaw = Reflect.get(raw, "limit");
	let limit = 30;
	if (limitRaw !== undefined && limitRaw !== null) {
		if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) return readingInvalidInput("每页条数必须在 1..100", "limit");
		limit = limitRaw;
	}
	return { ok: true, source: sourceRaw, cursor, limit };
}

/** 未确认笔记草稿引用：草稿身份 = requestId（恢复/丢弃均按它定位）。 */
export function parseReadingNoteDraftRef(raw: unknown): { ok: true; ref: ReadingNoteDraftRef } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少草稿引用", "requestId");
	const requestIdRaw = Reflect.get(raw, "requestId");
	if (typeof requestIdRaw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestIdRaw)) return readingInvalidInput("草稿 requestId 不合法", "requestId");
	return { ok: true, ref: { requestId: requestIdRaw } };
}

export function parseReadingNoteRef(raw: unknown): { ok: true; workId: string; noteId: string } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少笔记引用", "noteId");
	const workId = parseReadingId(Reflect.get(raw, "workId"), "workId");
	if (!workId.ok) return workId;
	const noteId = parseReadingId(Reflect.get(raw, "noteId"), "noteId");
	if (!noteId.ok) return noteId;
	return { ok: true, workId: workId.id, noteId: noteId.id };
}

export function parseReadingPositionRef(raw: unknown): { ok: true; workId: string; editionId: string; contentVersion: string } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少位置引用", "editionId");
	const workId = parseReadingId(Reflect.get(raw, "workId"), "workId");
	if (!workId.ok) return workId;
	const editionId = parseReadingId(Reflect.get(raw, "editionId"), "editionId");
	if (!editionId.ok) return editionId;
	const contentVersion = parseReadingId(Reflect.get(raw, "contentVersion"), "contentVersion");
	if (!contentVersion.ok) return contentVersion;
	return { ok: true, workId: workId.id, editionId: editionId.id, contentVersion: contentVersion.id };
}

export function parseReadingHistoryRef(raw: unknown): { ok: true; source: ReadingHistorySourceName; id: string } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少历史会话引用", "id");
	const sourceRaw = Reflect.get(raw, "source");
	if (sourceRaw !== "deepread-current" && sourceRaw !== "deepread-legacy") return readingInvalidInput("未知的历史来源", "source");
	const id = parseReadingId(Reflect.get(raw, "id"), "id");
	if (!id.ok) return id;
	return { ok: true, source: sourceRaw, id: id.id };
}

// ── P04：会话绑定入参（绑定键是 workId+editionId 成对，不允许只按 work 猜版本） ─────────────────

/** 绑定定位键：书目与版本都必须合法。 */
export function parseReadingBindingRef(raw: unknown): { ok: true; ref: ReadingBindingRef } | { ok: false; error: ReadingErrorInfo } {
	if (!isRecord(raw)) return readingInvalidInput("缺少绑定的版本引用", "editionId");
	const workId = parseReadingId(Reflect.get(raw, "workId"), "workId");
	if (!workId.ok) return workId;
	const editionId = parseReadingId(Reflect.get(raw, "editionId"), "editionId");
	if (!editionId.ok) return editionId;
	return { ok: true, ref: { workId: workId.id, editionId: editionId.id } };
}

/**
 * 显式绑定入参：sessionId/projectId 只做形态与长度校验；
 * 会话是否真实存在由 Service 查 SessionCatalog 决定（边界层不读会话目录）。
 */
export function parseReadingBindSessionInput(raw: unknown): { ok: true; input: ReadingBindSessionInput } | { ok: false; error: ReadingErrorInfo } {
	const ref = parseReadingBindingRef(raw);
	if (!ref.ok) return ref;
	const record = raw as object;
	const sessionId = parseReadingId(Reflect.get(record, "sessionId"), "sessionId");
	if (!sessionId.ok) return sessionId;
	const projectId = parseReadingId(Reflect.get(record, "projectId"), "projectId");
	if (!projectId.ok) return projectId;
	return { ok: true, input: { workId: ref.ref.workId, editionId: ref.ref.editionId, sessionId: sessionId.id, projectId: projectId.id } };
}
