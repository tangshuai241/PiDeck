/**
 * 注册式格式检查器：docx / Markdown / 纯文本。
 *
 * 检查器只产出「检查项 + 覆盖信息 + 标题大纲」，状态聚合、字节预算与超时统一由
 * `DocumentInspectionService` 负责。任何提取失败都必须落到 unverified，
 * 不允许把「没读到」记成「通过」。
 */
import { readFile } from "node:fs/promises";
import { hashText } from "./documentWorkPaths";
import { listZipEntries, readZipEntries } from "./zipEntries";
import type { DocumentInspectionItem } from "../../shared/types/documentWork";

export type InspectionCoverage = {
	format: string;
	bytesRead: number;
	bytesTotal: number;
	textDigest?: string;
	formatDigest?: string;
	textLength?: number;
	truncated: boolean;
};

export type InspectorOutput = {
	items: DocumentInspectionItem[];
	coverage: InspectionCoverage;
	/** 供范围校验使用的标题大纲。 */
	headings: string[];
};

export type InspectorInput = {
	filePath: string;
	byteBudget: number;
	/** 对比基稿的正文指纹；缺省表示本轮不做「正文是否变化」判定。 */
	comparedTextDigest?: string;
};

export type FormatInspector = {
	id: string;
	version: string;
	/** 处理的扩展名（小写、含点）。注册式：新增格式只加检查器，不改服务分支。 */
	extensions: readonly string[];
	inspect(input: InspectorInput): Promise<InspectorOutput>;
	/** 只取大纲（准备阶段做范围冲突校验），失败返回 undefined。 */
	outline(input: { filePath: string; byteBudget: number }): Promise<string[] | undefined>;
};

const DOCX_MEMBER_BUDGET_SHARE = 0.9;

/** 段落切分与文本提取：只认 OOXML 的既有语法，不引 XML 库。 */
function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

function paragraphTexts(paragraph: string): string {
	const matches = paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
	let text = "";
	for (const match of matches) text += decodeXmlText(match[1]);
	return text;
}

function paragraphStyleId(paragraph: string): string | undefined {
	const match = paragraph.match(/<w:pStyle\s+[^>]*w:val="([^"]+)"/);
	return match?.[1];
}

function splitParagraphs(documentXml: string): string[] {
	return documentXml.split(/<\/w:p>/);
}

function styleHeadingMap(stylesXml: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!stylesXml) return map;
	for (const match of stylesXml.matchAll(/<w:style\s+[^>]*w:styleId="([^"]+)"[\s\S]*?<\/w:style>/g)) {
		const nameMatch = match[0].match(/<w:name\s+[^>]*w:val="([^"]+)"/);
		if (nameMatch) map.set(match[1], nameMatch[2]);
	}
	return map;
}

function isHeadingStyle(styleId: string, styleNames: Map<string, string>): boolean {
	const name = styleNames.get(styleId) ?? styleId;
	return /^heading\s*\d+$/i.test(name) || /^(?:标题|標題)\s*\d*$/.test(name);
}

/** 去掉文本内容后的文档骨架：用来把「正文变化」和「包结构/格式变化」分开记。 */
function skeletonOf(documentXml: string): string {
	return documentXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, "<w:t/>");
}

function normalizeExtractedText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t\u3000]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
}

function duplicateHeadings(headings: readonly string[]): string[] {
	const seen = new Map<string, number>();
	for (const heading of headings) {
		const key = heading.trim().toLowerCase();
		if (!key) continue;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	return [...seen.entries()].filter(([, count]) => count > 1).map(([heading]) => heading);
}

async function readDocxParts(filePath: string, byteBudget: number): Promise<{ documentXml: string; stylesXml?: string; structure: string } | undefined> {
	// 包结构指纹必须覆盖整个 ZIP 成员表，而不是只覆盖我们解析的那两个成员：
	// 「正文相同但包里多了批注/图表」属于格式变化，不能被吞掉。
	const headers = await listZipEntries(filePath);
	if (!headers) return undefined;
	const parts = await readZipEntries(filePath, ["word/document.xml", "word/styles.xml"], Math.floor(byteBudget * DOCX_MEMBER_BUDGET_SHARE));
	if (!parts) return undefined;
	const document = parts.get("word/document.xml");
	if (!document) return undefined;
	const structure = headers
		.map((header) => `${header.name}|${header.uncompressedSize}`)
		.sort()
		.join("|");
	return { documentXml: document.toString("utf8"), stylesXml: parts.get("word/styles.xml")?.toString("utf8"), structure };
}

export const docxInspector: FormatInspector = {
	id: "docx",
	version: "docx-1",
	extensions: [".docx", ".dotx"],

	async inspect({ filePath, byteBudget, comparedTextDigest }): Promise<InspectorOutput> {
		const parts = await readDocxParts(filePath, byteBudget);
		if (!parts) {
			return { items: [{ id: "package_readable", status: "unverified", detail: "package_unreadable" }], coverage: { format: "docx", bytesRead: 0, bytesTotal: 0, truncated: false }, headings: [] };
		}
		const paragraphs = splitParagraphs(parts.documentXml);
		const styleNames = styleHeadingMap(parts.stylesXml);
		const headings: string[] = [];
		const bodyLines: string[] = [];
		for (const paragraph of paragraphs) {
			const text = paragraphTexts(paragraph);
			bodyLines.push(text);
			const styleId = paragraphStyleId(paragraph);
			if (styleId && isHeadingStyle(styleId, styleNames) && text.trim()) headings.push(text.trim());
		}
		const text = normalizeExtractedText(bodyLines.join("\n"));
		const hasTrackedChanges = /<w:(?:ins|del)[\s>]/.test(parts.documentXml);
		const hasTextBoxes = parts.documentXml.includes("<w:txbxContent");
		const items: DocumentInspectionItem[] = [{ id: "package_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		items.push(hasTrackedChanges ? { id: "no_unresolved_tracked_changes", status: "failed", detail: "tracked_changes" } : { id: "no_unresolved_tracked_changes", status: "passed" });
		items.push(hasTextBoxes ? { id: "no_text_boxes", status: "failed", detail: "text_box_content" } : { id: "no_text_boxes", status: "passed" });
		const duplicates = duplicateHeadings(headings);
		items.push(duplicates.length === 0 ? { id: "no_duplicate_headings", status: "passed" } : { id: "no_duplicate_headings", status: "failed", detail: "duplicate_heading" });
		const textDigest = hashText(text);
		if (comparedTextDigest !== undefined) {
			items.push(textDigest === comparedTextDigest ? { id: "body_content_changed", status: "failed", detail: "content_unchanged" } : { id: "body_content_changed", status: "passed" });
		}
		return {
			items,
			coverage: { format: "docx", bytesRead: parts.documentXml.length, bytesTotal: parts.documentXml.length, textDigest, formatDigest: hashText(`${parts.structure}|${skeletonOf(parts.documentXml)}`), textLength: text.length, truncated: false },
			headings,
		};
	},

	async outline({ filePath, byteBudget }): Promise<string[] | undefined> {
		const parts = await readDocxParts(filePath, byteBudget);
		if (!parts) return undefined;
		const styleNames = styleHeadingMap(parts.stylesXml);
		const headings: string[] = [];
		for (const paragraph of splitParagraphs(parts.documentXml)) {
			const styleId = paragraphStyleId(paragraph);
			if (!styleId || !isHeadingStyle(styleId, styleNames)) continue;
			const text = paragraphTexts(paragraph).trim();
			if (text) headings.push(text);
		}
		return headings;
	},
};

const MARKDOWN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;

export const markdownInspector: FormatInspector = {
	id: "markdown",
	version: "markdown-1",
	extensions: [".md", ".markdown", ".mdx"],

	async inspect({ filePath, byteBudget, comparedTextDigest }): Promise<InspectorOutput> {
		const raw = await readFile(filePath, "utf8").catch(() => undefined);
		if (raw === undefined || Buffer.byteLength(raw, "utf8") > byteBudget) {
			return { items: [{ id: "file_readable", status: "unverified", detail: "read_failed" }], coverage: { format: "markdown", bytesRead: 0, bytesTotal: 0, truncated: false }, headings: [] };
		}
		const headings = markdownHeadings(raw);
		const text = normalizeExtractedText(raw);
		const items: DocumentInspectionItem[] = [{ id: "file_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		const duplicates = duplicateHeadings(headings);
		items.push(duplicates.length === 0 ? { id: "no_duplicate_headings", status: "passed" } : { id: "no_duplicate_headings", status: "failed", detail: "duplicate_heading" });
		const textDigest = hashText(text);
		if (comparedTextDigest !== undefined) {
			items.push(textDigest === comparedTextDigest ? { id: "body_content_changed", status: "failed", detail: "content_unchanged" } : { id: "body_content_changed", status: "passed" });
		}
		// 块结构指纹：同一段文字换成不同 Markdown 写法（列表→引用、标题层级变化）会变。
		const structure = raw
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => classifyMarkdownLine(line))
			.join("\n");
		return { items, coverage: { format: "markdown", bytesRead: Buffer.byteLength(raw, "utf8"), bytesTotal: Buffer.byteLength(raw, "utf8"), textDigest, formatDigest: hashText(structure), textLength: text.length, truncated: false }, headings };
	},

	async outline({ filePath, byteBudget }): Promise<string[] | undefined> {
		const raw = await readFile(filePath, "utf8").catch(() => undefined);
		if (raw === undefined || Buffer.byteLength(raw, "utf8") > byteBudget) return undefined;
		return markdownHeadings(raw);
	},
};

function markdownHeadings(raw: string): string[] {
	const headings: string[] = [];
	for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
		const match = line.match(MARKDOWN_HEADING_RE);
		if (match) headings.push(match[2].trim());
	}
	return headings;
}

function classifyMarkdownLine(line: string): string {
	if (/^#{1,6}\s/.test(line)) return "heading";
	if (/^\s*[-*+]\s/.test(line)) return "bullet";
	if (/^\s*\d+[.)]\s/.test(line)) return "ordered";
	if (/^\s*>/.test(line)) return "quote";
	if (/^\s*\|/.test(line)) return "table";
	if (/^\s*```/.test(line)) return "fence";
	if (line.trim().length === 0) return "blank";
	return "text";
}

export const textInspector: FormatInspector = {
	id: "text",
	version: "text-1",
	extensions: [".txt", ".text", ".log"],

	async inspect({ filePath, byteBudget, comparedTextDigest }): Promise<InspectorOutput> {
		const raw = await readFile(filePath, "utf8").catch(() => undefined);
		if (raw === undefined || Buffer.byteLength(raw, "utf8") > byteBudget) {
			return { items: [{ id: "file_readable", status: "unverified", detail: "read_failed" }], coverage: { format: "text", bytesRead: 0, bytesTotal: 0, truncated: false }, headings: [] };
		}
		const text = normalizeExtractedText(raw);
		const items: DocumentInspectionItem[] = [{ id: "file_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		const textDigest = hashText(text);
		if (comparedTextDigest !== undefined) {
			items.push(textDigest === comparedTextDigest ? { id: "body_content_changed", status: "failed", detail: "content_unchanged" } : { id: "body_content_changed", status: "passed" });
		}
		return { items, coverage: { format: "text", bytesRead: Buffer.byteLength(raw, "utf8"), bytesTotal: Buffer.byteLength(raw, "utf8"), textDigest, formatDigest: textDigest, textLength: text.length, truncated: false }, headings: [] };
	},

	async outline({ filePath, byteBudget }): Promise<string[] | undefined> {
		const info = await readFile(filePath).catch(() => undefined);
		if (info === undefined || info.byteLength > byteBudget) return undefined;
		return [];
	},
};

/** 注册顺序即优先级；同一扩展名只允许一个检查器认领。 */
export const defaultInspectors: readonly FormatInspector[] = [docxInspector, markdownInspector, textInspector];
