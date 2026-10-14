/**
 * pi-deck-cloud-memory-capture-store —— 采集的持久层（游标 metadata + 独立记录文件 + 设备 id）。
 *
 * 为什么单列：游标必须很小，不能被「所有完整 record」撑到读上限；每条记录独立成文件按需读取，
 * 读端与写端都按同一字节上限收口（绝不写出下次读不回来的状态）。记录上限与队列对齐（16MiB 减 envelope），
 * 因此长原话（>256KiB）也能登记并在之后正常编辑/隐藏；超上限时显式 recordOmitted + blocked，不推进错误 hash。
 *
 * - 读：用 FileHandle + 有界 read（stat 只作快速拒绝，避免 stat→read 的 TOCTOU 放大）；
 * - 写：临时文件 fsync 后 rename/link，写端超过读上限时不落盘并显式返回 too_large；
 * - 损坏：游标解析失败一律 corrupt（上层 fail-closed，绝不当成「无历史」重建基线）；
 * - scope 路径含 account + instance + device，游标内再复核同名字段（防跨账号/跨设备混用）。
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseCaptureCursor, CAPTURE_CURSOR_VERSION, type CaptureCursor, type CaptureScopeKey } from "./pi-deck-cloud-memory-capture-plan";
import { captureStateDir, safeFileSegment } from "./pi-deck-cloud-memory-runtime-config";

export const DEVICE_FILE_VERSION = 1;
/** 游标 metadata 读上限：仍然很小（只有编号/哈希/时间/scope，不含正文）。 */
export const CURSOR_READ_BYTES = 256 * 1024;
/**
 * 单条记录读写上限：与 D 的队列条目上限（DEFAULT_MAX_ENTRY_BYTES = 16MiB）对齐，
 * 留 64KiB envelope 余量（记录文件会被包进 queue entry，不能比队列入场上限更大）；
 * 写端上限 = 读端，绝不产生下次读不回来的文件。小 cursor 不随记录扩容。
 */
export const RECORD_QUEUE_LIMIT_BYTES = 16 * 1024 * 1024;
export const RECORD_ENVELOPE_MARGIN_BYTES = 64 * 1024;
export const RECORD_READ_BYTES = RECORD_QUEUE_LIMIT_BYTES - RECORD_ENVELOPE_MARGIN_BYTES;
export const RECORD_WRITE_BYTES = RECORD_READ_BYTES;
export const DEVICE_READ_BYTES = 8 * 1024;

export type CaptureReadResult = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "invalid"; reason: string };

export type CaptureFsPort = {
	readText(path: string, maxBytes: number): Promise<CaptureReadResult>;
	writeAtomic(dir: string, finalPath: string, data: string): Promise<void>;
	createExclusive(dir: string, finalPath: string, data: string): Promise<"created" | "exists">;
	removeFile(path: string): Promise<void>;
	listFiles(dir: string): Promise<string[]>;
};

/**
 * 默认端口：有界读（FileHandle.read 最多 maxBytes+1 字节，stat 只做快速拒绝）、
 * 有界写（超上限直接失败，不产生读不回来的文件）、fsync 后 rename/link。
 */
export function createDefaultCaptureFsPort(): CaptureFsPort {
	return {
		async readText(path, maxBytes) {
			let handle;
			try {
				handle = await open(path, "r");
			} catch (error) {
				const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
				return code === "ENOENT" ? { kind: "missing" } : { kind: "invalid", reason: "read_failed" };
			}
			try {
				const info = await handle.stat();
				if (info.size > maxBytes) return { kind: "invalid", reason: "too_large" };
				// 有界读：即使文件在 stat 之后被放大，也只读 maxBytes+1 字节并拒绝。
				const buffer = Buffer.allocUnsafe(maxBytes + 1);
				const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
				if (bytesRead > maxBytes) return { kind: "invalid", reason: "too_large" };
				return { kind: "ok", text: buffer.subarray(0, bytesRead).toString("utf8") };
			} catch {
				return { kind: "invalid", reason: "read_failed" };
			} finally {
				await handle.close().catch(() => undefined);
			}
		},
		async writeAtomic(dir, finalPath, data) {
			await mkdir(dir, { recursive: true });
			const tmp = join(dir, `.tmp-${randomUUID()}`);
			await writeBoundedSynced(tmp, data, RECORD_WRITE_BYTES);
			await rename(tmp, finalPath);
		},
		async createExclusive(dir, finalPath, data) {
			await mkdir(dir, { recursive: true });
			const tmp = join(dir, `.tmp-${randomUUID()}`);
			await writeBoundedSynced(tmp, data, RECORD_WRITE_BYTES);
			try {
				await link(tmp, finalPath);
				await unlink(tmp);
				return "created";
			} catch (error) {
				await unlink(tmp).catch(() => undefined);
				const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
				if (code === "EEXIST") return "exists";
				throw error;
			}
		},
		async removeFile(path) {
			await unlink(path).catch(() => undefined);
		},
		async listFiles(dir) {
			try {
				return await readdir(dir);
			} catch {
				return [];
			}
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 写端字节上限：超限抛错（调用方转成 too_large），绝不落盘半个超限文件。 */
async function writeBoundedSynced(path: string, data: string, maxBytes: number): Promise<void> {
	const bytes = Buffer.byteLength(data, "utf8");
	if (bytes > maxBytes) throw new Error(`write_too_large:${bytes}`);
	const handle = await open(path, "w");
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** scope 目录：<stateDir>/_local/capture/<account>--<instance>--<device>。 */
export function captureScopeDir(stateDir: string, scope: CaptureScopeKey): string {
	if (!isAbsolute(stateDir)) throw new Error("stateDir 必须是绝对路径");
	const segment = `${safeFileSegment(scope.accountId)}--${safeFileSegment(scope.cloudInstanceId)}--${safeFileSegment(scope.deviceId)}`;
	return join(captureStateDir(resolve(stateDir)), segment);
}

export function captureCursorPath(stateDir: string, scope: CaptureScopeKey, sessionId: string): string {
	return join(captureScopeDir(stateDir, scope), `cursor-${safeFileSegment(sessionId)}.json`);
}

export type CaptureLoadResult = { kind: "empty" } | { kind: "ok"; cursor: CaptureCursor; migratedFrom: number | null } | { kind: "corrupt"; reason: string };

export type CaptureStore = {
	scopeDir: string;
	cursorPath: string;
	load(): Promise<CaptureLoadResult>;
	saveCursor(cursor: CaptureCursor): Promise<boolean>;
	/** 按需读取原记录（revision 事件需要）；坏/超限一律 null（上层显式阻塞）。 */
	readRecord(sourceId: string): Promise<unknown | null>;
	/** 写记录：超写端上限返回 too_large，不落盘、不产生读不回来的状态。 */
	writeRecord(sourceId: string, record: unknown): Promise<"ok" | "too_large" | "failed">;
	pruneRecords(keepSourceIds: ReadonlySet<string>): Promise<number>;
};

export function createCaptureStore(options: { stateDir: string; scope: CaptureScopeKey; sessionId: string; fsPort?: CaptureFsPort }): CaptureStore {
	const fsPort = options.fsPort ?? createDefaultCaptureFsPort();
	const scopeDir = captureScopeDir(options.stateDir, options.scope);
	const recordsDir = join(scopeDir, "records");
	const cursorPath = captureCursorPath(options.stateDir, options.scope, options.sessionId);

	function recordPath(sourceId: string): string {
		// sourceId 由 D 的 identity 生成（src_<hex>）；这里再收窄一次形态，避免路径注入。
		const safe = /^[A-Za-z0-9._-]{1,256}$/.test(sourceId) ? sourceId : safeFileSegment(sourceId);
		return join(recordsDir, `${safe}.json`);
	}

	return {
		scopeDir,
		cursorPath,

		async load() {
			const read = await fsPort.readText(cursorPath, CURSOR_READ_BYTES);
			if (read.kind === "missing") return { kind: "empty" };
			if (read.kind === "invalid") return { kind: "corrupt", reason: `cursor_${read.reason}` };
			let raw: unknown;
			try {
				raw = JSON.parse(read.text);
			} catch {
				return { kind: "corrupt", reason: "cursor_not_json" };
			}
			const parsed = parseCaptureCursor(raw, { scope: options.scope, sessionId: options.sessionId });
			if (parsed.kind === "corrupt") return { kind: "corrupt", reason: parsed.reason };
			if (parsed.kind === "legacy") {
				// 初版（未发布）格式保守迁移：内嵌 record 写进独立记录文件，超限则标 recordOmitted。
				const entries = { ...parsed.cursor.entries };
				for (const [entryId, entry] of Object.entries(entries)) {
					const record = parsed.legacyRecords[entryId];
					if (record === undefined) {
						entries[entryId] = { ...entry, recordOmitted: true };
						continue;
					}
					const written = await this.writeRecord(entry.sourceId, record);
					if (written !== "ok") entries[entryId] = { ...entry, recordOmitted: true };
				}
				const cursor: CaptureCursor = { ...parsed.cursor, entries, migratedFrom: 1 };
				const saved = await this.saveCursor(cursor);
				return saved ? { kind: "ok", cursor, migratedFrom: 1 } : { kind: "corrupt", reason: "cursor_migrate_save_failed" };
			}
			return { kind: "ok", cursor: parsed.cursor, migratedFrom: null };
		},

		async saveCursor(cursor) {
			try {
				await fsPort.writeAtomic(dirname(cursorPath), cursorPath, `${JSON.stringify(cursor)}\n`);
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message.startsWith("write_too_large")) return false;
				return false;
			}
			const keep = new Set<string>();
			for (const entry of Object.values(cursor.entries)) keep.add(entry.sourceId);
			for (const pending of Object.values(cursor.pending)) if (pending.targetSourceId) keep.add(pending.targetSourceId);
			await this.pruneRecords(keep);
			return true;
		},

		async readRecord(sourceId) {
			const read = await fsPort.readText(recordPath(sourceId), RECORD_READ_BYTES);
			if (read.kind !== "ok") return null;
			try {
				return JSON.parse(read.text);
			} catch {
				return null;
			}
		},

		async writeRecord(sourceId, record) {
			try {
				await fsPort.writeAtomic(recordsDir, recordPath(sourceId), `${JSON.stringify(record)}\n`);
				return "ok";
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				return message.startsWith("write_too_large") ? "too_large" : "failed";
			}
		},

		async pruneRecords(keepSourceIds) {
			// 按路径比较（sourceId 可能被 safeFileSegment 编码），避免把仍在引用的记录误删。
			const keep = new Set([...keepSourceIds].map((sourceId) => recordPath(sourceId)));
			let removed = 0;
			for (const file of await fsPort.listFiles(recordsDir)) {
				if (!file.endsWith(".json")) continue;
				const path = join(recordsDir, file);
				if (keep.has(path)) continue;
				await fsPort.removeFile(path);
				removed += 1;
			}
			return removed;
		},
	};
}

export type EnsureDeviceResult = { kind: "ok"; deviceId: string } | { kind: "error"; reason: string };

/** 设备 id：在 stateDir 内原子创建一次，之后稳定复用；不用 pid / 进程启动时间。 */
export async function ensureDeviceId(input: { file: string; fsPort?: CaptureFsPort; makeId?: () => string }): Promise<EnsureDeviceResult> {
	const fsPort = input.fsPort ?? createDefaultCaptureFsPort();
	const read = await fsPort.readText(input.file, DEVICE_READ_BYTES);
	if (read.kind === "ok") {
		try {
			const parsed: unknown = JSON.parse(read.text);
			if (isRecord(parsed) && parsed.version === DEVICE_FILE_VERSION && typeof parsed.deviceId === "string" && /^[A-Za-z0-9-]{8,128}$/.test(parsed.deviceId)) {
				return { kind: "ok", deviceId: parsed.deviceId };
			}
		} catch {
			// 坏文件按缺失重建（旧设备身份失效，但不会串到别的设备）。
		}
	}
	const deviceId = (input.makeId ?? randomUUID)();
	try {
		const created = await fsPort.createExclusive(dirname(input.file), input.file, `${JSON.stringify({ version: DEVICE_FILE_VERSION, deviceId, createdAt: new Date().toISOString() })}\n`);
		if (created === "created") return { kind: "ok", deviceId };
		const again = await fsPort.readText(input.file, DEVICE_READ_BYTES);
		if (again.kind === "ok") {
			try {
				const parsed: unknown = JSON.parse(again.text);
				if (isRecord(parsed) && typeof parsed.deviceId === "string") return { kind: "ok", deviceId: parsed.deviceId };
			} catch {
				return { kind: "error", reason: "device_read_back_failed" };
			}
		}
		return { kind: "error", reason: "device_read_back_failed" };
	} catch {
		return { kind: "error", reason: "device_create_failed" };
	}
}

/** 采集状态 schema 版本（供运行时/测试引用；真实版本常量在 plan 模块）。 */
export const CAPTURE_STATE_VERSION = CAPTURE_CURSOR_VERSION;
export { captureStateDir };
export function captureStateFile(stateDir: string, scope: CaptureScopeKey, sessionId: string): string {
	return captureCursorPath(stateDir, scope, sessionId);
}
