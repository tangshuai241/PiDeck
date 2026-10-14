/**
 * 云端记忆 HTTP 客户端：只实现 N04 需要的四个端点（login / whoami / logout / persona GET）。
 *
 * 设计边界：
 * - origin 由调用方在白名单校验后传入（https 或回环 http）；请求固定 origin + 固定路径，
 *   `redirect: "manual"` —— 跟随重定向会绕开 origin 白名单。
 * - 响应真流式有界：逐块累加字节数，超上限立即 cancel 并报错，不把整个 body 读进内存再判长度。
 * - 不重试、不排队、不缓存；「重登一次」策略由 Service 决定（网络错误不重试）。
 * - 错误只暴露固定分类与 HTTP status；**不回显服务端 error.message**（防止把
 *   服务端细节、令牌回显或注入文本带进日志/界面）。
 * - fetch 与超时都注入，纯 Node 测试不需要真实网络。
 */

import type { CloudMemoryErrorInfo } from "../../shared/types/cloudMemory";

const DEFAULT_TIMEOUT_MS = 10_000;
/** 响应体字节上限：人格正文与账号信息都在几十 KB 内，超限按服务端异常处理。 */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** 有界读取所需的响应形状（fetch 返回值的最小子集；`body` 缺省时回退 text()）。 */
export type CloudMemoryFetchResponse = {
	status: number;
	text?: () => Promise<string>;
	body?: {
		getReader: () => {
			read: () => Promise<{ done: boolean; value?: Uint8Array }>;
			cancel: () => Promise<void>;
		};
	} | null;
};

export type CloudMemoryFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal }) => Promise<CloudMemoryFetchResponse>;

export type CloudMemoryLoginResult = { token: string; account: string; scopes: string[] };

export type CloudMemoryClientDeps = {
	/** 注入 fetch（主进程用全局 fetch；测试用替身）。 */
	fetchImpl: CloudMemoryFetch;
	timeoutMs?: number;
};

type RequestOutcome = { ok: true; status: number; json: unknown } | { ok: false; error: CloudMemoryErrorInfo };

/** 固定分类文案：不拼接服务端文本，调用方/渲染层按 code 走各自的词典。 */
function statusError(status: number): CloudMemoryErrorInfo {
	if (status === 401) return { code: "unauthorized", message: "云端会话已失效" };
	if (status === 403) return { code: "scopeMissing", message: "该账号缺少所需权限" };
	return { code: "internalError", message: `云端返回 ${status}`, detail: { status } };
}

/**
 * 有界读取响应体：流式读，累计字节数超过上限立即 cancel。
 * 返回 false 表示超限（调用方按 internalError 处理），不把超限体交给 JSON 解析。
 */
async function readBoundedBody(response: CloudMemoryFetchResponse): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) {
		// 替身/旧实现只有 text()：仍做长度判断，但不声称是流式上界
		const text = (await response.text?.()) ?? "";
		return Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES ? null : text;
	}
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

export function createCloudMemoryClient(deps: CloudMemoryClientDeps) {
	const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
	const fetchImpl = deps.fetchImpl;

	async function request(origin: string, path: string, init: { method: string; token?: string; body?: unknown }): Promise<RequestOutcome> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (init.token) headers.authorization = `Bearer ${init.token}`;
		try {
			const response = await fetchImpl(`${origin}${path}`, {
				method: init.method,
				headers,
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				redirect: "manual",
				signal: controller.signal,
			});
			let text: string | null;
			try {
				text = await readBoundedBody(response);
			} catch {
				return { ok: false, error: { code: "offline", message: "读取云端响应失败" } };
			}
			if (text === null) return { ok: false, error: { code: "internalError", message: "云端响应超出上限" } };
			let json: unknown = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				json = null;
			}
			if (response.status < 200 || response.status >= 300) return { ok: false, error: statusError(response.status) };
			return { ok: true, status: response.status, json };
		} catch {
			// 网络不可达、DNS 失败、超时中止都归为 offline：调用方据此保留缓存并标状态。
			return { ok: false, error: { code: "offline", message: "云端不可达" } };
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		/** 登录：返回本次会话 token（调用方决定是否加密留存）。 */
		async login(origin: string, account: string, password: string): Promise<{ ok: true; session: CloudMemoryLoginResult } | { ok: false; error: CloudMemoryErrorInfo }> {
			const outcome = await request(origin, "/api/cloud/auth/login", { method: "POST", body: { username: account, password } });
			if (!outcome.ok) return outcome;
			const json = outcome.json;
			if (typeof json !== "object" || json === null) return { ok: false, error: { code: "principalMismatch", message: "登录响应缺少会话信息" } };
			const token = Reflect.get(json, "token");
			if (typeof token !== "string" || !token.trim()) return { ok: false, error: { code: "principalMismatch", message: "登录成功但未返回会话 token" } };
			const scopesRaw = Reflect.get(json, "scopes");
			const scopes = Array.isArray(scopesRaw) ? scopesRaw.filter((scope): scope is string => typeof scope === "string") : [];
			return { ok: true, session: { token: token.trim(), account, scopes } };
		},

		/** whoami：返回原始载荷，主体校验（kind/username/scopes）在纯校验层完成。 */
		async whoami(origin: string, token: string): Promise<{ ok: true; payload: unknown } | { ok: false; error: CloudMemoryErrorInfo }> {
			const outcome = await request(origin, "/api/cloud/auth/whoami", { method: "GET", token });
			return outcome.ok ? { ok: true, payload: outcome.json } : outcome;
		},

		async logout(origin: string, token: string): Promise<{ ok: true } | { ok: false; error: CloudMemoryErrorInfo }> {
			const outcome = await request(origin, "/api/cloud/auth/logout", { method: "POST", token });
			return outcome.ok ? { ok: true } : outcome;
		},

		/** 人格 GET：云端已发布版本；不放 PUT（发布入口在现有云端 UI，本地不建第二真源）。 */
		async persona(origin: string, token: string): Promise<{ ok: true; payload: unknown } | { ok: false; error: CloudMemoryErrorInfo }> {
			const outcome = await request(origin, "/api/cloud/persona", { method: "GET", token });
			return outcome.ok ? { ok: true, payload: outcome.json } : outcome;
		},
	};
}

export type CloudMemoryClient = ReturnType<typeof createCloudMemoryClient>;
