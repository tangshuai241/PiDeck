/**
 * pi-deck-cloud-memory-runtime-config —— N04 显式 env 与运行时 profile 解析（纯函数 + 注入式读取）。
 *
 * 桌面端 spawn 时注入 `PIDECK_CLOUD_MEMORY_CONFIG`（配置文件绝对路径）与
 * `PIDECK_CLOUD_MEMORY_DATA_DIR`（应用数据目录）；扩展不猜用户目录，也不新增第二条通信通道：
 * 这里只解析路径并校验允许根，然后读桌面临时投影出来的配置/令牌文件。
 *
 * 规则（fail-safe，不静默越权）：
 * - CONFIG 必须是绝对路径且位于允许根（agent 目录、`~/.pi`、显式 DATA_DIR）内；不合法则记问题并回退默认位置；
 * - DATA_DIR 必须是绝对路径；作为附加允许根，同时是 stateDir / 人格缓存的默认根；
 * - 老部署（只有 PI_CODING_AGENT_DIR）继续按 `~/.pi/agent/<默认文件名>` 工作。
 */

import { isAbsolute, join, resolve } from "node:path";
import { allowedMemoryRoots, DEFAULT_CONFIG_FILE, DEFAULT_LOG_FILE, isAccountId, isPathWithin, parseAuthToken, parseCloudMemoryConfig, resolveAgentDir, type CloudMemoryConfig, type ConfigEnv } from "./pi-deck-cloud-memory-config";

export const ENV_CONFIG_FILE = "PIDECK_CLOUD_MEMORY_CONFIG";
export const ENV_DATA_DIR = "PIDECK_CLOUD_MEMORY_DATA_DIR";

export const MAX_CONFIG_READ_BYTES = 256 * 1024;
export const MAX_AUTH_READ_BYTES = 16 * 1024;
export const MAX_PERSONA_READ_BYTES = 256 * 1024;

/** 冲突防护：account 段由 sync outbox 的 safeSegment 编码后不会等于这个下划线开头名。 */
export const LOCAL_STATE_DIR_NAME = "_local";

export type RuntimeEnvInput = { homedir: string; env?: Record<string, string | undefined> };

export type RuntimeProfileResolution = {
	/** 传给配置校验器的允许根环境（含显式 DATA_DIR）。 */
	env: ConfigEnv;
	/** 配置文件绝对路径（显式 env 或 agent 目录默认位置）。 */
	configFile: string;
	source: "pideck-config" | "agent-dir";
	/** 可读的路径问题（相对/越界）；不阻断回退，但会进状态与日志。 */
	problems: string[];
};

function expandHome(value: string, homedir: string): string {
	if (value === "~") return homedir;
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir, value.slice(2));
	return value;
}

function envValue(env: Record<string, string | undefined> | undefined, name: string): string | null {
	const raw = env?.[name];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed === "" ? null : trimmed;
}

/** 解析 N04 env：数据目录成为附加允许根；显式配置路径必须在允许根内。 */
export function resolveRuntimeProfile(input: RuntimeEnvInput): RuntimeProfileResolution {
	const problems: string[] = [];
	const homedir = input.homedir;

	let dataDir: string | undefined;
	const rawDataDir = envValue(input.env, ENV_DATA_DIR);
	if (rawDataDir !== null) {
		const expanded = expandHome(rawDataDir, homedir);
		if (!isAbsolute(expanded)) problems.push("env_data_dir_relative");
		else dataDir = resolve(expanded);
	}

	const piAgentDir = envValue(input.env, "PI_CODING_AGENT_DIR") ?? undefined;
	const env: ConfigEnv = dataDir ? { homedir, piAgentDir, dataDir } : piAgentDir ? { homedir, piAgentDir } : { homedir };

	const rawConfig = envValue(input.env, ENV_CONFIG_FILE);
	let configFile = join(resolveAgentDir(env), DEFAULT_CONFIG_FILE);
	let source: RuntimeProfileResolution["source"] = "agent-dir";
	if (rawConfig !== null) {
		const expanded = expandHome(rawConfig, homedir);
		if (!isAbsolute(expanded)) {
			problems.push("env_config_file_relative");
		} else {
			const resolved = resolve(expanded);
			if (!allowedMemoryRoots(env).some((root) => isPathWithin(resolved, root))) {
				problems.push("env_config_file_outside_allowed_roots");
			} else {
				configFile = resolved;
				source = "pideck-config";
			}
		}
	}

	return { env, configFile, source, problems };
}

/** stateDir 默认根：显式 DATA_DIR 优先，否则 agent 目录下的 cloud-memory 子目录。 */
export function defaultStateDir(env: ConfigEnv): string {
	if (env.dataDir && env.dataDir.trim() !== "") return resolve(env.dataDir);
	return join(resolveAgentDir(env), "cloud-memory");
}

export function defaultPersonaCacheFile(env: ConfigEnv): string {
	return join(defaultStateDir(env), "persona-cache.json");
}

/** 默认观测日志路径（配置不可读时也要能找到 profile 内的位置）。 */
export function defaultLogFileFor(input: RuntimeEnvInput): string {
	return join(resolveAgentDir(resolveRuntimeProfile(input).env), DEFAULT_LOG_FILE);
}

/** 采集本地状态目录（设备 id、事件游标）；用下划线开头避免与账号段碰撞。 */
export function localStateDir(stateDir: string): string {
	return join(stateDir, LOCAL_STATE_DIR_NAME);
}

export function deviceFile(stateDir: string): string {
	return join(localStateDir(stateDir), "device.json");
}

export function captureStateDir(stateDir: string): string {
	return join(localStateDir(stateDir), "capture");
}

/** safeSegment 会把下划线开头、超长或含非法字符的名字编码，因此文件名可安全承载会话 id。 */
export function safeFileSegment(value: string): string {
	if (value !== "." && value !== ".." && !value.endsWith(".") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return value;
	return `b64_${Buffer.from(value, "utf8").toString("base64url")}`;
}

export type ReadTextPort = (path: string, maxBytes: number) => Promise<{ kind: "ok"; text: string } | { kind: "missing" } | { kind: "invalid"; reason: string }>;

/** auth 文件绑定：C 从 N04 起写 account/cloudInstanceId，工具侧必须核对，不能只看 token。 */
export type AuthBinding = { kind: "bound"; accountId: string; cloudInstanceId: string } | { kind: "token_only" };
export type AuthFileResult = { kind: "ok"; token: string; binding: AuthBinding } | { kind: "invalid"; reason: string };

/**
 * 解析 auth.json：token 必填；account/cloudInstanceId 要么都缺（旧只读 token-only），
 * 要么都是合法标识符（绑定）。只给一个视为不完整绑定，宁可拒绝也不猜。
 */
export function parseAuthFile(raw: unknown): AuthFileResult {
	const token = parseAuthToken(raw);
	if (token.kind !== "ok") return { kind: "invalid", reason: token.reason };
	if (!isRecord(raw)) return { kind: "invalid", reason: "auth_not_object" };
	const account = raw.account;
	const cloudInstanceId = raw.cloudInstanceId;
	const hasAccount = account !== undefined && account !== null;
	const hasInstance = cloudInstanceId !== undefined && cloudInstanceId !== null;
	if (!hasAccount && !hasInstance) return { kind: "ok", token: token.token, binding: { kind: "token_only" } };
	if (!hasAccount || !hasInstance) return { kind: "invalid", reason: "auth_binding_incomplete" };
	if (!isAccountId(account)) return { kind: "invalid", reason: "auth_account_invalid" };
	if (!isAccountId(cloudInstanceId)) return { kind: "invalid", reason: "auth_instance_invalid" };
	return { kind: "ok", token: token.token, binding: { kind: "bound", accountId: account, cloudInstanceId } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RuntimeProfile = {
	configFile: string;
	config: CloudMemoryConfig;
	token: string;
	/** 已核对的 auth 绑定（token_only 表示旧配置，未声明 owner）。 */
	authBinding: AuthBinding;
	/** 同步用状态目录（显式配置或默认根）。 */
	stateDir: string;
	/** 人格缓存文件（显式配置或默认位置）。 */
	personaCacheFile: string;
	/** 路径解析问题（例如 env 越界回退）；调用方据此标记状态。 */
	problems: string[];
};

export type ProfileLoadResult = { kind: "ok"; profile: RuntimeProfile } | { kind: "missing" } | { kind: "disabled"; reason: string } | { kind: "invalid"; reason: string };

/** 惰性读取（只在工具执行 / 回合开始时调用），永不联网。 */
export function createRuntimeProfileLoader(options: { input: RuntimeEnvInput; readText: ReadTextPort }): { load: () => Promise<ProfileLoadResult> } {
	const resolution = resolveRuntimeProfile(options.input);

	async function load(): Promise<ProfileLoadResult> {
		const configRead = await options.readText(resolution.configFile, MAX_CONFIG_READ_BYTES);
		if (configRead.kind === "missing") return { kind: "missing" };
		if (configRead.kind === "invalid") return { kind: "invalid", reason: "config_read_failed" };
		let raw: unknown;
		try {
			raw = JSON.parse(configRead.text);
		} catch {
			return { kind: "invalid", reason: "config_not_json" };
		}
		const parsed = parseCloudMemoryConfig(raw, resolution.env);
		if (parsed.kind === "disabled") return { kind: "disabled", reason: parsed.reason };
		if (parsed.kind === "invalid") return { kind: "invalid", reason: parsed.reason };

		const authRead = await options.readText(parsed.config.authFile, MAX_AUTH_READ_BYTES);
		if (authRead.kind !== "ok") return { kind: "invalid", reason: "auth_unreadable" };
		let authRaw: unknown;
		try {
			authRaw = JSON.parse(authRead.text);
		} catch {
			return { kind: "invalid", reason: "auth_not_json" };
		}
		const auth = parseAuthFile(authRaw);
		if (auth.kind !== "ok") return { kind: "invalid", reason: auth.reason };

		// config 声明了 owner（或开启同步）时，auth 必须绑定同一账号/实例：
		// 防止「旧 config A + 新 token B」把查询或上传跳到别的账号。旧 token-only 配置（无 owner）保持兼容。
		const ownerDeclared = parsed.config.syncEnabled === true || parsed.config.account !== null || parsed.config.cloudInstanceId !== null;
		if (ownerDeclared && auth.binding.kind !== "bound") return { kind: "invalid", reason: "auth_binding_required" };
		if (auth.binding.kind === "bound") {
			if (parsed.config.account !== null && auth.binding.accountId !== parsed.config.account) return { kind: "invalid", reason: "auth_account_mismatch" };
			if (parsed.config.cloudInstanceId !== null && auth.binding.cloudInstanceId !== parsed.config.cloudInstanceId) return { kind: "invalid", reason: "auth_instance_mismatch" };
		}

		return {
			kind: "ok",
			profile: {
				configFile: resolution.configFile,
				config: parsed.config,
				token: auth.token,
				authBinding: auth.binding,
				stateDir: parsed.config.stateDir ?? defaultStateDir(resolution.env),
				personaCacheFile: parsed.config.personaCacheFile ?? defaultPersonaCacheFile(resolution.env),
				problems: [...resolution.problems],
			},
		};
	}

	return { load };
}

/**
 * 采集（同步）门禁：enabled + syncEnabled + 账号 + 实例 + stateDir 齐全才允许登记队列。
 * 缺任何一项都返回 unavailable 原因，不猜账号、不跨账号登记。
 */
export function captureGate(profile: RuntimeProfile): { kind: "ok"; accountId: string; cloudInstanceId: string; stateDir: string } | { kind: "unavailable"; reason: string } {
	if (profile.config.syncEnabled !== true) return { kind: "unavailable", reason: "sync_disabled" };
	const accountId = profile.config.account;
	const cloudInstanceId = profile.config.cloudInstanceId;
	if (!accountId) return { kind: "unavailable", reason: "account_missing" };
	if (!cloudInstanceId) return { kind: "unavailable", reason: "cloud_instance_missing" };
	if (!isAbsolute(profile.stateDir)) return { kind: "unavailable", reason: "state_dir_relative" };
	return { kind: "ok", accountId, cloudInstanceId, stateDir: resolve(profile.stateDir) };
}
