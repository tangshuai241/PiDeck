/**
 * 只读 ZIP 中央目录解析器：Word（.docx）与 OOXML 家族都是 ZIP 容器。
 *
 * 为什么自己写：项目不引第三方压缩库（AGENTS.md 禁止为小功能引重型依赖），
 * 而检查只需要「按名读出若干 XML 成员」。这里只实现 stored / deflateRaw 两条路径。
 *
 * 边界（方案第 7 节预算）：
 * - 部件数上限 10000，重复部件名直接判非法（OOXML 里重复成员是攻击面，不是合法结构）；
 * - 单部件与解压总量都有预算，超限一律返回 undefined，由检查器记 unverified；
 * - ZIP64 / 未知压缩方法不在首版范围，遇到即拒绝而不是猜。
 */
import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 66_000;
export const ZIP_MAX_PARTS = 10_000;

export type ZipEntryHeader = { name: string; compressedSize: number; uncompressedSize: number; method: number; localHeaderOffset: number };

export type ZipBudget = { unpackByteBudget: number; memberByteBudget: number };

/** 文件名按 OOXML 规范是 UTF-8；这里只用于匹配与去重判定。 */
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
		if (entryCount > ZIP_MAX_PARTS) return undefined;
		const directory = Buffer.alloc(directorySize);
		await handle.read(directory, 0, directorySize, directoryOffset);
		const entries: ZipEntryHeader[] = [];
		const names = new Set<string>();
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
			const name = decodeName(directory.subarray(nameStart, nameStart + nameLength));
			if (names.has(name)) return undefined;
			names.add(name);
			entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
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
 * 按名读成员。单部件与解压总量都受预算约束；任何超限返回 undefined，
 * 由检查器记 unverified，而不是把截断内容当成通过。
 */
export async function readZipEntries(path: string, wanted: readonly string[], budget: ZipBudget): Promise<Map<string, Buffer> | undefined> {
	const headers = await listZipEntries(path);
	if (!headers) return undefined;
	const wantedSet = new Set(wanted);
	const selected = headers.filter((header) => wantedSet.has(header.name));
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	const result = new Map<string, Buffer>();
	let consumed = 0;
	try {
		handle = await open(path, "r");
		for (const header of selected) {
			if (header.uncompressedSize > budget.memberByteBudget) return undefined;
			consumed += header.compressedSize + header.uncompressedSize;
			if (consumed > budget.unpackByteBudget) return undefined;
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
			// maxOutputLength 是硬上界：解压炸弹在 zlib 层就被截断，不会先撑爆内存再检查。
			const inflated = inflateRawSync(compressed, { maxOutputLength: Math.min(header.uncompressedSize || budget.memberByteBudget, budget.memberByteBudget) });
			result.set(header.name, inflated);
		}
		return result;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** 拒绝实体声明：首版不解析 DTD/实体，遇到即判「无法验证」。 */
export function containsXmlEntityDeclaration(xml: string): boolean {
	return /<!DOCTYPE|<!ENTITY/i.test(xml);
}
