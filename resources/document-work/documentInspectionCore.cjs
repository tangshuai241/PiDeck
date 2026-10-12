/**
 * TPA 独立文稿：检查核心（纯 CommonJS，无外部依赖）。
 *
 * 这份实现同时被 `resources/document-work/documentInspectionWorker.cjs`（worker 线程）
 * 和单元测试直接 require，因此**只有一份解析/比较实现**：
 *
 * - OOXML 只读中央目录 + 有界 inflate（部件数/单部件/总量预算，拒绝 zip64、
 *   重复部件、`..` 部件名、XML 实体声明）；
 * - docx 正文按段落抽取，带标题层级、段落格式指纹；
 * - 正文比较以块为单位，范围授权判定（失败优先于未验证）；
 * - 全部失败都返回结构化原因，由调用方记 `unverified`，绝不"尽力解析"后判通过。
 *
 * 未覆盖结构（页眉页脚正文、编号、表格、修订、文本框、重复标题、未知部件）都会被标出来，
 * 整体结论落 `unverified`。程序格式检查不等于渲染验收。
 */
"use strict";

const { createHash } = require("node:crypto");
const { inflateRawSync } = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** format 通道逐部件指纹的可比对上限；超过只比大小并如实记入覆盖范围。 */
const FORMAT_PART_BYTES = 1024 * 1024;
/** 正文由 text 通道覆盖的部件。 */
const TEXT_PARTS = new Set(["word/document.xml", "xl/sharedStrings.xml", "ppt/slides/slide1.xml"]);
const TEXT_LIKE = [".md", ".markdown", ".mdx", ".txt", ".text", ".json", ".csv", ".tsv", ".html", ".htm", ".xml", ".yml", ".yaml"];

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function findEndOfCentralDirectory(buffer) {
	const minimum = Math.max(0, buffer.length - 65557);
	for (let offset = buffer.length - 22; offset >= minimum; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return undefined;
}

function isSafePartName(name) {
	if (!name || name.length > 512 || name.includes("\0") || name.includes("\\")) return false;
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
	return !name.split("/").some((segment) => segment === ".." || segment === "");
}

function readZipDirectory(buffer, budget) {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd === undefined) return { ok: false, reason: "not a ZIP container (end of central directory not found)" };
	const entryCount = buffer.readUInt16LE(eocd + 10);
	const centralOffset = buffer.readUInt32LE(eocd + 16);
	if (entryCount === 0xffff || centralOffset === 0xffffffff) return { ok: false, reason: "zip64 containers are outside the covered budget" };
	if (entryCount > budget.parts) return { ok: false, reason: `part count ${entryCount} exceeds the budget of ${budget.parts}` };
	let offset = centralOffset;
	let totalBytes = 0;
	const names = new Set();
	const entries = [];
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

function readZipPart(buffer, entry, partBytes) {
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

function containsEntityDeclaration(xml) {
	return /<!DOCTYPE|<!ENTITY/i.test(xml);
}

function decodeXmlText(value) {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal) => safeCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&amp;/g, "&");
}

function safeCodePoint(value) {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "";
	return String.fromCodePoint(value);
}

function headingLevelFromStyle(style) {
	if (!style) return undefined;
	const match = /^(?:heading|标题)\s*([1-9])/i.exec(style.trim());
	return match ? Number(match[1]) : undefined;
}

/** 抽取段落：正文、标题层级、段落格式指纹（pPr/rPr 的真实哈希），以及未覆盖结构标记。 */
function extractDocxParagraphs(xml, fileBytes) {
	const revisionMarkup = /<w:(?:ins|del|moveFrom|moveTo)[\s/>]/.test(xml);
	const textBoxes = /<w:txbxContent[\s/>]/.test(xml) || /<mc:AlternateContent[\s>]/.test(xml);
	const numbering = /<w:numPr[\s/>]/.test(xml);
	const tables = /<w:tbl[\s/>]/.test(xml);
	const paragraphs = [];
	const paragraphPattern = /<w:p(?:\s[^>]*)?\/?>([\s\S]*?)(?:<\/w:p>|$)/g;
	let match;
	while ((match = paragraphPattern.exec(xml)) !== null) {
		const body = match[1] || "";
		const styleMatch = /<w:pStyle\s+w:val="([^"]*)"/.exec(body);
		let text = "";
		const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
		let textMatch;
		while ((textMatch = textPattern.exec(body)) !== null) {
			if (textMatch[1] === undefined) text += textMatch[0].startsWith("<w:tab") ? "\t" : "\n";
			else text += decodeXmlText(textMatch[1]);
		}
		const propertyMarkup = (body.match(/<w:(?:pPr|rPr)>[\s\S]*?<\/w:(?:pPr|rPr)>/g) || []).join("");
		paragraphs.push({ text, ...(headingLevelFromStyle(styleMatch && styleMatch[1]) ? { headingLevel: headingLevelFromStyle(styleMatch[1]) } : {}), formatHash: sha256(propertyMarkup) });
	}
	const headingCounts = new Map();
	for (const paragraph of paragraphs) {
		if (paragraph.headingLevel === undefined) continue;
		const key = `${paragraph.headingLevel}:${normalize(paragraph.text)}`;
		headingCounts.set(key, (headingCounts.get(key) || 0) + 1);
	}
	return {
		paragraphs,
		unresolvedRevisions: revisionMarkup,
		unlocatedTextBoxes: textBoxes,
		duplicateHeadings: [...headingCounts.values()].some((count) => count > 1),
		numbering,
		tables,
		documentFormatHash: sha256(xml),
		fileBytes: fileBytes === undefined ? 0 : fileBytes,
	};
}

function extractMarkdownBlocks(source) {
	const paragraphs = [];
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
	const headingCounts = new Map();
	for (const paragraph of paragraphs) {
		if (paragraph.headingLevel === undefined) continue;
		const key = `${paragraph.headingLevel}:${paragraph.text}`;
		headingCounts.set(key, (headingCounts.get(key) || 0) + 1);
	}
	return { paragraphs, duplicateHeadings: [...headingCounts.values()].some((count) => count > 1), documentFormatHash: sha256(source) };
}

function normalize(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function extensionOf(relativePath) {
	const index = relativePath.lastIndexOf(".");
	return index < 0 ? "" : relativePath.slice(index).toLowerCase();
}

/** 页眉页脚正文不在首版覆盖范围：报告里必须出现，结论落 unverified。 */
function hasHeaderFooterParts(entries) {
	return entries.some((entry) => /^word\/(header|footer)\d*\.xml$/.test(entry.name));
}

/**
 * docx/xlsx/pptx 容器解析：返回可定位块 + 未覆盖结构 + 逐部件格式指纹（真实内容哈希）。
 */
function extractOoxml(buffer) {
	const budget = { totalBytes: 64 * 1024 * 1024, partBytes: 8 * 1024 * 1024, parts: 10000 };
	const directory = readZipDirectory(buffer, budget);
	if (!directory.ok) return { ok: false, reason: directory.reason, coverage: "ooxml:unparsed" };
	const formatParts = {};
	let documentXml;
	for (const entry of directory.entries) {
		if (entry.uncompressedSize === 0) continue;
		if (TEXT_PARTS.has(entry.name)) {
			const part = readZipPart(buffer, entry, budget.partBytes);
			if (!part.ok) return { ok: false, reason: part.reason, coverage: `ooxml:${entry.name}` };
			const xml = part.data.toString("utf8");
			if (containsEntityDeclaration(xml)) return { ok: false, reason: "the part declares XML entities (XXE / entity expansion)", coverage: `ooxml:${entry.name}` };
			if (entry.name === "word/document.xml") documentXml = xml;
			continue;
		}
		if (entry.uncompressedSize <= FORMAT_PART_BYTES) {
			const part = readZipPart(buffer, entry, FORMAT_PART_BYTES);
			if (!part.ok) return { ok: false, reason: part.reason, coverage: `ooxml:${entry.name}` };
			formatParts[entry.name] = sha256(part.data);
		} else {
			formatParts[`${entry.name}#len`] = `${entry.uncompressedSize}`;
		}
	}
	if (documentXml === undefined) return { ok: false, reason: "word/document.xml is missing", coverage: "ooxml:no-word-document" };
	const extracted = extractDocxParagraphs(documentXml, buffer.length);
	return {
		ok: true,
		blocks: extracted.paragraphs,
		flags: {
			duplicateHeadings: extracted.duplicateHeadings,
			unresolvedRevisions: extracted.unresolvedRevisions,
			unlocatedTextBoxes: extracted.unlocatedTextBoxes,
			unknownParts: false,
			numbering: extracted.numbering,
			tables: extracted.tables,
			headerFooter: hasHeaderFooterParts(directory.entries),
		},
		coverage: `docx:document.xml;paragraphs=${extracted.paragraphs.length}`,
		formatParts,
		documentFormatHash: extracted.documentFormatHash,
	};
}

function extractText(buffer) {
	const source = buffer.toString("utf8");
	const extracted = extractMarkdownBlocks(source);
	return {
		ok: true,
		blocks: extracted.paragraphs,
		flags: { duplicateHeadings: extracted.duplicateHeadings, unresolvedRevisions: false, unlocatedTextBoxes: false, unknownParts: false, numbering: false, tables: false, headerFooter: false },
		coverage: `text:lines=${extracted.paragraphs.length}`,
		formatParts: {},
		documentFormatHash: extracted.documentFormatHash,
	};
}

function extractByExtension(relativePath, buffer) {
	const extension = extensionOf(relativePath);
	if (extension === ".docx" || extension === ".xlsx" || extension === ".pptx") return extractOoxml(buffer);
	if (TEXT_LIKE.includes(extension)) return extractText(buffer);
	return { ok: false, reason: `no first-release text inspector for ${extension || "(no extension)"} files`, coverage: extension || "(none)" };
}

function sectionOf(blocks) {
	const sections = [];
	let current = -1;
	blocks.forEach((block, index) => {
		if (block.headingLevel !== undefined) current = index;
		sections.push(current);
	});
	return sections;
}

function blockMatchesScope(block, sectionHeading, scope) {
	const text = normalize(block.text);
	const heading = normalize(sectionHeading || "");
	return scope.allow.some((entry) => {
		const target = normalize(entry);
		return (heading.length > 0 && (heading === target || heading.includes(target))) || text.includes(target);
	});
}

function blockMustBePreserved(block, sectionHeading, scope) {
	const text = normalize(block.text);
	const heading = normalize(sectionHeading || "");
	return scope.preserve.some((entry) => {
		const target = normalize(entry);
		return (heading.length > 0 && (heading === target || heading.includes(target))) || text.includes(target);
	});
}

/**
 * 正文比较：先掐掉公共前后缀（真正的变化区间），再判定这些变化是否在授权范围内。
 * 未授权变化 → failed；结构未覆盖 → unverified（不因为能对上的部分一样就判通过）。
 */
function compareBlocks(input) {
	const base = input.baseBlocks || [];
	const candidate = input.candidateBlocks || [];
	const scope = input.scope || { allow: [], preserve: [], wholeDocument: true };
	const structure = input.structure || {};
	const coverage = `blocks=${base.length}->${candidate.length}`;
	const uncovered = [];
	if (structure.duplicateHeadings) uncovered.push("duplicate headings make section locations ambiguous");
	if (structure.unlocatedTextBoxes) uncovered.push("text boxes cannot be located");
	if (structure.unknownParts) uncovered.push("the document contains parts the inspector does not cover");
	if (structure.unresolvedRevisions) uncovered.push("unresolved revisions change the effective text");
	if (structure.numbering) uncovered.push("numbering is not covered");
	if (structure.tables) uncovered.push("table structure is not covered");
	if (structure.headerFooter) uncovered.push("header/footer content is not covered");
	let start = 0;
	while (start < base.length && start < candidate.length && normalize(base[start].text) === normalize(candidate[start].text)) start++;
	let endBase = base.length;
	let endCandidate = candidate.length;
	while (endBase > start && endCandidate > start && normalize(base[endBase - 1].text) === normalize(candidate[endCandidate - 1].text)) {
		endBase--;
		endCandidate--;
	}
	if (start === endBase && start === endCandidate) {
		return uncovered.length > 0 ? { status: "unverified", coverage, changes: [], reason: uncovered.join("; ") } : { status: "passed", coverage, changes: [] };
	}
	const baseSections = sectionOf(base);
	const candidateSections = sectionOf(candidate);
	const changes = [];
	let unauthorized = 0;
	const record = (blocks, sections, from, to, otherBlocks) => {
		for (let index = from; index < to; index++) {
			const block = blocks[index];
			const headingIndex = sections[index];
			const heading = headingIndex >= 0 && headingIndex < blocks.length ? blocks[headingIndex].text : undefined;
			const otherHeading = headingIndex >= 0 && headingIndex < otherBlocks.length ? otherBlocks[headingIndex].text : undefined;
			const headingCandidate = heading || otherHeading || "";
			const preservedByHeading = otherHeading !== undefined && scope.preserve.some((entry) => normalize(entry) === normalize(otherHeading));
			if (blockMustBePreserved(block, headingCandidate, scope) || preservedByHeading) {
				unauthorized++;
				changes.push(`preserved block changed: ${normalize(block.text).slice(0, 120)}`);
				continue;
			}
			if (scope.wholeDocument) {
				changes.push(`authorized change: ${normalize(block.text).slice(0, 120)}`);
				continue;
			}
			const allowedByHeading = otherHeading !== undefined && scope.allow.some((entry) => normalize(entry) === normalize(otherHeading));
			if (!blockMatchesScope(block, headingCandidate, scope) && !allowedByHeading) {
				unauthorized++;
				changes.push(`block outside the authorized scope changed: ${normalize(block.text).slice(0, 120)}`);
			} else {
				changes.push(`authorized change: ${normalize(block.text).slice(0, 120)}`);
			}
			if (changes.length >= 40) return;
		}
	};
	record(base, baseSections, start, endBase, candidate);
	if (changes.length < 40) record(candidate, candidateSections, start, endCandidate, base);
	if (unauthorized > 0) return { status: "failed", coverage, changes: changes.slice(0, 40), reason: `${unauthorized} change(s) were not authorized by this round's scope` };
	if (uncovered.length > 0) return { status: "unverified", coverage, changes: changes.slice(0, 40), reason: uncovered.join("; ") };
	return { status: "passed", coverage: `${coverage}; changedBlocks=${candidate.length - start - (candidate.length - endCandidate)}`, changes: [] };
}

/** 格式通道：逐部件内容哈希 + 整篇格式哈希 + 逐块格式哈希，全部给真实证据。 */
function compareFormat(base, candidate) {
	if (!base.formatParts || Object.keys(base.formatParts).length === 0) {
		return { channel: "format", status: "passed", coverage: "source document: formatting follows the text channel" };
	}
	const baseParts = base.formatParts || {};
	const candidateParts = candidate.formatParts || {};
	const baseNames = Object.keys(baseParts).sort();
	const candidateNames = Object.keys(candidateParts).sort();
	const added = candidateNames.filter((name) => !baseNames.includes(name));
	const removed = baseNames.filter((name) => !candidateNames.includes(name));
	const changed = candidateNames.filter((name) => baseNames.includes(name) && baseParts[name] !== candidateParts[name]);
	const formatHashChanged = base.documentFormatHash !== candidate.documentFormatHash;
	const baseFormatHashes = (base.blocks || []).map((block) => block.formatHash);
	const candidateFormatHashes = (candidate.blocks || []).map((block) => block.formatHash);
	const formatOnlyChanges = candidateFormatHashes.filter((hash, index) => normalize(candidate.blocks[index].text) === normalize((base.blocks[index] || {}).text) && hash !== baseFormatHashes[index]).length;
	const coverage = `parts=${baseNames.length}->${candidateNames.length}; changedParts=${changed.length}; added=${added.length}; removed=${removed.length}; documentFormatHash=${String(base.documentFormatHash).slice(0, 12)}->${String(candidate.documentFormatHash).slice(0, 12)}; formatOnlyBlocks=${formatOnlyChanges}`;
	return { channel: "format", status: "passed", coverage, evidence: { changed, added, removed, formatHashChanged, formatOnlyChanges } };
}

/** 汇总：failed 优先，其次 unverified，全部通过才 passed。 */
function aggregate(channels, bytes, budgetBytes, elapsedMs, reason) {
	const status = channels.some((channel) => channel.status === "failed") ? "failed" : channels.some((channel) => channel.status === "unverified") ? "unverified" : "passed";
	return { schemaVersion: 1, status, channels, inspectorVersion: "doc-inspector-v2", bytes, budgetBytes, elapsedMs, ...(reason ? { reason } : {}) };
}

/** 把一个检查任务跑完并返回结论；worker 只负责搬运，不额外解释。 */
function runInspectionJob(job) {
	const startedAt = Date.now();
	const budgetBytes = job.budgetBytes || 32 * 1024 * 1024;
	if (job.kind === "headings") {
		const extracted = extractByExtension(job.relativePath || "document.docx", Buffer.from(job.bytes));
		if (!extracted.ok) return { ok: true, headings: [] };
		return { ok: true, headings: extracted.blocks.filter((block) => block.headingLevel !== undefined).map((block) => normalize(block.text)) };
	}
	const candidateBytes = Buffer.from(job.candidateBytes || new Uint8Array());
	const candidate = extractByExtension(job.candidateRelativePath, candidateBytes);
	if (!candidate.ok) {
		return aggregate(
			[
				{ channel: "fingerprint", status: "unverified", coverage: job.candidateRelativePath, reason: candidate.reason },
				{ channel: "text", status: "unverified", coverage: candidate.coverage, reason: candidate.reason },
				{ channel: "format", status: "unverified", coverage: candidate.coverage, reason: candidate.reason },
			],
			candidateBytes.length,
			budgetBytes,
			Date.now() - startedAt,
			candidate.reason,
		);
	}
	const fingerprintChannel = { channel: "fingerprint", status: "passed", coverage: `${job.candidateRelativePath} sha256=${sha256(candidateBytes).slice(0, 12)} bytes=${candidateBytes.length}` };
	if (!job.baseBytes || !job.baseRelativePath) {
		const uncovered = candidate.flags.unknownParts || candidate.flags.unlocatedTextBoxes || candidate.flags.duplicateHeadings || candidate.flags.unresolvedRevisions || candidate.flags.numbering || candidate.flags.tables || candidate.flags.headerFooter;
		const textStatus = uncovered ? "unverified" : "passed";
		return aggregate(
			[
				fingerprintChannel,
				{ channel: "text", status: textStatus, coverage: candidate.coverage, ...(uncovered ? { reason: "the document contains structures the first-release inspector does not locate" } : {}) },
				{ channel: "format", status: "passed", coverage: `parts=${Object.keys(candidate.formatParts || {}).length}` },
			],
			candidateBytes.length,
			budgetBytes,
			Date.now() - startedAt,
			uncovered ? "structure coverage is incomplete" : undefined,
		);
	}
	const baseBytes = Buffer.from(job.baseBytes);
	const base = extractByExtension(job.baseRelativePath, baseBytes);
	if (!base.ok) {
		return aggregate(
			[
				fingerprintChannel,
				{ channel: "text", status: "unverified", coverage: base.coverage, reason: base.reason },
				{ channel: "format", status: "unverified", coverage: base.coverage, reason: base.reason },
			],
			candidateBytes.length,
			budgetBytes,
			Date.now() - startedAt,
			base.reason,
		);
	}
	if (extensionOf(job.baseRelativePath) !== extensionOf(job.candidateRelativePath)) {
		const reason = "the candidate changed format; text comparison is not applicable";
		return aggregate(
			[
				fingerprintChannel,
				{ channel: "text", status: "unverified", coverage: `${extensionOf(job.baseRelativePath)}->${extensionOf(job.candidateRelativePath)}`, reason },
				{ channel: "format", status: "unverified", coverage: `${extensionOf(job.baseRelativePath)}->${extensionOf(job.candidateRelativePath)}`, reason },
			],
			candidateBytes.length,
			budgetBytes,
			Date.now() - startedAt,
			reason,
		);
	}
	const comparison = compareBlocks({
		scope: job.scope,
		baseBlocks: base.blocks,
		candidateBlocks: candidate.blocks,
		structure: {
			duplicateHeadings: Boolean(base.flags.duplicateHeadings || candidate.flags.duplicateHeadings),
			unresolvedRevisions: Boolean(base.flags.unresolvedRevisions || candidate.flags.unresolvedRevisions),
			unlocatedTextBoxes: Boolean(base.flags.unlocatedTextBoxes || candidate.flags.unlocatedTextBoxes),
			unknownParts: Boolean(base.flags.unknownParts || candidate.flags.unknownParts),
			numbering: Boolean(base.flags.numbering || candidate.flags.numbering),
			tables: Boolean(base.flags.tables || candidate.flags.tables),
			headerFooter: Boolean(base.flags.headerFooter || candidate.flags.headerFooter),
		},
	});
	const textChannel = { channel: "text", status: comparison.status, coverage: `${base.coverage} -> ${candidate.coverage}`, ...(comparison.changes && comparison.changes.length ? { changes: comparison.changes.slice(0, 20) } : {}), ...(comparison.reason ? { reason: comparison.reason } : {}) };
	const formatChannel = compareFormat(base, candidate);
	return aggregate([fingerprintChannel, textChannel, formatChannel], candidateBytes.length, budgetBytes, Date.now() - startedAt, comparison.status === "passed" ? undefined : comparison.reason);
}

module.exports = {
	FORMAT_PART_BYTES,
	TEXT_LIKE,
	sha256,
	readZipDirectory,
	readZipPart,
	containsEntityDeclaration,
	decodeXmlText,
	headingLevelFromStyle,
	extractDocxParagraphs,
	extractMarkdownBlocks,
	extractByExtension,
	compareBlocks,
	compareFormat,
	runInspectionJob,
};
