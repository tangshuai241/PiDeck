/**
 * pi-deck-cloud-memory-sync-outbox-fs —— 待传队列的原子文件与解析助手（N06 内部模块）。
 *
 * 从 `pi-deck-cloud-memory-sync-outbox.ts` 拆出，保持单文件目标 ≤400 行；不属于公开 API。
 * 约定：所有路径先过 assertInside/safeSegment；写文件走同目录临时文件 + fsync + 原子创建/替换；
 * 读文件不跟随符号链接；损坏内容按 invalid 返回，由调用方保留证据。
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { SOURCE_ID_PATTERN, parseSyncRecord } from "./pi-deck-cloud-memory-sync-identity";
import { SYNC_OUTBOX_SCHEMA, SYNC_SCHEMA_VERSION, SyncOutboxError, type SyncOutboxEntry, type SyncOutboxState, type SyncReceipt, type SyncSenderLease } from "./pi-deck-cloud-memory-sync-types";


export type EntryRead = { kind: "ok"; entry: SyncOutboxEntry } | { kind: "missing" } | { kind: "invalid"; reason: string };
export type ReceiptRead = { kind: "ok"; receipt: SyncReceipt } | { kind: "missing" } | { kind: "invalid"; reason: string };
export type LeaseRead = { kind: "ok"; lease: SyncSenderLease } | { kind: "missing" } | { kind: "invalid"; reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOutboxState(value: unknown): value is SyncOutboxState {
	return value === "pending" || value === "unknown" || value === "auth_blocked" || value === "conflict";
}

/** 从 unknown 错误中取字符串 code；无 code / 非字符串返回 null，不做类型断言。 */
export function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

function textValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** 目录/文件名安全化：正常字符原样保留，其余用 base64url 编码（避免 `..`、分隔符与保留名）。 */
export function safeSegment(value: string): string {
	if (value !== "." && value !== ".." && !value.endsWith(".") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return value;
	return `b64_${Buffer.from(value, "utf8").toString("base64url")}`;
}

export function assertSourceId(value: unknown): string {
	if (typeof value !== "string" || !SOURCE_ID_PATTERN.test(value)) throw new SyncOutboxError("invalid_input", "sourceId 形态不合法");
	return value;
}

/** 所有目标路径必须落在 stateDir 内；逃逸立即报错。 */
export function assertInside(root: string, target: string): void {
	const rel = relative(root, target);
	if (rel === "") return;
	if (rel.startsWith("..") || isAbsolute(rel)) throw new SyncOutboxError("invalid_input", `路径逃逸：${target}`);
}

export function defaultIsPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function pick(value: Record<string, unknown>, camel: string, snake: string): unknown {
	return value[camel] !== undefined ? value[camel] : value[snake];
}

export function parseReceipt(value: unknown): SyncReceipt | null {
	if (!isRecord(value)) return null;
	const stored = value.stored;
	const accountId = pick(value, "accountId", "account_id");
	const cloudInstanceId = pick(value, "cloudInstanceId", "cloud_instance_id");
	const sourceId = pick(value, "sourceId", "source_id");
	const revision = value.revision;
	const contentHash = pick(value, "contentHash", "content_hash");
	const textSha256 = pick(value, "textSha256", "text_sha256");
	if (typeof stored !== "boolean") return null;
	if (typeof accountId !== "string" || accountId.length === 0) return null;
	if (typeof cloudInstanceId !== "string" || cloudInstanceId.length === 0) return null;
	if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) return null;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
	if (typeof contentHash !== "string" || contentHash.length === 0) return null;
	if (typeof textSha256 !== "string" || textSha256.length === 0) return null;
	return { stored, accountId, cloudInstanceId, sourceId, revision, contentHash, textSha256 };
}

export function parseEntry(value: unknown): SyncOutboxEntry | null {
	if (!isRecord(value)) return null;
	const version = value.version;
	if (value.schema !== SYNC_OUTBOX_SCHEMA || typeof version !== "number" || !Number.isSafeInteger(version) || version > SYNC_SCHEMA_VERSION) return null;
	const state = value.state;
	if (!isOutboxState(state)) return null;
	const record = parseSyncRecord(value.record);
	if (!record) return null;
	const previousRaw = value.previousState;
	if (previousRaw !== undefined && previousRaw !== null && !isOutboxState(previousRaw)) return null;
	const previousState = previousRaw ?? null;
	const receiptRaw = value.receipt;
	const receipt = receiptRaw === undefined || receiptRaw === null ? null : parseReceipt(receiptRaw);
	if (receiptRaw !== undefined && receiptRaw !== null && receipt === null) return null;
	const attemptsRaw = value.attempts;
	return {
		schema: SYNC_OUTBOX_SCHEMA,
		version,
		state,
		previousState,
		record,
		attempts: typeof attemptsRaw === "number" && Number.isSafeInteger(attemptsRaw) && attemptsRaw >= 0 ? attemptsRaw : 0,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		lastAttemptAt: typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : null,
		lastError: typeof value.lastError === "string" ? value.lastError : null,
		conflictReason: typeof value.conflictReason === "string" ? value.conflictReason : null,
		receipt,
	};
}

export function parseLease(value: unknown): SyncSenderLease | null {
	if (!isRecord(value)) return null;
	const token = textValue(value.token);
	const accountId = textValue(value.accountId);
	const cloudInstanceId = textValue(value.cloudInstanceId);
	const deviceId = textValue(value.deviceId);
	const processStartedAt = textValue(value.processStartedAt);
	const createdAt = textValue(value.createdAt);
	const heartbeatAt = textValue(value.heartbeatAt);
	const expiresAt = textValue(value.expiresAt);
	const pid = value.pid;
	if (!token || !accountId || !cloudInstanceId || !deviceId || !processStartedAt || !createdAt || !heartbeatAt || !expiresAt) return null;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
	return { token, accountId, cloudInstanceId, deviceId, pid, processStartedAt, createdAt, heartbeatAt, expiresAt };
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new SyncOutboxError("fs_error", `目录不可用（链接或非目录）：${dir}`);
}

async function fsyncDir(dir: string): Promise<void> {
	try {
		const handle = await fs.open(dir, fsConstants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Windows 等平台不允许对目录 fsync；忽略，重命名本身已保证可见性。
	}
}

/** 同目录临时文件：O_EXCL + fsync，保证后续原子操作看到完整内容。 */
async function writeTempFile(dir: string, data: string): Promise<string> {
	const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return tmp;
}

/** 独占创建：link 成功=最终文件首次落盘；EEXIST=已有他人条目，绝不覆盖。
 * 不支持硬链接的文件系统（9P/部分网络盘等）明确报错；绝不用非原子 copy 冒充独占保证。 */
export async function createExclusiveFile(dir: string, finalPath: string, data: string): Promise<"created" | "exists"> {
	const tmp = await writeTempFile(dir, data);
	try {
		await fs.link(tmp, finalPath);
		await fsyncDir(dir);
		return "created";
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "exists";
		throw new SyncOutboxError("fs_unsupported", `文件系统不支持原子硬链接独占创建：${finalPath}（${errorCode(error) ?? "unknown"}），未写入最终文件`);
	} finally {
		await fs.unlink(tmp).catch(() => {});
	}
}

export async function replaceFileAtomic(dir: string, finalPath: string, data: string): Promise<void> {
	const tmp = await writeTempFile(dir, data);
	try {
		await fs.rename(tmp, finalPath);
		await fsyncDir(dir);
	} catch (error) {
		await fs.unlink(tmp).catch(() => {});
		throw error;
	}
}

/** 只读普通文件；符号链接/非普通文件/超限一律按 invalid 处理（不跟随链接、不静默删除）。 */
export async function readTextNoFollow(path: string, maxBytes: number): Promise<{ kind: "ok"; text: string } | { kind: "missing" } | { kind: "invalid"; reason: string }> {
	let info;
	try {
		info = await fs.lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: "unreadable" };
	}
	if (info.isSymbolicLink()) return { kind: "invalid", reason: "symlink" };
	if (!info.isFile()) return { kind: "invalid", reason: "not_regular_file" };
	if (info.size > maxBytes) return { kind: "invalid", reason: "too_large" };
	try {
		return { kind: "ok", text: await fs.readFile(path, "utf8") };
	} catch {
		return { kind: "invalid", reason: "unreadable" };
	}
}
