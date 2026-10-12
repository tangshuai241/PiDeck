/**
 * TPA 独立文稿：OOXML（docx/xlsx/pptx 的 ZIP+XML 容器）有界解析。
 *
 * 不引第三方解包库：只要中央目录 + inflate 两件事，而这两件事恰好是
 * "解压炸弹"和"XXE"的入口。因此这里在解析阶段就执行方案 §7 的预算：
 *
 * - 部件数、总解压量、单部件解压量都有上限，超限返回 `over-budget` 而不是截断；
 * - 拒绝 zip64、重复部件名、`..`/绝对路径的部件名；
 * - 拒绝含 `<!DOCTYPE` / `<!ENTITY` 的部件（XXE 与实体扩展攻击）；
 * - 全部失败都返回结构化原因，由检查服务记 `unverified`，绝不"尽力解析"后判通过。
 */
import { inflateRawSync } from "node:zlib";

export type OoxmlBudget = {
	totalBytes: number;
	partBytes: number;
	parts: number;
};

export type OoxmlFailure = { ok: false; reason: string };
export type OoxmlPart = { name: string; data: Buffer };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
	const minimum = Math.max(0, buffer.length - 65_557);
	for (let offset = buffer.length - 22; offset >= minimum; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return undefined;
}

/** 部件名形态：相对、无 `..`、无反斜杠、长度有界。 */
function isSafePartName(name: string): boolean {
	if (!name || name.length > 512 || name.includes("\0") || name.includes("\\")) return false;
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
	return !name.split("/").some((segment) => segment === ".." || segment === "");
}

/** 读取中央目录并执行预算校验；不做任何解压。 */
export function readOoxmlDirectory(buffer: Buffer, budget: OoxmlBudget): { ok: true; entries: { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }[] } | OoxmlFailure {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd === undefined) return { ok: false, reason: "not a ZIP container (end of central directory not found)" };
	const entryCount = buffer.readUInt16LE(eocd + 10);
	const centralOffset = buffer.readUInt32LE(eocd + 16);
	if (entryCount === 0xffff || centralOffset === 0xffffffff) return { ok: false, reason: "zip64 containers are outside the covered budget" };
	if (entryCount > budget.parts) return { ok: false, reason: `part count ${entryCount} exceeds the budget of ${budget.parts}` };
	let offset = centralOffset;
	let totalBytes = 0;
	const names = new Set<string>();
	const entries: { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }[] = [];
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return { ok: false, reason: "the central directory is truncated" };
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (!isSafePartName(name)) return { ok: false, reason: `unsafe part name: ${name.slice(0, 80)}` };
		if (names.has(name)) return { ok: false, reason: `duplicate part: ${name}` };
		names.add(name);
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return { ok: false, reason: "zip64 entries are outside the covered budget" };
		if (method !== 0 && method !== 8) return { ok: false, reason: `unsupported compression method ${method}` };
		if (uncompressedSize > budget.partBytes) return { ok: false, reason: `part ${name} exceeds the per-part budget` };
		totalBytes += uncompressedSize;
		if (totalBytes > budget.totalBytes) return { ok: false, reason: "the unpacked total exceeds the budget" };
		entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return { ok: true, entries };
}

/** 解压单个部件；输出的实际长度由 zlib 的 maxOutputLength 硬限，超限即失败。 */
export function readOoxmlPart(buffer: Buffer, entry: { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }, partBytes: number): { ok: true; data: Buffer } | OoxmlFailure {
	const offset = entry.localOffset;
	if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) return { ok: false, reason: `local header missing for ${entry.name}` };
	const nameLength = buffer.readUInt16LE(offset + 26);
	const extraLength = buffer.readUInt16LE(offset + 28);
	const start = offset + 30 + nameLength + extraLength;
	const end = start + entry.compressedSize;
	if (start > buffer.length || end > buffer.length) return { ok: false, reason: `part data truncated for ${entry.name}` };
	const raw = buffer.subarray(start, end);
	try {
		const data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: partBytes });
		if (data.byteLength > partBytes) return { ok: false, reason: `part ${entry.name} exceeds the per-part budget` };
		return { ok: true, data };
	} catch {
		return { ok: false, reason: `part ${entry.name} could not be decompressed within the budget` };
	}
}

/** XML 实体拒绝：DOCTYPE/ENTITY 声明一律视为不可解析结构。 */
export function containsEntityDeclaration(xml: string): boolean {
	return /<!DOCTYPE|<!ENTITY/i.test(xml);
}

export function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&amp;/g, "&");
}

function safeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "";
	return String.fromCodePoint(value);
}

export type DocxParagraph = { text: string; headingLevel?: number };

/** `w:pStyle` 的取值 → 标题层级；中英文模板都覆盖。 */
export function headingLevelFromStyle(style: string | undefined): number | undefined {
	if (!style) return undefined;
	const match = /^(?:heading|标题)\s*([1-9])/i.exec(style.trim());
	return match ? Number(match[1]) : undefined;
}

export type DocxTextExtraction = {
	paragraphs: DocxParagraph[];
	unresolvedRevisions: boolean;
	unlocatedTextBoxes: boolean;
	duplicateHeadings: boolean;
};

/**
 * 从 `word/document.xml` 抽取段落与标题层级。
 *
 * 只做定位需要的结构识别；未覆盖的结构（文本框、未接受修订）只置标志，
 * 由策略层记 `unverified`，不假装"其他部分完全未变"。
 */
export function extractDocxParagraphs(xml: string): DocxTextExtraction {
	const unresolvedRevisions = /<w:(?:ins|del|moveFrom|moveTo)[\s/>]/.test(xml);
	const unlocatedTextBoxes = /<w:txbxContent[\s/>]/.test(xml) || /<mc:AlternateContent[\s>]/.test(xml);
	const paragraphs: DocxParagraph[] = [];
	const paragraphPattern = /<w:p(?:\s[^>]*)?\/?>([\s\S]*?)(?:<\/w:p>|$)/g;
	let match: RegExpExecArray | null;
	while ((match = paragraphPattern.exec(xml)) !== null) {
		const body = match[1] ?? "";
		const styleMatch = /<w:pStyle\s+w:val="([^"]*)"/.exec(body);
		let text = "";
		const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
		let textMatch: RegExpExecArray | null;
		while ((textMatch = textPattern.exec(body)) !== null) {
			if (textMatch[1] === undefined) text += textMatch[0].startsWith("<w:tab") ? "\t" : "\n";
			else text += decodeXmlText(textMatch[1]);
		}
		paragraphs.push({ text, ...(headingLevelFromStyle(styleMatch?.[1]) ? { headingLevel: headingLevelFromStyle(styleMatch?.[1]) } : {}) });
	}
	const headingCounts = new Map<string, number>();
	for (const paragraph of paragraphs) {
		if (paragraph.headingLevel === undefined) continue;
		const key = `${paragraph.headingLevel}:${paragraph.text.replace(/\s+/g, " ").trim()}`;
		headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
	}
	return { paragraphs, unresolvedRevisions, unlocatedTextBoxes, duplicateHeadings: [...headingCounts.values()].some((count) => count > 1) };
}

/** Markdown 源稿的块定位：标题层级来自 `#` 数量，代码围栏内的 `#` 不算标题。 */
export function extractMarkdownBlocks(source: string): { paragraphs: DocxParagraph[]; duplicateHeadings: boolean } {
	const paragraphs: DocxParagraph[] = [];
	let inFence = false;
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			paragraphs.push({ text: line.trim() });
			continue;
		}
		if (inFence) {
			paragraphs.push({ text: line });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) paragraphs.push({ text: heading[2].trim(), headingLevel: heading[1].length });
		else paragraphs.push({ text: line.trim() });
	}
	const headingCounts = new Map<string, number>();
	for (const paragraph of paragraphs) {
		if (paragraph.headingLevel === undefined) continue;
		const key = `${paragraph.headingLevel}:${paragraph.text}`;
		headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
	}
	return { paragraphs, duplicateHeadings: [...headingCounts.values()].some((count) => count > 1) };
}

/** 纯文本 / Markdown 之外的已知文本型后缀。 */
export function isTextLikeExtension(extension: string): boolean {
	return [".md", ".markdown", ".txt", ".text", ".mdx", ".json", ".csv", ".tsv", ".html", ".htm", ".xml", ".yml", ".yaml"].includes(extension);
}
