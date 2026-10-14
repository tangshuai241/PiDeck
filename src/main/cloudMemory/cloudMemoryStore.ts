/**
 * 云端记忆连接状态与加密凭据的唯一 owner（主进程侧）。
 *
 * 落盘 `userData/cloud-memory/connection.json`（0600 原子替换）：
 * - 非密钥字段：baseUrl / account / cloudInstanceId / syncMode / syncEnabled /
 *   rememberSignIn / enabled / configEpoch / 时间戳；
 * - 密钥字段：protectedPassword、protectedToken —— safeStorage 加密后的 base64，
 *   只在「记住登录」被授权时保存密码；safeStorage 不可用直接拒绝保存，不回退明文。
 *
 * 边界：
 * - 本模块不 import electron：protect/unprotect/isEncryptionAvailable 由装配层注入，
 *   便于在纯 Node 测试里用替身验证「不可用时不落盘」。
 * - 凭据不写日志、不进 IPC 返回值；读取密钥只经 readSecret，调用方负责不转发给渲染层。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudMemorySyncMode } from "../../shared/types/cloudMemory";
import { renameWithRetry } from "../utils/fsRetry";
import { normalizeAccount, normalizeCloudMemoryBaseUrl, parseSyncMode } from "./cloudMemoryValidation";

export type CloudMemorySecretKind = "password" | "token";

export type CloudMemoryPersistedSettings = {
	version: 1;
	enabled: boolean;
	baseUrl: string;
	account: string | null;
	cloudInstanceId: string | null;
	syncMode: CloudMemorySyncMode;
	syncEnabled: boolean;
	rememberSignIn: boolean;
	lastConnectedAt: string | null;
	lastPersonaFetchAt: string | null;
	/** 连接身份变化（账号/地址）时自增：异步结果据此作废，绝不把旧账号响应写进新账号。 */
	configEpoch: number;
	protectedPassword?: string;
	protectedToken?: string;
};

export function createDefaultCloudMemorySettings(): CloudMemoryPersistedSettings {
	return {
		version: 1,
		enabled: false,
		baseUrl: "",
		account: null,
		cloudInstanceId: null,
		syncMode: "personal",
		syncEnabled: true,
		rememberSignIn: true,
		lastConnectedAt: null,
		lastPersonaFetchAt: null,
		configEpoch: 0,
	};
}

function readString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length <= maxLength ? value : null;
}

function readIsoOrNull(value: unknown): string | null {
	const raw = readString(value, 64);
	return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/** 宽容读取：缺字段回默认值，未知字段丢弃；损坏条目绝不能把连接状态带进非法形态。 */
export function parseCloudMemoryPersistedSettings(raw: unknown): CloudMemoryPersistedSettings {
	const base = createDefaultCloudMemorySettings();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
	// 未知 JSON 收窄成 object 后一律用 Reflect 读字段（不用 as 绕过类型）
	const record: object = raw;
	const baseUrlRaw = Reflect.get(record, "baseUrl");
	const baseUrl = typeof baseUrlRaw === "string" ? normalizeCloudMemoryBaseUrl(baseUrlRaw) : { ok: false as const };
	const epochRaw = Reflect.get(record, "configEpoch");
	const next: CloudMemoryPersistedSettings = {
		...base,
		enabled: Reflect.get(record, "enabled") === true,
		baseUrl: baseUrl.ok ? baseUrl.baseUrl : "",
		account: normalizeAccount(Reflect.get(record, "account")),
		cloudInstanceId: readString(Reflect.get(record, "cloudInstanceId"), 128),
		syncMode: parseSyncMode(Reflect.get(record, "syncMode")) ?? base.syncMode,
		syncEnabled: Reflect.get(record, "syncEnabled") !== false,
		rememberSignIn: Reflect.get(record, "rememberSignIn") !== false,
		lastConnectedAt: readIsoOrNull(Reflect.get(record, "lastConnectedAt")),
		lastPersonaFetchAt: readIsoOrNull(Reflect.get(record, "lastPersonaFetchAt")),
		configEpoch: typeof epochRaw === "number" && Number.isInteger(epochRaw) && epochRaw >= 0 ? epochRaw : 0,
	};
	const password = readString(Reflect.get(record, "protectedPassword"), 8192);
	if (password) next.protectedPassword = password;
	const token = readString(Reflect.get(record, "protectedToken"), 8192);
	if (token) next.protectedToken = token;
	return next;
}

export type CloudMemoryStoreDeps = {
	filePath: string;
	isEncryptionAvailable: () => boolean;
	protect: (plainText: string) => Uint8Array;
	unprotect: (encrypted: Uint8Array) => string;
	log?: (message: string, details?: Record<string, unknown>) => void;
};

export class CloudMemoryStore {
	private readonly deps: CloudMemoryStoreDeps;

	constructor(deps: CloudMemoryStoreDeps) {
		this.deps = deps;
	}

	async read(): Promise<CloudMemoryPersistedSettings> {
		try {
			const raw = await readFile(this.deps.filePath, "utf8");
			return parseCloudMemoryPersistedSettings(JSON.parse(raw) as unknown);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? Reflect.get(error, "code") : null;
			if (code !== "ENOENT") this.deps.log?.("connection state unreadable; using defaults", {});
			return createDefaultCloudMemorySettings();
		}
	}

	async write(next: CloudMemoryPersistedSettings): Promise<{ ok: true } | { ok: false; reason: "writeFailed" }> {
		try {
			const filePath = this.deps.filePath;
			await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
			const tmp = `${filePath}.${randomUUID()}.tmp`;
			await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await renameWithRetry(tmp, filePath);
			return { ok: true };
		} catch {
			this.deps.log?.("connection state write failed", {});
			return { ok: false, reason: "writeFailed" };
		}
	}

	/** safeStorage 是否可用；不可用时禁止保存任何凭据（不回退明文）。 */
	isSecureStorageAvailable(): boolean {
		try {
			return this.deps.isEncryptionAvailable();
		} catch {
			return false;
		}
	}

	/** 加密一个密钥槽；safeStorage 不可用返回 null（调用方据此拒绝保存并报明确错误）。 */
	protectSecret(plainText: string): string | null {
		if (!this.deps.isEncryptionAvailable()) return null;
		try {
			return Buffer.from(this.deps.protect(plainText)).toString("base64");
		} catch {
			return null;
		}
	}

	/** 读取密钥槽；不可用/解密失败一律返回 null（调用方标记需重连，绝不把密文当明文用）。 */
	readSecret(settings: CloudMemoryPersistedSettings, kind: CloudMemorySecretKind): string | null {
		const stored = kind === "password" ? settings.protectedPassword : settings.protectedToken;
		if (!stored || !this.deps.isEncryptionAvailable()) return null;
		try {
			const value = this.deps.unprotect(Uint8Array.from(Buffer.from(stored, "base64")));
			return value || null;
		} catch {
			return null;
		}
	}
}
