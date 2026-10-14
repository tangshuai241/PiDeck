/**
 * 阅读 HTTP 客户端（P03）：唯一出口是主进程 fetch，只访问回环 DeepRead。
 *
 * 边界与 cloudMemoryClient 同源纪律：
 * - baseUrl 由服务层校验后传入（回环 http/https），请求固定 origin + 固定路径，`redirect: "manual"`；
 * - 响应流式有界：逐块累加字节数，超上限立即 cancel；JSON 解析失败按服务端异常处理；
 * - 超时 + AbortController；dispose 中止在飞请求，之后一律 unavailable；
 * - cookie（deepread_auth）只在内存与受保护凭据文件里，绝不进状态/日志/渲染层；
 * - 错误只暴露固定分类（401→needsConnection；新接口 404/405/501→unsupported），不回显服务端文本。
 */

import { clearTimeout, setTimeout } from "node:timers";
import { READING_DEFAULT_BASE_URL, type ReadingErrorInfo } from "../../../shared/types/reading";
import type { ReadingFetch, ReadingHttpResponse, ReadingHttpResult, ReadingHistoryPageQuery, ReadingRequestOptions, ReadingWireFeature } from "./readingHttpClientTypes";
import { buildHistoryQuery, buildHistorySessionQuery, mapReadingHttpError } from "./readingWire";

export const READING_DEFAULT_TIMEOUT_MS = 10_000;
export const READING_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const READING_CHAPTER_MAX_BYTES = 8 * 1024 * 1024;
export const READING_HISTORY_SESSION_MAX_BYTES = 4 * 1024 * 1024;
const LOGIN_MAX_BYTES = 64 * 1024;

export type ReadingHttpClientDeps = { fetchImpl: ReadingFetch; timeoutMs?: number; maxBytes?: number };

export type ReadingLoginOutcome = { ok: true; authRequired: boolean } | { ok: false; error: ReadingErrorInfo };

export type ReadingHttpClient = {
	getBaseUrl(): string;
	hasCookie(): boolean;
	setBaseUrl(baseUrl: string): void;
	login(baseUrl: string, password: string): Promise<ReadingLoginOutcome>;
	clearSession(): void;
	probe(): Promise<ReadingHttpResult>;
	listBooks(): Promise<ReadingHttpResult>;
	catalog(): Promise<ReadingHttpResult>;
	getEdition(rel: string): Promise<ReadingHttpResult>;
	getChapter(rel: string, chapter: string): Promise<ReadingHttpResult>;
	resolveQuote(rel: string, text: string, chapterHref: string | null, expectedVersion: string): Promise<ReadingHttpResult>;
	listNotes(workId: string, editionId: string): Promise<ReadingHttpResult>;
	readNote(noteId: string): Promise<ReadingHttpResult>;
	writeNote(body: Record<string, unknown>): Promise<ReadingHttpResult>;
	/** 写请求对账（只读）：返回丢失后查原 request 的实际状态，不触发重放写。 */
	noteRequest(requestId: string): Promise<ReadingHttpResult>;
	historySources(): Promise<ReadingHttpResult>;
	listHistory(query: ReadingHistoryPageQuery): Promise<ReadingHttpResult>;
	readHistorySession(source: string, id: string): Promise<ReadingHttpResult>;
	dispose(): void;
};

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 有界读取：超过上限立即 cancel。 */
async function readBoundedBody(response: ReadingHttpResponse, maxBytes: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = (await response.text?.()) ?? "";
		return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
	}
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

/** 从 set-cookie 里取 deepread_auth（可能与其他 cookie 合并在一行）。 */
export function extractReadingCookie(setCookie: string | null): string | null {
	if (!setCookie) return null;
	const match = /(?:^|[,;]\s*)deepread_auth=([^;,\s]+)/.exec(setCookie);
	return match ? match[1] : null;
}

export function createReadingHttpClient(deps: ReadingHttpClientDeps): ReadingHttpClient {
	const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : READING_DEFAULT_TIMEOUT_MS;
	const defaultMaxBytes = deps.maxBytes && deps.maxBytes > 0 ? deps.maxBytes : READING_DEFAULT_MAX_BYTES;
	let baseUrl = READING_DEFAULT_BASE_URL;
	let cookie: string | null = null;
	let disposed = false;
	const inflight = new Set<AbortController>();

	async function request(path: string, init: { method: string; body?: string; contentType?: string; options?: ReadingRequestOptions }): Promise<ReadingHttpResult> {
		if (disposed) return { ok: false, status: null, error: { code: "unavailable", message: "阅读客户端已停止" } };
		const options = init.options ?? {};
		const maxBytes = options.maxBytes ?? defaultMaxBytes;
		const controller = new AbortController();
		inflight.add(controller);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const headers: Record<string, string> = {};
		if (init.contentType) headers["content-type"] = init.contentType;
		if (cookie) headers.cookie = `deepread_auth=${cookie}`;
		try {
			const response = await deps.fetchImpl(`${baseUrl}${path}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", signal: controller.signal });
			const setCookie = response.headers?.get?.("set-cookie") ?? null;
			let text: string | null;
			try {
				text = await readBoundedBody(response, maxBytes);
			} catch {
				return { ok: false, status: response.status, error: mapReadingHttpError({ status: null, json: null, feature: options.feature ?? null }) };
			}
			if (text === null) return { ok: false, status: response.status, error: { code: "internalError", message: "阅读服务响应超出上限", detail: { status: response.status } } };
			let json: unknown = null;
			try {
				json = text ? (JSON.parse(text) as unknown) : null;
			} catch {
				json = null;
			}
			if (response.status < 200 || response.status >= 300) return { ok: false, status: response.status, error: mapReadingHttpError({ status: response.status, json, feature: options.feature ?? null }) };
			return { ok: true, status: response.status, json, text, setCookie };
		} catch {
			// 超时/连接失败：都归 unavailable（结果未知，但读接口无副作用）
			return { ok: false, status: null, error: mapReadingHttpError({ status: null, json: null, feature: options.feature ?? null }) };
		} finally {
			clearTimeout(timer);
			inflight.delete(controller);
		}
	}

	function feature(featureName: ReadingWireFeature): ReadingRequestOptions {
		return { feature: featureName };
	}

	return {
		getBaseUrl: () => baseUrl,
		hasCookie: () => cookie !== null,
		setBaseUrl: (next) => {
			baseUrl = next;
		},
		clearSession: () => {
			cookie = null;
		},
		async login(target, password) {
			if (disposed) return { ok: false, error: { code: "unavailable", message: "阅读客户端已停止" } };
			const controller = new AbortController();
			inflight.add(controller);
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await deps.fetchImpl(`${target}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password, next: "/" }).toString(), redirect: "manual", signal: controller.signal });
				const setCookie = response.headers?.get?.("set-cookie") ?? null;
				const location = response.headers?.get?.("location") ?? "";
				try {
					await readBoundedBody(response, LOGIN_MAX_BYTES);
				} catch {
					// 登录响应体内容无关紧要；读失败不影响判定
				}
				const token = extractReadingCookie(setCookie);
				if (token) {
					baseUrl = target;
					cookie = token;
					return { ok: true, authRequired: true };
				}
				// 未下发 cookie：服务未启用密码（重定向回首页）视为已连接；带 error=1 或非 3xx 视为登录未通过
				const redirectedHome = response.status >= 300 && response.status < 400 && !location.includes("error=1");
				if (redirectedHome || response.status === 200) {
					baseUrl = target;
					cookie = null;
					return { ok: true, authRequired: false };
				}
				return { ok: false, error: { code: "needsConnection", message: "登录未通过，请检查密码", detail: { status: response.status, reason: "loginRejected" } } };
			} catch {
				return { ok: false, error: mapReadingHttpError({ status: null, json: null, feature: null }) };
			} finally {
				clearTimeout(timer);
				inflight.delete(controller);
			}
		},
		probe: () => request("/api/books", { method: "GET" }),
		listBooks: () => request("/api/books", { method: "GET" }),
		catalog: () => request("/api/catalog", { method: "GET", options: { maxBytes: defaultMaxBytes } }),
		getEdition: (rel) => request(`/api/books/reader-meta?book=${encodeURIComponent(rel)}`, { method: "GET" }),
		getChapter: (rel, chapter) => request(`/api/books/content?book=${encodeURIComponent(rel)}&chapter=${encodeURIComponent(chapter)}`, { method: "GET", options: { maxBytes: READING_CHAPTER_MAX_BYTES } }),
		resolveQuote: (rel, text, chapterHref, expectedVersion) =>
			request("/api/books/resolve-quote", {
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ book: rel, text, ...(chapterHref ? { chapter_href: chapterHref } : {}), expected_version: expectedVersion }),
				options: { maxBytes: defaultMaxBytes },
			}),
		listNotes: (workId, editionId) => request(`/api/notes/by-work?work_id=${encodeURIComponent(workId)}&edition_id=${encodeURIComponent(editionId)}`, { method: "GET", options: feature("notes") }),
		readNote: (noteId) => request(`/api/notes/read?note_id=${encodeURIComponent(noteId)}`, { method: "GET", options: feature("notes") }),
		writeNote: (body) => request("/api/notes/write", { method: "POST", contentType: "application/json", body: JSON.stringify(body), options: feature("notes") }),
		noteRequest: (requestId) => request(`/api/notes/request?request_id=${encodeURIComponent(requestId)}`, { method: "GET", options: feature("notes") }),
		historySources: () => request("/api/history/sources", { method: "GET", options: feature("history") }),
		listHistory: (query) => request(`/api/history/sessions?${buildHistoryQuery(query)}`, { method: "GET", options: feature("history") }),
		readHistorySession: (source, id) => request(`/api/history/session?${buildHistorySessionQuery(source, id)}`, { method: "GET", options: { ...feature("history"), maxBytes: READING_HISTORY_SESSION_MAX_BYTES } }),
		dispose: () => {
			disposed = true;
			for (const controller of inflight) controller.abort();
			inflight.clear();
		},
	};
}
