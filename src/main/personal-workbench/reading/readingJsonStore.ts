/**
 * 阅读本地 JSON 存储小工具（P03）：原子写、有界读、损坏隔离。
 *
 * 与 P02 待办 store 同纪律（教训共享）：
 * - 只有「文件不存在」才当空；不可读/超上界/JSON 损坏/结构非法一律算损坏；
 * - 损坏时先把原文件改名隔离（bytes 原样保留）再以空状态继续，并返回结构化 issue；
 *   隔离失败则禁止再写该文件（绝不覆盖原件）；
 * - 写入走 `临时文件 → renameWithRetry`（同盘原子替换），0600/0700。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renameWithRetry } from "../../utils/fsRetry";

export const READING_STORE_MAX_BYTES = 512 * 1024;

export type ReadingStoreIssue = {
	code: "unreadable" | "tooLarge" | "invalidJson" | "invalidStructure" | "quarantineFailed";
	path: string;
	message: string;
	quarantinePath: string | null;
	blocked: boolean;
};

/** 本地 JSON 的统一序列化口径（写入与字节上界检查共用，禁止两处各写一份）。 */
export function serializeReadingJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export type ReadingAtomicWriteResult = { ok: true } | { ok: false; reason: "writeFailed" };

export async function writeReadingJsonAtomic(filePath: string, value: unknown): Promise<ReadingAtomicWriteResult> {
	try {
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		const tmp = `${filePath}.${randomUUID()}.tmp`;
		await writeFile(tmp, serializeReadingJson(value), { encoding: "utf8", mode: 0o600 });
		await renameWithRetry(tmp, filePath);
		return { ok: true };
	} catch {
		return { ok: false, reason: "writeFailed" };
	}
}

export type ReadingBoundedRead = { status: "missing" } | { status: "ok"; value: unknown } | { status: "issue"; code: "unreadable" | "tooLarge" | "invalidJson" };

export async function readReadingJsonBounded(filePath: string, maxBytes: number): Promise<ReadingBoundedRead> {
	let size: number;
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return { status: "issue", code: "unreadable" };
		size = info.size;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? Reflect.get(error, "code") : null;
		if (code === "ENOENT") return { status: "missing" };
		return { status: "issue", code: "unreadable" };
	}
	if (size > maxBytes) return { status: "issue", code: "tooLarge" };
	try {
		const text = await readFile(filePath, "utf8");
		if (Buffer.byteLength(text, "utf8") > maxBytes) return { status: "issue", code: "tooLarge" };
		return { status: "ok", value: JSON.parse(text) as unknown };
	} catch {
		return { status: "issue", code: "invalidJson" };
	}
}

/** 损坏处理：隔离原件；隔离不成就标记禁止写该文件。 */
export async function handleReadingCorrupt(filePath: string, code: ReadingStoreIssue["code"], now: () => Date): Promise<ReadingStoreIssue> {
	const suffix = now().toISOString().replace(/[:.]/g, "-");
	const target = `${filePath}.corrupt-${suffix}`;
	let quarantinePath: string | null = null;
	try {
		await rename(filePath, target);
		quarantinePath = target;
	} catch {
		quarantinePath = null;
	}
	const message = quarantinePath ? "阅读本地文件损坏，原文件已隔离保留" : "阅读本地文件损坏且无法隔离，已暂停写入以保留原文件";
	return { code, path: filePath, message, quarantinePath, blocked: quarantinePath === null };
}
