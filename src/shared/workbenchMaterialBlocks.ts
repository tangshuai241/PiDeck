/**
 * 工作台材料块的编解码（P04，主进程 / 渲染进程共用）。
 *
 * 用户消息里会持久化两类新的自包含块（发送时展开，模型读原文与来源；展示时折叠成 chip）：
 *   <reading_segment work_id="…" edition_id="…" content_version="…" …>\n原文\n</reading_segment>
 *   <personal_todo todo_id="…" subtodo_id="…" root_revision="…" …>\n正文\n</personal_todo>
 *
 * 设计要点：
 * - 块自带解析所需的全部身份字段与原文快照，展示/回看不依赖运行时状态；
 * - 正文按「`>` 后一个 `\n`、闭合标签前一个 `\n`」的固定框定写入，解析只剥这一层框定，
 *   原文内部的空白与换行逐字节保留（含 \r）；
 * - 正文用**可逆转义**（`body_encoding="xml-escaped"`：& < > → 实体）+ 解析端按标识解码，
 *   所以原文含本块闭合标签、另一材料块开标签、原有 `&lt;` 实体时都能逐字节 roundtrip，
 *   也不会被当成额外材料块；旧引用块（quoted_context）仍用原有的 sanitize 规则，行为不变；
 * - 不认识结构（缺必填属性）的块或未标编码的块按普通文本处理，不伪造来源、不抛异常。
 */

import type { PersonalTodoSourceKind, PersonalTodoStatus } from "./types/personalTodo";
import type { ReadingSegmentMaterial, ReadingSegmentVerify, TodoMaterial, WorkbenchMaterial } from "./types/workbenchMaterial";
import { decodeXmlAttribute, escapeXmlAttribute } from "./xmlBlockCodec";

export const READING_SEGMENT_TAG = "reading_segment";
export const PERSONAL_TODO_TAG = "personal_todo";

/** 正文编码标识：只有标记值正确的块才按编码解码，缺标记的块按原样处理（前向兼容）。 */
export const MATERIAL_BODY_ENCODING = "xml-escaped";

/** 正文可逆转义：& 先转（避免二次转义），再转 < >，解码按相反顺序。 */
function encodeMaterialBody(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeMaterialBody(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** 属性序列化：`key="值"`；null 一律省略（解析端还原成 null）。 */
function attribute(name: string, value: string | number | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return `${name}="${escapeXmlAttribute(String(value))}"`;
}

function joinAttributes(parts: Array<string | null>): string {
	return parts.filter((part): part is string => part !== null).join(" ");
}

/** 解析后的结果（material=结构化材料，text=块正文；start/end 为块在原文中的区间）。 */
export type WorkbenchMaterialBlock<M extends WorkbenchMaterial = WorkbenchMaterial> = {
	material: M;
	text: string;
	start: number;
	end: number;
};

/** 书段材料 → 自包含块（发送/存储形态）。 */
export function formatReadingSegmentBlock(material: ReadingSegmentMaterial): string {
	const attrs = joinAttributes([
		attribute("work_id", material.workId),
		attribute("edition_id", material.editionId),
		attribute("content_version", material.contentVersion),
		attribute("chapter_href", material.chapterHref),
		attribute("chapter_num", material.chapterNum),
		attribute("work_title", material.workTitle),
		attribute("edition_title", material.editionTitle),
		attribute("chapter_title", material.chapterTitle),
		attribute("verify", material.verify),
		attribute("start", material.start),
		attribute("end", material.end),
		attribute("captured_at", material.capturedAt),
		attribute("body_encoding", MATERIAL_BODY_ENCODING),
	]);
	return `<${READING_SEGMENT_TAG}${attrs ? ` ${attrs}` : ""}>\n${encodeMaterialBody(material.text)}\n</${READING_SEGMENT_TAG}>`;
}

/** 待办材料 → 自包含块（发送/存储形态）。 */
export function formatPersonalTodoBlock(material: TodoMaterial): string {
	const attrs = joinAttributes([
		attribute("todo_id", material.todoId),
		attribute("subtodo_id", material.subtodoId),
		attribute("root_revision", material.rootRevision),
		attribute("title", material.title),
		attribute("note", material.note),
		attribute("subtodo_text", material.subtodoText),
		attribute("subtodo_note", material.subtodoNote),
		attribute("status", material.status),
		attribute("subtodo_status", material.subtodoStatus),
		attribute("category", material.category),
		attribute("deadline", material.deadline),
		attribute("source_kind", material.source.kind),
		attribute("source_namespace", material.source.namespace),
		attribute("source_id", material.source.sourceId),
		attribute("captured_at", material.capturedAt),
		attribute("body_encoding", MATERIAL_BODY_ENCODING),
	]);
	return `<${PERSONAL_TODO_TAG}${attrs ? ` ${attrs}` : ""}>\n${encodeMaterialBody(material.text)}\n</${PERSONAL_TODO_TAG}>`;
}

/** 统一入口：按材料种类选择块形态（调用方无需再判别）。 */
export function formatWorkbenchMaterialBlock(material: WorkbenchMaterial): string {
	return material.kind === "reading_segment" ? formatReadingSegmentBlock(material) : formatPersonalTodoBlock(material);
}

/** 属性读取：只认 `name="…"`（值已被写入端转义）；缺失返回 null。 */
function readAttribute(attrs: string, name: string): string | null {
	const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
	return match ? decodeXmlAttribute(match[1] ?? "") : null;
}

function readRequired(attrs: string, name: string): string | null {
	const value = readAttribute(attrs, name);
	return value === null || value === "" ? null : value;
}

function readNumber(attrs: string, name: string): number | null {
	const raw = readAttribute(attrs, name);
	if (raw === null || raw === "") return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
}

const TODO_STATUSES = ["open", "done", "cancelled"] as const;
const SOURCE_KINDS = ["legacy", "canonical", "unknown"] as const;

/** typedArray.find 直接返回合法 union，不再 includes + as 强转。 */
function readTodoStatus(attrs: string, name: string): PersonalTodoStatus | null {
	const raw = readAttribute(attrs, name);
	return raw === null ? null : (TODO_STATUSES.find((value) => value === raw) ?? null);
}

function readSourceKind(attrs: string): PersonalTodoSourceKind {
	const raw = readAttribute(attrs, "source_kind");
	return (raw === null ? undefined : SOURCE_KINDS.find((value) => value === raw)) ?? "unknown";
}

function readVerify(attrs: string): ReadingSegmentVerify {
	const raw = readAttribute(attrs, "verify");
	if (raw === "exact" || raw === "normalized") return raw;
	return "unverified";
}

/** 块正文：带编码标识的按解码还原（逐字节），未标编码的按原样（兼容旧写入）。 */
function readMaterialBody(attrs: string, raw: string): string {
	return readAttribute(attrs, "body_encoding") === MATERIAL_BODY_ENCODING ? decodeMaterialBody(raw) : raw;
}

/** 块正文区间：`>` 后一个 `\n`、`</tag>` 前一个 `\n` 是框定，只剥这一层。 */
const READING_SEGMENT_RE = /<reading_segment\b([^>]*)>\n([\s\S]*?)\n<\/reading_segment>/g;
const PERSONAL_TODO_RE = /<personal_todo\b([^>]*)>\n([\s\S]*?)\n<\/personal_todo>/g;

/** 解析全部书段材料块；缺必填身份（work/edition/version/href/capturedAt）的块跳过。 */
export function parseReadingSegmentMaterialBlocks(text: string): WorkbenchMaterialBlock<ReadingSegmentMaterial>[] {
	if (!text.includes(`<${READING_SEGMENT_TAG}`)) return [];
	const blocks: WorkbenchMaterialBlock<ReadingSegmentMaterial>[] = [];
	const re = new RegExp(READING_SEGMENT_RE.source, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const attrs = match[1] ?? "";
		const workId = readRequired(attrs, "work_id");
		const editionId = readRequired(attrs, "edition_id");
		const contentVersion = readRequired(attrs, "content_version");
		const chapterHref = readRequired(attrs, "chapter_href");
		const capturedAt = readRequired(attrs, "captured_at");
		if (!workId || !editionId || !contentVersion || !chapterHref || !capturedAt) continue;
		const material: ReadingSegmentMaterial = {
			kind: "reading_segment",
			workId,
			editionId,
			contentVersion,
			chapterHref,
			chapterNum: readNumber(attrs, "chapter_num"),
			workTitle: readAttribute(attrs, "work_title"),
			editionTitle: readAttribute(attrs, "edition_title"),
			chapterTitle: readAttribute(attrs, "chapter_title"),
			verify: readVerify(attrs),
			start: readNumber(attrs, "start"),
			end: readNumber(attrs, "end"),
			text: readMaterialBody(attrs, match[2] ?? ""),
			capturedAt,
		};
		blocks.push({ material, text: material.text, start: match.index, end: match.index + match[0].length });
	}
	return blocks;
}

/** 解析全部待办材料块；缺必填身份（todoId/rootRevision/capturedAt）的块跳过。 */
export function parsePersonalTodoMaterialBlocks(text: string): WorkbenchMaterialBlock<TodoMaterial>[] {
	if (!text.includes(`<${PERSONAL_TODO_TAG}`)) return [];
	const blocks: WorkbenchMaterialBlock<TodoMaterial>[] = [];
	const re = new RegExp(PERSONAL_TODO_RE.source, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const attrs = match[1] ?? "";
		const todoId = readRequired(attrs, "todo_id");
		const rootRevision = readAttribute(attrs, "root_revision");
		const capturedAt = readRequired(attrs, "captured_at");
		if (!todoId || rootRevision === null || !capturedAt) continue;
		const material: TodoMaterial = {
			kind: "todo",
			todoId,
			subtodoId: readAttribute(attrs, "subtodo_id"),
			rootRevision,
			title: readAttribute(attrs, "title") ?? "",
			note: readAttribute(attrs, "note") ?? "",
			subtodoText: readAttribute(attrs, "subtodo_text"),
			subtodoNote: readAttribute(attrs, "subtodo_note"),
			status: readTodoStatus(attrs, "status") ?? "open",
			subtodoStatus: readTodoStatus(attrs, "subtodo_status"),
			category: readAttribute(attrs, "category"),
			deadline: readAttribute(attrs, "deadline"),
			source: { kind: readSourceKind(attrs), namespace: readAttribute(attrs, "source_namespace"), sourceId: readAttribute(attrs, "source_id") },
			text: readMaterialBody(attrs, match[2] ?? ""),
			capturedAt,
		};
		blocks.push({ material, text: material.text, start: match.index, end: match.index + match[0].length });
	}
	return blocks;
}
