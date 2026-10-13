/**
 * 注册式格式检查器：docx / Markdown / 纯文本。
 *
 * 判定原则（方案第 7 节 + 评审修正）：
 * - 只有「能证明的未授权改动」才记 failed：声明要保留的块在成果里缺失或正文被改；
 * - 无法验证的结构（未解析修订、文本框、重复标题）记 unverified，不虚构质量失败；
 * - 正文没变不判失败：仅格式改稿本来就不会改正文，正文/格式指纹分开记录；
 * - 预算超限、超时、未知格式同样记 unverified。状态聚合与预算由服务统一负责。
 */
import { readFile } from "node:fs/promises";
import { hashText } from "./documentWorkPaths";
import { containsXmlEntityDeclaration, listZipEntries, readZipEntries, ZIP_MAX_PARTS, type ZipBudget } from "./zipEntries";
import type { DocumentInspectionItem } from "../../shared/types/documentWork";

/** 基稿的一个可定位块：标题 + 该块正文指纹，用于逐块比较「保留内容是否被改」。 */
export type InspectorSection = { heading: string; textDigest: string };

export type InspectionCoverage = {
	format: string;
	bytesRead: number;
	bytesTotal: number;
	textDigest?: string;
	formatDigest?: string;
	textLength?: number;
	/** 本体的块大纲；下一轮改稿用它逐块校验保留内容。 */
	sections?: InspectorSection[];
	comparedToVersionId?: string;
	truncated: boolean;
};

export type InspectorOutput = {
	items: DocumentInspectionItem[];
	coverage: InspectionCoverage;
	headings: string[];
};

export type InspectorInput = {
	filePath: string;
	/** 成果文件本体预算（默认 32 MiB）。 */
	artifactByteBudget: number;
	/** OOXML 解压总量预算（默认 64 MiB）。 */
	unpackByteBudget: number;
	/** 单个 XML 部件预算（默认 8 MiB）。 */
	memberByteBudget: number;
	/** 结构检查截止时刻；到点按 timeout 记未验证，不把没算完的结果当结论。 */
	deadlineAt: number;
	comparedTo?: { versionId: string; textDigest?: string; sections?: readonly InspectorSection[] };
	/** 本轮声明必须保留的块（准备记录的 scope.preserve）。 */
	preserve?: readonly string[];
	/** 本轮显式允许改动的块；基稿里其余块默认视为必须保留。 */
	allow?: readonly string[];
};

export type FormatInspector = {
	id: string;
	version: string;
	/** 处理的扩展名（小写、含点）。注册式：新增格式只加检查器，不改服务分支。 */
	extensions: readonly string[];
	inspect(input: InspectorInput): Promise<InspectorOutput>;
	/** 只取块大纲（准备阶段做范围冲突与保留块校验），失败返回 undefined。 */
	analyze(input: { filePath: string; artifactByteBudget: number; unpackByteBudget: number; memberByteBudget: number; deadlineAt: number }): Promise<{ headings: string[]; sections: InspectorSection[] } | undefined>;
};

const DOCX_MEMBER_BUDGET_SHARE = 1;

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

/** 按标题切块：每个块的正文指纹只覆盖该标题到下一个标题之间的段落。 */
function buildSections(entries: readonly { heading?: string; text: string }[]): { headings: string[]; sections: InspectorSection[]; body: string[] } {
	const headings: string[] = [];
	const sections: InspectorSection[] = [];
	const body: string[] = [];
	let current: { heading: string; lines: string[] } | undefined;
	for (const entry of entries) {
		body.push(entry.text);
		if (entry.heading && entry.text.trim()) {
			headings.push(entry.text.trim());
			if (current) sections.push({ heading: current.heading, textDigest: hashText(normalizeExtractedText(current.lines.join("\n"))) });
			current = { heading: entry.text.trim(), lines: [] };
			continue;
		}
		if (current) current.lines.push(entry.text);
	}
	if (current) sections.push({ heading: current.heading, textDigest: hashText(normalizeExtractedText(current.lines.join("\n"))) });
	return { headings, sections, body };
}

function expired(deadlineAt: number): boolean {
	return Date.now() > deadlineAt;
}

/**
 * 逐块校验保留内容：只对「能同时定位到基稿块与本轮声明」的条目下结论。
 * 定位不到的条目不算违规（属于范围歧义，由准备阶段的范围校验负责）。
 */
function preservedBlockItem(input: { preserve: readonly string[]; allow: readonly string[]; baseSections: readonly InspectorSection[] | undefined; nextSections: readonly InspectorSection[] }): DocumentInspectionItem | undefined {
	// 新建轮没有基稿：没有「保留内容」这个概念，不产出检查项。
	if (input.baseSections === undefined) return undefined;
	const allowed = (heading: string): boolean => input.allow.some((entry) => matchesHeading(entry, heading));
	// 有效保留集合：显式声明的保留块 + 基稿里未被显式允许改动的块。
	// 「allow 与 preserve 都是空」不等于随便改：基稿已有的块默认全部保留，否则未授权改动会被漏判。
	const implicit = input.baseSections.filter((section) => !allowed(section.heading));
	const checkable = [...input.baseSections.filter((section) => input.preserve.some((entry) => matchesHeading(entry, section.heading))), ...implicit].filter((section, index, list) => list.findIndex((candidate) => candidate.heading === section.heading) === index);
	if (checkable.length === 0) return { id: "preserved_blocks_intact", status: "unverified", detail: "no_scope_to_verify" };
	for (const section of checkable) {
		const next = input.nextSections.find((candidate) => matchesHeading(section.heading, candidate.heading) || matchesHeading(candidate.heading, section.heading));
		if (!next) return { id: "preserved_blocks_intact", status: "failed", detail: "preserved_block_missing" };
		if (next.textDigest !== section.textDigest) return { id: "preserved_blocks_intact", status: "failed", detail: "preserved_block_changed" };
	}
	return { id: "preserved_blocks_intact", status: "passed" };
}

function normalizeForMatch(value: string): string {
	return value.replace(/[\s\u3000]+/g, "").toLowerCase();
}

function matchesHeading(reference: string, heading: string): boolean {
	const left = normalizeForMatch(reference);
	const right = normalizeForMatch(heading);
	if (!left || !right) return false;
	return left === right || left.includes(right) || right.includes(left);
}

async function readDocxParts(filePath: string, input: { artifactByteBudget: number; unpackByteBudget: number; memberByteBudget: number }): Promise<{ documentXml: string; stylesXml?: string; structure: string } | undefined> {
	// 包结构指纹覆盖整个 ZIP 成员表：正文相同但包里多了批注/图表属于格式变化。
	const headers = await listZipEntries(filePath);
	if (!headers || headers.length > ZIP_MAX_PARTS) return undefined;
	const budget: ZipBudget = { unpackByteBudget: input.unpackByteBudget * DOCX_MEMBER_BUDGET_SHARE, memberByteBudget: input.memberByteBudget };
	const parts = await readZipEntries(filePath, ["word/document.xml", "word/styles.xml"], budget);
	if (!parts) return undefined;
	const document = parts.get("word/document.xml");
	if (!document) return undefined;
	const documentXml = document.toString("utf8");
	if (containsXmlEntityDeclaration(documentXml)) return undefined;
	const structure = headers
		.map((header) => `${header.name}|${header.uncompressedSize}`)
		.sort()
		.join("|");
	return { documentXml, stylesXml: parts.get("word/styles.xml")?.toString("utf8"), structure };
}

function docxEntries(documentXml: string, styleNames: Map<string, string>): { heading?: string; text: string }[] {
	const entries: { heading?: string; text: string }[] = [];
	for (const paragraph of splitParagraphs(documentXml)) {
		const text = paragraphTexts(paragraph);
		const styleId = paragraphStyleId(paragraph);
		entries.push(styleId && isHeadingStyle(styleId, styleNames) ? { heading: text, text } : { text });
	}
	return entries;
}

export const docxInspector: FormatInspector = {
	id: "docx",
	version: "docx-2",
	extensions: [".docx", ".dotx"],

	async inspect(input): Promise<InspectorOutput> {
		const parts = await readDocxParts(input.filePath, input);
		if (!parts) {
			return { items: [{ id: "package_readable", status: "unverified", detail: "package_unreadable" }], coverage: { format: "docx", bytesRead: 0, bytesTotal: 0, truncated: true }, headings: [] };
		}
		const styleNames = styleHeadingMap(parts.stylesXml);
		const parsed = buildSections(docxEntries(parts.documentXml, styleNames));
		const text = normalizeExtractedText(parsed.body.join("\n"));
		const hasTrackedChanges = /<w:(?:ins|del)[\s>]/.test(parts.documentXml);
		const hasTextBoxes = parts.documentXml.includes("<w:txbxContent");
		const timedOut = expired(input.deadlineAt);
		const items: DocumentInspectionItem[] = [{ id: "package_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		// 无法验证的结构：记 unverified，不冒称通过也不虚构质量失败。
		items.push(hasTrackedChanges ? { id: "no_unresolved_tracked_changes", status: "unverified", detail: "tracked_changes" } : { id: "no_unresolved_tracked_changes", status: "passed" });
		items.push(hasTextBoxes ? { id: "no_text_boxes", status: "unverified", detail: "text_box_content" } : { id: "no_text_boxes", status: "passed" });
		const duplicates = duplicateHeadings(parsed.headings);
		items.push(duplicates.length === 0 ? { id: "no_duplicate_headings", status: "passed" } : { id: "no_duplicate_headings", status: "unverified", detail: "duplicate_heading" });
		// 基稿存在但没有块大纲：声明了保留内容却无法逐块比较，必须记未验证。
		const preserved =
			input.comparedTo && !input.comparedTo.sections
				? ({ id: "preserved_blocks_intact", status: "unverified", detail: "base_outline_missing" } satisfies DocumentInspectionItem)
				: preservedBlockItem({ preserve: input.preserve ?? [], allow: input.allow ?? [], baseSections: input.comparedTo?.sections, nextSections: parsed.sections });
		if (preserved) items.push(preserved);
		items.push(timedOut ? { id: "within_time_budget", status: "unverified", detail: "timeout" } : { id: "within_time_budget", status: "passed" });
		const textDigest = hashText(text);
		return {
			items,
			coverage: {
				format: "docx",
				bytesRead: parts.documentXml.length,
				bytesTotal: parts.documentXml.length,
				textDigest,
				formatDigest: hashText(`${parts.structure}|${skeletonOf(parts.documentXml)}`),
				textLength: text.length,
				sections: parsed.sections,
				...(input.comparedTo ? { comparedToVersionId: input.comparedTo.versionId } : {}),
				truncated: false,
			},
			headings: parsed.headings,
		};
	},

	async analyze({ filePath, unpackByteBudget, memberByteBudget, artifactByteBudget }): Promise<{ headings: string[]; sections: InspectorSection[] } | undefined> {
		const parts = await readDocxParts(filePath, { artifactByteBudget, unpackByteBudget, memberByteBudget });
		if (!parts) return undefined;
		const parsed = buildSections(docxEntries(parts.documentXml, styleHeadingMap(parts.stylesXml)));
		return { headings: parsed.headings, sections: parsed.sections };
	},
};

const MARKDOWN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;

function markdownEntries(raw: string): { heading?: string; text: string }[] {
	return raw
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line): { heading?: string; text: string } => {
			const match = line.match(MARKDOWN_HEADING_RE);
			return match ? { heading: match[2].trim(), text: match[2].trim() } : { text: line };
		});
}

function markdownStructure(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => classifyMarkdownLine(line))
		.join("\n");
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

export const markdownInspector: FormatInspector = {
	id: "markdown",
	version: "markdown-2",
	extensions: [".md", ".markdown", ".mdx"],

	async inspect(input): Promise<InspectorOutput> {
		const raw = await readFile(input.filePath, "utf8").catch(() => undefined);
		const bytes = raw === undefined ? 0 : Buffer.byteLength(raw, "utf8");
		if (raw === undefined || bytes > input.artifactByteBudget) {
			return { items: [{ id: "file_readable", status: "unverified", detail: "read_failed_or_over_budget" }], coverage: { format: "markdown", bytesRead: 0, bytesTotal: bytes, truncated: true }, headings: [] };
		}
		const parsed = buildSections(markdownEntries(raw));
		const text = normalizeExtractedText(raw);
		const timedOut = expired(input.deadlineAt);
		const items: DocumentInspectionItem[] = [{ id: "file_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		const duplicates = duplicateHeadings(parsed.headings);
		items.push(duplicates.length === 0 ? { id: "no_duplicate_headings", status: "passed" } : { id: "no_duplicate_headings", status: "unverified", detail: "duplicate_heading" });
		const preserved =
			input.comparedTo && !input.comparedTo.sections
				? ({ id: "preserved_blocks_intact", status: "unverified", detail: "base_outline_missing" } satisfies DocumentInspectionItem)
				: preservedBlockItem({ preserve: input.preserve ?? [], allow: input.allow ?? [], baseSections: input.comparedTo?.sections, nextSections: parsed.sections });
		if (preserved) items.push(preserved);
		items.push(timedOut ? { id: "within_time_budget", status: "unverified", detail: "timeout" } : { id: "within_time_budget", status: "passed" });
		return {
			items,
			coverage: {
				format: "markdown",
				bytesRead: bytes,
				bytesTotal: bytes,
				textDigest: hashText(text),
				formatDigest: hashText(markdownStructure(raw)),
				textLength: text.length,
				sections: parsed.sections,
				...(input.comparedTo ? { comparedToVersionId: input.comparedTo.versionId } : {}),
				truncated: false,
			},
			headings: parsed.headings,
		};
	},

	async analyze({ filePath, artifactByteBudget }): Promise<{ headings: string[]; sections: InspectorSection[] } | undefined> {
		const raw = await readFile(filePath, "utf8").catch(() => undefined);
		if (raw === undefined || Buffer.byteLength(raw, "utf8") > artifactByteBudget) return undefined;
		const parsed = buildSections(markdownEntries(raw));
		return { headings: parsed.headings, sections: parsed.sections };
	},
};

export const textInspector: FormatInspector = {
	id: "text",
	version: "text-2",
	extensions: [".txt", ".text", ".log"],

	async inspect(input): Promise<InspectorOutput> {
		const raw = await readFile(input.filePath, "utf8").catch(() => undefined);
		const bytes = raw === undefined ? 0 : Buffer.byteLength(raw, "utf8");
		if (raw === undefined || bytes > input.artifactByteBudget) {
			return { items: [{ id: "file_readable", status: "unverified", detail: "read_failed_or_over_budget" }], coverage: { format: "text", bytesRead: 0, bytesTotal: bytes, truncated: true }, headings: [] };
		}
		const text = normalizeExtractedText(raw);
		const items: DocumentInspectionItem[] = [{ id: "file_readable", status: "passed" }];
		items.push(text.length > 0 ? { id: "content_non_empty", status: "passed" } : { id: "content_non_empty", status: "failed", detail: "empty_body" });
		if (input.comparedTo) items.push({ id: "preserved_blocks_intact", status: "unverified", detail: "no_scope_to_verify" });
		items.push(expired(input.deadlineAt) ? { id: "within_time_budget", status: "unverified", detail: "timeout" } : { id: "within_time_budget", status: "passed" });
		const textDigest = hashText(text);
		return { items, coverage: { format: "text", bytesRead: bytes, bytesTotal: bytes, textDigest, formatDigest: textDigest, textLength: text.length, ...(input.comparedTo ? { comparedToVersionId: input.comparedTo.versionId } : {}), truncated: false }, headings: [] };
	},

	async analyze({ filePath, artifactByteBudget }): Promise<{ headings: string[]; sections: InspectorSection[] } | undefined> {
		const raw = await readFile(filePath).catch(() => undefined);
		if (raw === undefined || raw.byteLength > artifactByteBudget) return undefined;
		return { headings: [], sections: [] };
	},
};

/** 注册顺序即优先级；同一扩展名只允许一个检查器认领。 */
export const defaultInspectors: readonly FormatInspector[] = [docxInspector, markdownInspector, textInspector];
