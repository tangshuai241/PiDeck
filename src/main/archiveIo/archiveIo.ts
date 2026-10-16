/**
 * 通用归档 IO 契约与校验工具（中立模块）。
 *
 * 背景：pi 环境引导的便携 Node 安装器原先复用 DSH runtime 的下载/解压工具。
 * DSH 后端移除后，这些能力不能随之删除——它们与 DSH 无关，属于通用下载/校验：
 * - `sha256OfFile`：流式计算文件 sha256（小写 hex）；
 * - `ArchiveDownloader` / `ArchiveExtractor`：下载与解压的函数契约，由调用方注入
 *   （生产实现走 net 流式下载与系统 tar 两遍式；测试注入本地替身）。
 *
 * 本模块不依赖 Electron / DSH / 具体网络实现，主进程与 node 单测共用。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { relative, resolve } from "node:path";

/** 下载器契约：url → destPath；可选进度、取消与断点续传起点。 */
export type ArchiveDownloader = (url: string, destPath: string, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal, options?: { resumeFromBytes?: number }) => Promise<void>;

/** 解压器契约：归档 → 目标目录（实现方负责 tar slip 安全校验与失败清理）。 */
export type ArchiveExtractor = (archivePath: string, destDir: string) => Promise<void>;

/** 计算文件 sha256（小写 hex）。 */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/**
 * 归档内条目 → 落盘路径的安全判定（tar slip 防护）。
 * 只接受相对路径、不接受 `..` 段，且解析后必须仍在 destDir 内。
 */
export function isSafeArchiveEntry(destDir: string, entryPath: string): boolean {
	const normalized = entryPath.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
	if (normalized.split("/").includes("..")) return false;
	const target = resolve(destDir, normalized);
	const rel = relative(destDir, target);
	return rel === "" || (!rel.startsWith("..") && !resolve(destDir, rel).startsWith(".."));
}
