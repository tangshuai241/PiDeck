/**
 * 阅读服务连接状态与受保护密码（P03，与 cloudMemory 独立）。
 *
 * 落盘 `<userData>/personal-workbench/reading/connection.json`（0600 原子替换）：
 * - 非密钥字段：baseUrl / rememberPassword / lastConnectedAt；
 * - 密钥字段：protectedPassword（safeStorage 加密后的 base64）——只在「记住密码」被授权时保存，
 *   safeStorage 不可用直接拒绝保存，不回退明文；
 * - 本模块不 import electron：protect/unprotect/isEncryptionAvailable 由装配层注入，便于纯 Node 测；
 * - 密码不写日志、不进 IPC 返回值；读取密钥只经 readPassword，调用方负责不转发。
 */

import type { ReadingStoreIssue } from "./readingJsonStore";
import { handleReadingCorrupt, readReadingJsonBounded, writeReadingJsonAtomic, READING_STORE_MAX_BYTES } from "./readingJsonStore";

export type ReadingConnectionPersisted = {
	version: 1;
	baseUrl: string;
	rememberPassword: boolean;
	lastConnectedAt: string | null;
	protectedPassword?: string;
};

export function createDefaultReadingConnection(): ReadingConnectionPersisted {
	return { version: 1, baseUrl: "", rememberPassword: false, lastConnectedAt: null };
}

function readString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length <= maxLength ? value : null;
}

function readIsoOrNull(value: unknown): string | null {
	const raw = readString(value, 64);
	return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/** 宽容读取：缺字段回默认值；非法字段丢弃（不让半个坏记录带进运行时）。 */
export function parseReadingConnection(raw: unknown): ReadingConnectionPersisted {
	const base = createDefaultReadingConnection();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
	const record: object = raw;
	const protectedPassword = readString(Reflect.get(record, "protectedPassword"), 8192);
	const next: ReadingConnectionPersisted = {
		...base,
		baseUrl: readString(Reflect.get(record, "baseUrl"), 2048) ?? "",
		rememberPassword: Reflect.get(record, "rememberPassword") === true,
		lastConnectedAt: readIsoOrNull(Reflect.get(record, "lastConnectedAt")),
	};
	if (protectedPassword) next.protectedPassword = protectedPassword;
	return next;
}

export type ReadingConnectionStoreDeps = {
	filePath: string;
	isEncryptionAvailable: () => boolean;
	protect: (plainText: string) => Uint8Array;
	unprotect: (encrypted: Uint8Array) => string;
	now?: () => Date;
	log?: (message: string, details?: Record<string, unknown>) => void;
};

export class ReadingConnectionStore {
	private readonly deps: ReadingConnectionStoreDeps;
	private blocked = false;
	private lastIssue: ReadingStoreIssue | null = null;

	constructor(deps: ReadingConnectionStoreDeps) {
		this.deps = deps;
	}

	async read(): Promise<ReadingConnectionPersisted> {
		const outcome = await readReadingJsonBounded(this.deps.filePath, READING_STORE_MAX_BYTES);
		if (outcome.status === "missing") return createDefaultReadingConnection();
		if (outcome.status === "issue") {
			this.lastIssue = await handleReadingCorrupt(this.deps.filePath, outcome.code, this.deps.now ?? (() => new Date()));
			this.blocked = this.lastIssue.blocked;
			this.deps.log?.("reading connection state unreadable; using defaults", { code: outcome.code, blocked: this.lastIssue.blocked });
			return createDefaultReadingConnection();
		}
		return parseReadingConnection(outcome.value);
	}

	async write(next: ReadingConnectionPersisted): Promise<{ ok: true } | { ok: false; reason: "writeFailed" | "blocked" }> {
		if (this.blocked) return { ok: false, reason: "blocked" };
		const result = await writeReadingJsonAtomic(this.deps.filePath, next);
		if (!result.ok) {
			this.deps.log?.("reading connection state write failed", {});
			return { ok: false, reason: "writeFailed" };
		}
		this.lastIssue = null;
		return { ok: true };
	}

	getIssue(): ReadingStoreIssue | null {
		return this.lastIssue;
	}

	isSecureStorageAvailable(): boolean {
		try {
			return this.deps.isEncryptionAvailable();
		} catch {
			return false;
		}
	}

	/** 加密密码：safeStorage 不可用返回 null（调用方拒绝保存并如实报错）。 */
	protectPassword(plainText: string): string | null {
		if (!this.isSecureStorageAvailable()) return null;
		try {
			return Buffer.from(this.deps.protect(plainText)).toString("base64");
		} catch {
			return null;
		}
	}

	/** 读取密码：不可用/解密失败一律 null（标记需要重连，绝不把密文当明文用）。 */
	readPassword(settings: ReadingConnectionPersisted): string | null {
		if (!settings.protectedPassword || !this.isSecureStorageAvailable()) return null;
		try {
			const value = this.deps.unprotect(Uint8Array.from(Buffer.from(settings.protectedPassword, "base64")));
			return value || null;
		} catch {
			return null;
		}
	}
}
