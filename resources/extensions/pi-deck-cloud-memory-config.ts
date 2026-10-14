/**
 * pi-deck-cloud-memory-config —— 配置/auth 与路径白名单的纯校验层。
 *
 * 为什么不放在 wrapper：路径根、URL 协议、字段形状都能脱离 fs/pi 运行时单测；
 * wrapper 只负责读文件再把原始 JSON 传进来。所有函数无副作用、无网络。
 *
 * 路径根（与 pi 的 getAgentDir 语义对齐）：
 * - `PI_CODING_AGENT_DIR` 是独立验收 profile 的 agent 目录，默认配置/日志优先它；
 * - 未设置时退回 `~/.pi/agent`，同时 `~/.pi` 始终是允许根；
 * - 可选显式应用数据目录作为附加允许根。日志/auth 绝不写到这些根之外。
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_CONFIG_FILE = "pi-deck-cloud-memory.json";
export const DEFAULT_LOG_FILE = "pi-deck-cloud-memory.log.jsonl";

export const MAX_AUTH_TOKEN_CHARS = 4096;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_AUTH_BYTES = 8 * 1024;

export type CloudMemoryMode = "personal" | "project";

/** 配置校验通过后的归一化形态（路径已 resolve，baseUrl 已去尾斜杠）。
 *
 * 同步相关字段是可选扩展：老配置（只有 enabled/baseUrl/authFile/logFile/mode）保持可用，
 * 只读查记忆不依赖账号或实例；syncEnabled 为 true 时账号与云端实例必须齐全。
 */
export type CloudMemoryConfig = {
	baseUrl: string;
	authFile: string;
	logFile: string;
	mode: CloudMemoryMode;
	enabled: true;
	account: string | null;
	cloudInstanceId: string | null;
	stateDir: string | null;
	personaCacheFile: string | null;
	syncEnabled: boolean;
};

export type ConfigEnv = {
	homedir: string;
	/** PI_CODING_AGENT_DIR；未设置时默认 `~/.pi/agent`。 */
	piAgentDir?: string;
	/** 可选显式应用数据目录（附加允许根）。 */
	dataDir?: string;
};

export type ConfigParseResult = { kind: "ok"; config: CloudMemoryConfig } | { kind: "disabled"; reason: string } | { kind: "invalid"; reason: string };
export type AuthTokenResult = { kind: "ok"; token: string } | { kind: "invalid"; reason: string };

/** 第三方/配置文件数据的统一收窄入口；不假设对象里有哪些字段。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function expandHome(value: string, homedir: string): string {
	if (value === "~") return homedir;
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir, value.slice(2));
	return value;
}

/** 与 pi 的 getAgentDir 对齐：优先 PI_CODING_AGENT_DIR，否则 ~/.pi/agent。 */
export function resolveAgentDir(env: ConfigEnv): string {
	const configured = env.piAgentDir?.trim();
	return configured ? resolve(expandHome(configured, env.homedir)) : join(env.homedir, ".pi", "agent");
}

/** 允许读取 auth / 写日志的根：`~/.pi`、agent 目录、可选应用数据目录。 */
export function allowedMemoryRoots(env: ConfigEnv): string[] {
	const roots = [join(env.homedir, ".pi"), resolveAgentDir(env)];
	const dataDir = env.dataDir?.trim();
	if (dataDir && isAbsolute(dataDir)) roots.push(resolve(expandHome(dataDir, env.homedir)));
	return roots;
}

/** child 必须位于 root 之内（含 root 本身）；用 relative 判定，跨盘/越级都拒绝。 */
export function isPathWithin(childPath: string, rootPath: string): boolean {
	const rel = relative(resolve(rootPath), resolve(childPath));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** baseUrl 只允许 https 或回环 http；禁止 query/hash/凭据，避免把认证转发到别的语义端点。 */
function parseBaseUrl(value: unknown): { ok: true; baseUrl: string } | { ok: false; reason: string } {
	if (typeof value !== "string" || value.trim() === "") return { ok: false, reason: "config_base_url_missing" };
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, reason: "config_base_url_invalid" };
	}
	if (url.username || url.password) return { ok: false, reason: "config_base_url_credentials" };
	if (url.search || url.hash) return { ok: false, reason: "config_base_url_query" };
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
		return { ok: false, reason: "config_base_url_scheme" };
	}
	return { ok: true, baseUrl: trimmed.replace(/\/+$/, "") };
}

function parseAbsolutePath(value: unknown, field: "auth" | "log", env: ConfigEnv): { ok: true; path: string } | { ok: false; reason: string } {
	if (typeof value !== "string" || value.trim() === "") return { ok: false, reason: `config_${field}_file_missing` };
	const trimmed = value.trim();
	if (!isAbsolute(trimmed)) return { ok: false, reason: `config_${field}_file_relative` };
	const resolved = resolve(trimmed);
	if (!allowedMemoryRoots(env).some((root) => isPathWithin(resolved, root))) {
		return { ok: false, reason: `config_${field}_file_outside_allowed_roots` };
	}
	return { ok: true, path: resolved };
}

/** 账号/实例标识：不接收任意文本，避免把正文回显进路径或日志。 */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9._:@+-]{1,256}$/;

export function isAccountId(value: unknown): value is string {
	return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

function parseAccountId(value: unknown, field: "account" | "cloud_instance"): { ok: true; id: string | null } | { ok: false; reason: string } {
	if (value === undefined || value === null) return { ok: true, id: null };
	if (!isAccountId(value)) return { ok: false, reason: `config_${field}_invalid` };
	return { ok: true, id: value };
}

/** fail-closed：缺字段/越权路径/非回环 http 一律 invalid；enabled:false 归为 disabled。 */
export function parseCloudMemoryConfig(raw: unknown, env: ConfigEnv): ConfigParseResult {
	if (!isRecord(raw) || Array.isArray(raw)) return { kind: "invalid", reason: "config_not_object" };
	const record = raw;
	if (record.enabled === false) return { kind: "disabled", reason: "config_disabled" };
	if (record.enabled !== true) return { kind: "invalid", reason: "config_enabled_required" };
	if (record.mode !== "personal" && record.mode !== "project") return { kind: "invalid", reason: "config_mode_invalid" };

	const baseUrl = parseBaseUrl(record.baseUrl);
	if (!baseUrl.ok) return { kind: "invalid", reason: baseUrl.reason };
	const authFile = parseAbsolutePath(record.authFile, "auth", env);
	if (!authFile.ok) return { kind: "invalid", reason: authFile.reason };
	const logFile = parseAbsolutePath(record.logFile, "log", env);
	if (!logFile.ok) return { kind: "invalid", reason: logFile.reason };

	const account = parseAccountId(record.account, "account");
	if (!account.ok) return { kind: "invalid", reason: account.reason };
	const cloudInstanceId = parseAccountId(record.cloudInstanceId, "cloud_instance");
	if (!cloudInstanceId.ok) return { kind: "invalid", reason: cloudInstanceId.reason };

	// stateDir / personaCacheFile 与 auth/log 同规则：绝对路径且位于允许根内。
	const syncEnabledRaw = record.syncEnabled;
	if (syncEnabledRaw !== undefined && typeof syncEnabledRaw !== "boolean") return { kind: "invalid", reason: "config_sync_enabled_invalid" };
	const syncEnabled = syncEnabledRaw === true;

	let stateDir: string | null = null;
	if (record.stateDir !== undefined && record.stateDir !== null) {
		if (typeof record.stateDir !== "string" || record.stateDir.trim() === "") return { kind: "invalid", reason: "config_state_dir_missing" };
		if (!isAbsolute(record.stateDir.trim())) return { kind: "invalid", reason: "config_state_dir_relative" };
		const resolved = resolve(record.stateDir.trim());
		if (!allowedMemoryRoots(env).some((root) => isPathWithin(resolved, root))) return { kind: "invalid", reason: "config_state_dir_outside_allowed_roots" };
		stateDir = resolved;
	}

	let personaCacheFile: string | null = null;
	if (record.personaCacheFile !== undefined && record.personaCacheFile !== null) {
		if (typeof record.personaCacheFile !== "string" || record.personaCacheFile.trim() === "") return { kind: "invalid", reason: "config_persona_cache_missing" };
		if (!isAbsolute(record.personaCacheFile.trim())) return { kind: "invalid", reason: "config_persona_cache_relative" };
		const resolved = resolve(record.personaCacheFile.trim());
		if (!allowedMemoryRoots(env).some((root) => isPathWithin(resolved, root))) return { kind: "invalid", reason: "config_persona_cache_outside_allowed_roots" };
		personaCacheFile = resolved;
	}

	// 同步必须同时绑定账号与云端实例：否则不得开启（不是静默降级，避免把 A 的内容发到 B）。
	if (syncEnabled && (account.id === null || cloudInstanceId.id === null)) return { kind: "invalid", reason: "config_sync_requires_account_instance" };

	return {
		kind: "ok",
		config: {
			baseUrl: baseUrl.baseUrl,
			authFile: authFile.path,
			logFile: logFile.path,
			mode: record.mode,
			enabled: true,
			account: account.id,
			cloudInstanceId: cloudInstanceId.id,
			stateDir,
			personaCacheFile,
			syncEnabled,
		},
	};
}

/** auth 文件只保存用户会话 token；不自动登录、不接收密码、不做任何刷新/写入。 */
export function parseAuthToken(raw: unknown): AuthTokenResult {
	if (!isRecord(raw) || Array.isArray(raw)) return { kind: "invalid", reason: "auth_not_object" };
	const token = raw.token;
	if (typeof token !== "string" || token.trim() === "") return { kind: "invalid", reason: "auth_token_missing" };
	if (/[\r\n]/.test(token)) return { kind: "invalid", reason: "auth_token_invalid" };
	if (token.length > MAX_AUTH_TOKEN_CHARS) return { kind: "invalid", reason: "auth_token_too_long" };
	return { kind: "ok", token: token.trim() };
}
