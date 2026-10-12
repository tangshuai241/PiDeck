/**
 * 只读 ZIP 中央目录解析器：Word（.docx）与 OOXML 家族都是 ZIP 容器。
 *
 * 为什么自己写：项目不引第三方压缩库（AGENTS.md 禁止为小功能引重型依赖），
 * 而检查只需要「按名读出若干 XML 成员」。这里只实现 stored / deflateRaw 两条路径，
 * 一切解压都在明确字节预算内进行，超预算直接放弃而不是把内存读爆。
 */
import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 66_000;

export type ZipEntryHeader = { name: string; compressedSize: number; uncompressedSize: number; method: number; localHeaderOffset: number };

/** 文件名按 OOXML 规范是 UTF-8；bit 11 未置位时退化为 latin1，两者都只用于匹配。 */
function decodeName(bytes: Buffer): string {
	return bytes.toString("utf8");
}

function readEocdOffset(buffer: Buffer): number | undefined {
	for (let offset = buffer.length - 22; offset >= 0; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return undefined;
}

export async function listZipEntries(path: string): Promise<ZipEntryHeader[] | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const info = await handle.stat();
		const tailSize = Math.min(info.size, MAX_EOCD_SEARCH);
		const tail = Buffer.alloc(tailSize);
		await handle.read(tail, 0, tailSize, Math.max(0, info.size - tailSize));
		const eocd = readEocdOffset(tail);
		if (eocd === undefined) return undefined;
		const entryCount = tail.readUInt16LE(eocd + 10);
		const directoryOffset = tail.readUInt32LE(eocd + 16);
		const directorySize = tail.readUInt32LE(eocd + 12);
		if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) return undefined; // ZIP64 不在首版范围
		if (entryCount > 20_000) return undefined;
		const directory = Buffer.alloc(directorySize);
		await handle.read(directory, 0, directorySize, directoryOffset);
		const entries: ZipEntryHeader[] = [];
		let cursor = 0;
		for (let index = 0; index < entryCount && cursor + 46 <= directory.length; index++) {
			if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return undefined;
			const method = directory.readUInt16LE(cursor + 10);
			const compressedSize = directory.readUInt32LE(cursor + 20);
			const uncompressedSize = directory.readUInt32LE(cursor + 24);
			const nameLength = directory.readUInt16LE(cursor + 28);
			const extraLength = directory.readUInt16LE(cursor + 30);
			const commentLength = directory.readUInt16LE(cursor + 32);
			const localHeaderOffset = directory.readUInt32LE(cursor + 42);
			const nameStart = cursor + 46;
			if (nameStart + nameLength > directory.length) return undefined;
			entries.push({ name: decodeName(directory.subarray(nameStart, nameStart + nameLength)), compressedSize, uncompressedSize, method, localHeaderOffset });
			cursor = nameStart + nameLength + extraLength + commentLength;
		}
		return entries;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * 按名读成员。`byteBudget` 同时限制压缩前后字节数，任何超限都返回 undefined，
 * 由检查器记 unverified，而不是把截断内容当成通过。
 */
export async function readZipEntries(path: string, wanted: readonly string[], byteBudget: number): Promise<Map<string, Buffer> | undefined> {
	const headers = await listZipEntries(path);
	if (!headers) return undefined;
	const wantedSet = new Set(wanted);
	const selected = headers.filter((header) => wantedSet.has(header.name));
	for (const header of selected) {
		if (header.uncompressedSize > byteBudget) return undefined;
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	const result = new Map<string, Buffer>();
	let consumed = 0;
	try {
		handle = await open(path, "r");
		for (const header of selected) {
			consumed += header.compressedSize + header.uncompressedSize;
			if (consumed > byteBudget) return undefined;
			const localHeader = Buffer.alloc(30);
			await handle.read(localHeader, 0, 30, header.localHeaderOffset);
			if (localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) return undefined;
			const nameLength = localHeader.readUInt16LE(26);
			const extraLength = localHeader.readUInt16LE(28);
			const dataOffset = header.localHeaderOffset + 30 + nameLength + extraLength;
			const compressed = Buffer.alloc(header.compressedSize);
			await handle.read(compressed, 0, header.compressedSize, dataOffset);
			if (header.method === 0) {
				result.set(header.name, compressed);
				continue;
			}
			if (header.method !== 8) return undefined;
			const inflated = inflateRawSync(compressed, { maxOutputLength: Math.min(header.uncompressedSize || byteBudget, byteBudget) });
			result.set(header.name, inflated);
		}
		return result;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
