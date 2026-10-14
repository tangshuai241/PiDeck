/**
 * 云端记忆（N04）纯校验层：URL、登录入参、服务端主体与人格哈希。
 *
 * 为什么独立：这些判定必须能脱离 Electron / fs / fetch 单测——它们决定「什么算合法
 * 连接」「什么算同一个人格版本」，一旦混进 IO 就只能靠集成测试兜底。
 *
 * 边界：
 * - 只允许 https，或 http 回环（本地隔离实例）；不接受 query/hash/内嵌凭据，
 *   避免把认证请求转发到别的语义端点。
 * - 人格 revision 复刻云端 domain-store.js 的口径：sha256(JSON.stringify([text, enabled]))；
 *   业务 revision 用 normalizeText 后的文本，raw_revision 用原稿文本。
 * - 本模块不产生任何日志，输入里的密码不落任何持久结构（调用方负责只在需要时传入）。
 */

import { createHash } from "node:crypto";
import type { CloudMemoryConnectInput, CloudMemoryErrorInfo, CloudMemoryPersonaSnapshot, CloudMemorySyncMode } from "../../shared/types/cloudMemory";

export const MAX_BASE_URL_CHARS = 2048;
export const MAX_ACCOUNT_CHARS = 128;
export const MAX_PASSWORD_CHARS = 512;

function fail(code: CloudMemoryErrorInfo["code"], message: string): { ok: false; error: CloudMemoryErrorInfo } {
	return { ok: false, error: { code, message } };
}

function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** baseUrl 白名单：https 或 http 回环；去掉尾斜杠，保留 origin（路径/查询一律拒绝）。 */
export function normalizeCloudMemoryBaseUrl(value: unknown): { ok: true; baseUrl: string } | { ok: false; error: CloudMemoryErrorInfo } {
	if (typeof value !== "string" || !value.trim()) return fail("invalidBaseUrl", "请填写云端地址");
	const trimmed = value.trim();
	if (trimmed.length > MAX_BASE_URL_CHARS) return fail("invalidBaseUrl", "云端地址过长");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return fail("invalidBaseUrl", "云端地址不是合法 URL");
	}
	if (url.username || url.password) return fail("invalidBaseUrl", "云端地址不能包含账号或密码");
	if (url.search || url.hash) return fail("invalidBaseUrl", "云端地址不能带查询参数或片段");
	if (url.pathname !== "/" && url.pathname !== "") return fail("invalidBaseUrl", "云端地址只填到主机名，不要带路径");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
		return fail("invalidBaseUrl", "云端地址只允许 https，或本机回环 http");
	}
	return { ok: true, baseUrl: url.origin };
}

export function normalizeAccount(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_ACCOUNT_CHARS) return null;
	if (/[\r\n\t]/.test(trimmed)) return null;
	return trimmed;
}

/** 密码只做长度与换行校验，不做 trim（前后空格可能是密码的一部分）。 */
export function sanitizeCloudMemoryPassword(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	if (value.length > MAX_PASSWORD_CHARS) return null;
	if (/[\r\n]/.test(value)) return null;
	return value;
}

export function parseSyncMode(value: unknown): CloudMemorySyncMode | null {
	return value === "personal" || value === "project" ? value : null;
}

/**
 * 云实例标识：规范化 baseUrl 的完整 SHA-256。
 *
 * 为什么不叫服务器 UUID：现有 whoami/instance 响应没有稳定的实例 UUID，本首版只用
 * 「规范化地址」作为本地连接身份，不虚称服务器标识。地址变化（含端口/协议）即换隔离键，
 * 缓存/队列/人格都绑定该值，旧状态不会复用到新地址。
 */
export function cloudInstanceIdFromOrigin(baseUrl: string): string {
	return createHash("sha256").update(baseUrl).digest("hex");
}

/** IPC 边界：渲染层数据一律不可信，逐字段校验并归一。 */
export function parseCloudMemoryConnectInput(value: unknown): { ok: true; input: CloudMemoryConnectInput } | { ok: false; error: CloudMemoryErrorInfo } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("invalidInput", "连接参数不完整");
	// 未知 JSON 收窄成 object 后一律用 Reflect 读字段（不用 as 绕过类型）
	const record: object = value;
	const baseUrl = normalizeCloudMemoryBaseUrl(Reflect.get(record, "baseUrl"));
	if (!baseUrl.ok) return baseUrl;
	const account = normalizeAccount(Reflect.get(record, "account"));
	if (!account) return fail("invalidInput", "请填写云端账号");
	const password = sanitizeCloudMemoryPassword(Reflect.get(record, "password"));
	if (!password) return fail("invalidInput", "请填写云端密码");
	const syncMode = parseSyncMode(Reflect.get(record, "syncMode"));
	if (!syncMode) return fail("invalidInput", "同步模式不合法");
	const rememberSignIn = Reflect.get(record, "rememberSignIn");
	if (typeof rememberSignIn !== "boolean") return fail("invalidInput", "记住登录的取值不合法");
	return { ok: true, input: { baseUrl: baseUrl.baseUrl, account, password, syncMode, rememberSignIn } };
}

/** 人格业务文本口径（与云端 normalizeText 一致）：CRLF 归一、去首尾空白。 */
export function normalizePersonaText(raw: unknown): string {
	return String(raw === undefined || raw === null ? "" : raw)
		.replace(/\r\n/g, "\n")
		.trim();
}

export function personaRevisionOf(text: string, enabled: boolean): string {
	return createHash("sha256")
		.update(JSON.stringify([text, enabled]))
		.digest("hex");
}

export function personaRawRevisionOf(rawText: string, enabled: boolean): string {
	return createHash("sha256")
		.update(JSON.stringify([rawText, enabled]))
		.digest("hex");
}

/**
 * 缓存前的完整性校验：用本地复刻的哈希算法回算两个 revision。
 *
 * 云端 text 是 normalizeText 后的业务文本，original_text 是原稿；只有两个哈希都对上
 * 才允许写缓存——否则宁可丢弃这份响应，也不能把来源不明的人格稿当「已确认版本」。
 */
export function verifyPersonaSnapshot(snapshot: Pick<CloudMemoryPersonaSnapshot, "text" | "originalText" | "enabled" | "revision" | "rawRevision">): boolean {
	if (typeof snapshot.text !== "string" || typeof snapshot.originalText !== "string") return false;
	if (typeof snapshot.revision !== "string" || typeof snapshot.rawRevision !== "string") return false;
	if (snapshot.revision !== personaRevisionOf(snapshot.text, snapshot.enabled)) return false;
	return snapshot.rawRevision === personaRawRevisionOf(snapshot.originalText, snapshot.enabled);
}

/**
 * whoami 校验：服务端返回的主体必须与输入账号一致、是用户（不是设备凭据），
 * 且具备个人资料域所需的 memory 作用域。校验不通过就不允许保存连接。
 */
export function validateCloudPrincipal(payload: unknown, expectedAccount: string): { ok: true; account: string; scopes: string[] } | { ok: false; error: CloudMemoryErrorInfo } {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fail("principalMismatch", "云端未返回有效账号信息");
	const record: object = payload;
	const kind = Reflect.get(record, "kind");
	if (kind !== "user") return fail("principalMismatch", "云端返回的主体不是用户会话");
	const username = normalizeAccount(Reflect.get(record, "username"));
	if (!username || username !== expectedAccount) return fail("principalMismatch", "云端返回的账号与输入不一致");
	const rawScopes = Reflect.get(record, "scopes");
	const scopes = Array.isArray(rawScopes) ? rawScopes.filter((scope): scope is string => typeof scope === "string") : [];
	if (!scopes.includes("memory")) return fail("scopeMissing", "该账号缺少记忆作用域（memory）");
	return { ok: true, account: username, scopes };
}
