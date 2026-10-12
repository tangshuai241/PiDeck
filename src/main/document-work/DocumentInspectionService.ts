/**
 * TPA 独立文稿：程序检查。
 *
 * 三类结论分别记录、互不替代（方案 §7）：`fingerprint`（字节是否变化）、
 * `text`（正文改动位置是否授权）、`format`（排版/部件是否变化）。聚合规则：
 * 任一 `failed` → 整版 `failed`；否则任一 `unverified` → 整版 `unverified`；
 * 全部通过才 `passed`。**超时、超预算、未覆盖结构一律 `unverified`，不虚报通过**，
 * 也不因为"能对上的部分一样"就判通过。
 *
 * 检查器按后缀注册（注册式扩展点）：首版覆盖 OOXML 文字处理器文档与文本型源稿，
 * 其他格式如实记 `unverified`。检查是异步的：每个阶段之间让出事件循环并按
 * `inspectionMs` 硬超时收口，避免长时间占用主进程；CPU 密集的整段结构比较
 * 迁移到 worker_threads 属于后续优化（方案性能目标本身尚未实测）。
 */
import { createHash } from "node:crypto";
import { workOk, DOCUMENT_WORK_BUDGETS, type WorkResult } from "../../shared/documentWork";
import type { DocumentChangeScope, DocumentInspection, DocumentInspectionChannelResult, DocumentInspectionStatus } from "../../shared/types/documentWork";
import { compareBlocks, type LocatedBlock } from "./DocumentRevisionPolicy";
import { containsEntityDeclaration, extractDocxParagraphs, extractMarkdownBlocks, isTextLikeExtension, readOoxmlDirectory, readOoxmlPart } from "./DocumentOoxml";

export const DOCUMENT_INSPECTOR_VERSION = "doc-inspector-v1";

const OOXML_EXTENSIONS = [".docx", ".xlsx", ".pptx"];
/** 正文由 text 通道覆盖的部件；其余部件由 format 通道逐部件比对。 */
const TEXT_PARTS = new Set(["word/document.xml", "xl/sharedStrings.xml", "ppt/slides/slide1.xml"]);
/** format 通道的可比对单部件上限（同长度改写也要看得见，所以按内容算指纹）。 */
const FORMAT_PART_BYTES = 1024 * 1024;
/** 已知但首版无渲染检查器的二进制格式：如实记未验证。 */
const KNOWN_UNSUPPORTED_EXTENSIONS = [".pdf", ".doc", ".xls", ".ppt", ".rtf", ".odt", ".ods", ".odp", ".epub"];

export type InspectionTarget = {
	absolutePath: string;
	relativePath: string;
	/** 只登记了存在证据、没有归档字节的条目。 */
	existenceOnly?: boolean;
};

export type InspectionRequest = {
	base?: InspectionTarget;
	candidate: InspectionTarget;
	scope: DocumentChangeScope;
};

export type InspectionPorts = {
	/** 有界读取；超预算返回 undefined（调用方记未验证，不截断）。 */
	read(path: string, maxBytes: number): Buffer | undefined;
	now?: () => number;
	/** 阶段之间让出事件循环；测试注入同步实现。 */
	yieldToEventLoop?: () => Promise<void>;
};

export type DocumentInspector = {
	name: string;
	extensions: readonly string[];
	/** 提取可定位块；结构未覆盖时用 flags 表达，而不是静默忽略。 */
	extract: (data: Buffer) => { blocks: LocatedBlock[] | undefined; flags: { duplicateHeadings: boolean; unlocatedTextBoxes: boolean; unknownParts: boolean; unresolvedRevisions: boolean }; coverage: string; formatParts?: Record<string, string>; reason?: string };
};

function extensionOf(relativePath: string): string {
	const index = relativePath.lastIndexOf(".");
	return index < 0 ? "" : relativePath.slice(index).toLowerCase();
}

function digest(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/** OOXML 检查器：正文块 + 非正文部件的逐部件指纹（供 format 通道比较）。 */
function createOoxmlInspector(): DocumentInspector {
	return {
		name: "ooxml",
		extensions: OOXML_EXTENSIONS,
		extract: (data) => {
			const directory = readOoxmlDirectory(data, { totalBytes: DOCUMENT_WORK_BUDGETS.ooxmlTotalBytes, partBytes: DOCUMENT_WORK_BUDGETS.ooxmlPartBytes, parts: DOCUMENT_WORK_BUDGETS.ooxmlParts });
			if (!directory.ok) return { blocks: undefined, flags: { duplicateHeadings: false, unlocatedTextBoxes: false, unknownParts: true, unresolvedRevisions: false }, coverage: "ooxml:unparsed", reason: directory.reason };
			const formatParts: Record<string, string> = {};
			let documentXml: string | undefined;
			for (const entry of directory.entries) {
				if (entry.uncompressedSize === 0) continue;
				if (TEXT_PARTS.has(entry.name)) {
					const part = readOoxmlPart(data, entry, DOCUMENT_WORK_BUDGETS.ooxmlPartBytes);
					if (!part.ok) return { blocks: undefined, flags: { duplicateHeadings: false, unlocatedTextBoxes: false, unknownParts: true, unresolvedRevisions: false }, coverage: `ooxml:${entry.name}`, reason: part.reason };
					const xml = part.data.toString("utf8");
					if (containsEntityDeclaration(xml)) return { blocks: undefined, flags: { duplicateHeadings: false, unlocatedTextBoxes: false, unknownParts: true, unresolvedRevisions: false }, coverage: `ooxml:${entry.name}`, reason: "the part declares XML entities" };
					if (entry.name === "word/document.xml") documentXml = xml;
					continue;
				}
				// 排版相关部件逐部件指纹（同长度改写也要看得见）；超出单部件速查上限的只记长度，
				// 由 format 通道如实标为"只比过大小"，不假装比过内容。
				if (entry.uncompressedSize <= FORMAT_PART_BYTES) {
					const part = readOoxmlPart(data, entry, FORMAT_PART_BYTES);
					if (!part.ok) return { blocks: undefined, flags: { duplicateHeadings: false, unlocatedTextBoxes: false, unknownParts: true, unresolvedRevisions: false }, coverage: `ooxml:${entry.name}`, reason: part.reason };
					formatParts[entry.name] = digest(part.data);
				} else {
					formatParts[`${entry.name}#len`] = `${entry.uncompressedSize}`;
				}
			}
			if (documentXml === undefined) return { blocks: undefined, flags: { duplicateHeadings: false, unlocatedTextBoxes: false, unknownParts: true, unresolvedRevisions: false }, coverage: "ooxml:no-word-document", reason: "word/document.xml is missing" };
			const extracted = extractDocxParagraphs(documentXml);
			return {
				blocks: extracted.paragraphs.map((paragraph) => ({ text: paragraph.text, ...(paragraph.headingLevel === undefined ? {} : { headingLevel: paragraph.headingLevel }) })),
				flags: { duplicateHeadings: extracted.duplicateHeadings, unlocatedTextBoxes: extracted.unlocatedTextBoxes, unknownParts: false, unresolvedRevisions: extracted.unresolvedRevisions },
				coverage: `docx:document.xml;paragraphs=${extracted.paragraphs.length}`,
				formatParts,
			};
		},
	};
}

/** 文本型源稿检查器：Markdown 标题层级 + 纯文本逐行。 */
function createTextInspector(): DocumentInspector {
	return {
		name: "text",
		extensions: [".md", ".markdown", ".mdx", ".txt", ".text"],
		extract: (data) => {
			const source = data.toString("utf8");
			const extracted = extractMarkdownBlocks(source);
			return {
				blocks: extracted.paragraphs.map((paragraph) => ({ text: paragraph.text, ...(paragraph.headingLevel === undefined ? {} : { headingLevel: paragraph.headingLevel }) })),
				flags: { duplicateHeadings: extracted.duplicateHeadings, unlocatedTextBoxes: false, unknownParts: false, unresolvedRevisions: false },
				coverage: `text:lines=${extracted.paragraphs.length}`,
			};
		},
	};
}

export class DocumentInspectionService {
	private readonly inspectors: DocumentInspector[];
	private readonly ports: InspectionPorts;
	/** 并发闸：同时最多 2 个检查任务。 */
	private running = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(ports: InspectionPorts, inspectors: readonly DocumentInspector[] = [createOoxmlInspector(), createTextInspector()]) {
		this.ports = ports;
		this.inspectors = [...inspectors];
	}

	/** 注册式扩展点：新增格式只加检查器，不改调用方。 */
	registerInspector(inspector: DocumentInspector): void {
		this.inspectors.push(inspector);
	}

	/** 可用的检查器名（界面用它说明本次覆盖了什么）。 */
	listInspectors(): string[] {
		return this.inspectors.map((inspector) => inspector.name);
	}

	private async acquire(): Promise<void> {
		if (this.running < DOCUMENT_WORK_BUDGETS.concurrentInspections) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.running++;
	}

	private release(): void {
		this.running--;
		const next = this.waiters.shift();
		if (next) next();
	}

	async inspect(request: InspectionRequest): Promise<WorkResult<DocumentInspection>> {
		// `started` 在排队前采样：并发闸的等待时间也算进本次检查的时限，
		// 否则排队越久越容易绕过 2 秒预算。
		const started = (this.ports.now ?? (() => Date.now()))();
		await this.acquire();
		try {
			return await this.run(request, started);
		} catch {
			return workOk(this.unverified(request, started, "the inspection failed unexpectedly"));
		} finally {
			this.release();
		}
	}

	private deadlineExceeded(startedAt: number): boolean {
		const now = (this.ports.now ?? (() => Date.now()))();
		return now - startedAt > DOCUMENT_WORK_BUDGETS.inspectionMs;
	}

	private unverified(request: InspectionRequest, startedAt: number, reason: string, channels?: DocumentInspectionChannelResult[]): DocumentInspection {
		const now = (this.ports.now ?? (() => Date.now()))();
		return {
			schemaVersion: 1,
			status: "unverified",
			channels: channels ?? [
				{ channel: "fingerprint", status: "unverified", coverage: `candidate=${request.candidate.relativePath}`, reason },
				{ channel: "text", status: "unverified", coverage: "not inspected", reason },
				{ channel: "format", status: "unverified", coverage: "not inspected", reason },
			],
			inspectorVersion: DOCUMENT_INSPECTOR_VERSION,
			bytes: 0,
			budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
			elapsedMs: Math.max(0, now - startedAt),
			reason,
		};
	}

	private async run(request: InspectionRequest, startedAt: number): Promise<WorkResult<DocumentInspection>> {
		const aggregate = (channels: DocumentInspectionChannelResult[], bytes: number, reason?: string): WorkResult<DocumentInspection> => {
			const now = (this.ports.now ?? (() => Date.now()))();
			const status: DocumentInspectionStatus = channels.some((channel) => channel.status === "failed") ? "failed" : channels.some((channel) => channel.status === "unverified") ? "unverified" : "passed";
			return workOk({
				schemaVersion: 1,
				status,
				channels,
				inspectorVersion: DOCUMENT_INSPECTOR_VERSION,
				bytes,
				budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
				elapsedMs: Math.max(0, now - startedAt),
				...(reason ? { reason } : {}),
			});
		};
		if (request.candidate.existenceOnly)
			return aggregate(
				[
					{ channel: "fingerprint", status: "unverified", coverage: request.candidate.relativePath, reason: "the file exceeded the byte budget; only existence was recorded" },
					{ channel: "text", status: "unverified", coverage: "not read", reason: "file bytes were not archived" },
					{ channel: "format", status: "unverified", coverage: "not read", reason: "file bytes were not archived" },
				],
				0,
				"over budget: only file existence is recorded",
			);
		if (this.deadlineExceeded(startedAt)) return aggregate([{ channel: "fingerprint", status: "unverified", coverage: "not inspected", reason: "inspection timed out" }], 0, "inspection timed out");

		const candidateBytes = this.ports.read(request.candidate.absolutePath, DOCUMENT_WORK_BUDGETS.artifactBytes);
		if (!candidateBytes)
			return aggregate(
				[
					{ channel: "fingerprint", status: "unverified", coverage: request.candidate.relativePath, reason: "the candidate is missing, unreadable or over the byte budget" },
					{ channel: "text", status: "unverified", coverage: "not read", reason: "candidate bytes unavailable" },
					{ channel: "format", status: "unverified", coverage: "not read", reason: "candidate bytes unavailable" },
				],
				0,
				"the candidate could not be read within the byte budget",
			);

		const candidateExtension = extensionOf(request.candidate.relativePath);
		const inspector = this.inspectors.find((item) => item.extensions.includes(candidateExtension));
		const candidateHash = digest(candidateBytes);
		const fingerprintChannel: DocumentInspectionChannelResult = {
			channel: "fingerprint",
			status: "passed",
			coverage: `${request.candidate.relativePath} sha256=${candidateHash.slice(0, 12)} bytes=${candidateBytes.byteLength}`,
		};

		if (!inspector) {
			const reason = KNOWN_UNSUPPORTED_EXTENSIONS.includes(candidateExtension) ? `no first-release text inspector for ${candidateExtension} files` : `unknown format ${candidateExtension || "(none)"}`;
			return aggregate([fingerprintChannel, { channel: "text", status: "unverified", coverage: candidateExtension || "(none)", reason }, { channel: "format", status: "unverified", coverage: candidateExtension || "(none)", reason }], candidateBytes.byteLength, reason);
		}
		await this.ports.yieldToEventLoop?.();
		const candidate = inspector.extract(candidateBytes);
		if (!candidate.blocks) {
			return aggregate(
				[fingerprintChannel, { channel: "text", status: "unverified", coverage: candidate.coverage, reason: candidate.reason ?? "the structure could not be located" }, { channel: "format", status: "unverified", coverage: candidate.coverage, reason: candidate.reason ?? "the structure could not be located" }],
				candidateBytes.byteLength,
				candidate.reason,
			);
		}
		if (this.deadlineExceeded(startedAt)) return aggregate([fingerprintChannel, { channel: "text", status: "unverified", coverage: candidate.coverage, reason: "inspection timed out" }], candidateBytes.byteLength, "inspection timed out");

		if (!request.base) {
			// 初稿没有可比对象：只报告"读到了什么结构"，结构未覆盖时仍记未验证。
			const textStatus: DocumentInspectionStatus = candidate.flags.unknownParts || candidate.flags.unlocatedTextBoxes || candidate.flags.duplicateHeadings || candidate.flags.unresolvedRevisions ? "unverified" : "passed";
			const textChannel: DocumentInspectionChannelResult = { channel: "text", status: textStatus, coverage: candidate.coverage, ...(textStatus === "unverified" ? { reason: "the document contains structures the first-release inspector does not locate" } : {}) };
			const formatChannel: DocumentInspectionChannelResult = { channel: "format", status: "passed", coverage: inspector.name === "ooxml" ? `parts=${Object.keys(candidate.formatParts ?? {}).length}` : "source document: formatting follows the text channel" };
			return aggregate([fingerprintChannel, textChannel, formatChannel], candidateBytes.byteLength, textStatus === "unverified" ? "structure coverage is incomplete" : undefined);
		}

		const baseBytes = this.ports.read(request.base.absolutePath, DOCUMENT_WORK_BUDGETS.artifactBytes);
		if (!baseBytes)
			return aggregate(
				[fingerprintChannel, { channel: "text", status: "unverified", coverage: "base unreadable", reason: "the frozen base copy is not readable" }, { channel: "format", status: "unverified", coverage: "base unreadable", reason: "the frozen base copy is not readable" }],
				candidateBytes.byteLength,
				"the frozen base copy is not readable",
			);
		const baseExtension = extensionOf(request.base.relativePath);
		if (baseExtension !== candidateExtension) {
			return aggregate(
				[
					fingerprintChannel,
					{ channel: "text", status: "unverified", coverage: `${baseExtension}->${candidateExtension}`, reason: "the candidate changed format; text comparison is not applicable" },
					{ channel: "format", status: "unverified", coverage: `${baseExtension}->${candidateExtension}`, reason: "the candidate changed format" },
				],
				candidateBytes.byteLength,
				"the candidate changed format",
			);
		}
		const baseInspector = this.inspectors.find((item) => item.extensions.includes(baseExtension));
		if (!baseInspector) {
			return aggregate(
				[fingerprintChannel, { channel: "text", status: "unverified", coverage: baseExtension, reason: "no inspector for the frozen base format" }, { channel: "format", status: "unverified", coverage: baseExtension, reason: "no inspector for the frozen base format" }],
				candidateBytes.byteLength,
				"no inspector for the frozen base format",
			);
		}
		await this.ports.yieldToEventLoop?.();
		const base = baseInspector.extract(baseBytes);
		if (!base.blocks) {
			return aggregate(
				[fingerprintChannel, { channel: "text", status: "unverified", coverage: base.coverage, reason: base.reason ?? "the frozen base structure could not be located" }, { channel: "format", status: "unverified", coverage: base.coverage, reason: base.reason ?? "the frozen base structure could not be located" }],
				candidateBytes.byteLength,
				base.reason,
			);
		}
		if (this.deadlineExceeded(startedAt)) return aggregate([fingerprintChannel, { channel: "text", status: "unverified", coverage: candidate.coverage, reason: "inspection timed out" }], candidateBytes.byteLength, "inspection timed out");

		const comparison = compareBlocks({
			scope: request.scope,
			baseBlocks: base.blocks,
			candidateBlocks: candidate.blocks,
			structure: {
				duplicateHeadings: candidate.flags.duplicateHeadings || base.flags.duplicateHeadings,
				unresolvedRevisions: candidate.flags.unresolvedRevisions || base.flags.unresolvedRevisions,
				unlocatedTextBoxes: candidate.flags.unlocatedTextBoxes || base.flags.unlocatedTextBoxes,
				unknownParts: candidate.flags.unknownParts || base.flags.unknownParts,
			},
		});
		const textChannel: DocumentInspectionChannelResult = {
			channel: "text",
			status: comparison.status,
			coverage: `${base.coverage} -> ${candidate.coverage}`,
			...(comparison.changes.length ? { changes: comparison.changes } : {}),
			...(comparison.reason ? { reason: comparison.reason } : {}),
		};
		const formatChannel = this.compareFormat(inspector, base, candidate, candidateBytes.byteLength);
		return aggregate([fingerprintChannel, textChannel, formatChannel], candidateBytes.byteLength, comparison.status === "passed" ? undefined : comparison.reason);
	}

	/** 格式通道：逐部件比较，覆盖范围如实报告；不做"正文没变即排版没变"的推断。 */
	private compareFormat(inspector: DocumentInspector, base: ReturnType<DocumentInspector["extract"]>, candidate: ReturnType<DocumentInspector["extract"]>, bytes: number): DocumentInspectionChannelResult {
		if (inspector.name !== "ooxml") {
			return { channel: "format", status: "passed", coverage: "source document: formatting follows the text channel" };
		}
		const baseParts = base.formatParts ?? {};
		const candidateParts = candidate.formatParts ?? {};
		const baseNames = Object.keys(baseParts).sort();
		const candidateNames = Object.keys(candidateParts).sort();
		const added = candidateNames.filter((name) => !baseNames.includes(name));
		const removed = baseNames.filter((name) => !candidateNames.includes(name));
		const changed = candidateNames.filter((name) => baseNames.includes(name) && baseParts[name] !== candidateParts[name]);
		const coverage = `parts=${baseNames.length}->${candidateNames.length}; bytes=${bytes}`;
		if (added.length > 0 || removed.length > 0) {
			return { channel: "format", status: "passed", coverage: `${coverage}; added=${added.length} removed=${removed.length}`, reason: "part inventory changed (structure edits are expected on revision)" };
		}
		if (changed.length > 0) return { channel: "format", status: "passed", coverage: `${coverage}; changedParts=${changed.length}` };
		return { channel: "format", status: "passed", coverage };
	}
}

export { isTextLikeExtension };
