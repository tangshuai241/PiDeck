/**
 * 工作台材料契约（P04，纯类型 + 纯函数，不 import 运行时）。
 *
 * 定位：用户从阅读页选中的原文、或从待办详情选中的事项，作为「一次性材料」带入明确目标
 * Pi 会话的输入框。材料是**发送时快照**：带完整来源身份 + 原文，发送后普通下一轮不再附加。
 *
 * 边界：
 * - 材料不是 Pi 历史消息：绝不伪造 messageId，也不把材料登记成会话消息；
 * - 阅读材料带 workId+editionId+contentVersion 三件套，版本变化不把旧书材料当新书；
 * - 待办材料带 todoId/subtodoId/rootRevision/source 原样身份，只带入、不执行任务、不改状态；
 * - `text` 是逐字节保留的原文快照（含换行），发送与回看都以它为准；
 * - 本文件不 import 任何运行时模块；待办字段复用 personalTodo 纯类型。
 */

import type { PersonalTodoSourceKind, PersonalTodoStatus } from "./personalTodo";

/** 引文核验档位：exact/normalized=服务端核验通过（偏移可用）；unverified=未核验（偏移必须为 null）。 */
export type ReadingSegmentVerify = "exact" | "normalized" | "unverified";

/** 书段材料：阅读页选中原文的快照。 */
export type ReadingSegmentMaterial = {
	kind: "reading_segment";
	workId: string;
	editionId: string;
	/** 内容版本（服务端 sha256 口径），材料永远属于这一份正文。 */
	contentVersion: string;
	workTitle: string | null;
	editionTitle: string | null;
	chapterHref: string;
	chapterNum: number | null;
	chapterTitle: string | null;
	/** 服务端核验给出的 code point 偏移；未核验时为 null（绝不猜位置）。 */
	start: number | null;
	end: number | null;
	verify: ReadingSegmentVerify;
	/** 选中原文快照（逐字节保留换行，不做折叠/裁剪）。 */
	text: string;
	capturedAt: string;
};

/** 待办材料来源子集（wire `source`，原样保留；不携带云端 raw 正文）。 */
export type TodoMaterialSource = {
	kind: PersonalTodoSourceKind;
	namespace: string | null;
	sourceId: string | null;
};

/** 待办材料：父项或一层子项的快照（不执行任务、不自动勾选）。 */
export type TodoMaterial = {
	kind: "todo";
	todoId: string;
	/** 选中子项的云端身份；父项带入时为 null。 */
	subtodoId: string | null;
	/** 整族 CAS 键（wire root_revision），原样保留、不解析。 */
	rootRevision: string;
	/** 根项标题（原文）。 */
	title: string;
	/** 根项备注（原文，空串保留）。 */
	note: string;
	/** 选中子项文本（父项带入时为 null）。 */
	subtodoText: string | null;
	/** 选中子项备注（父项带入时为 null）。 */
	subtodoNote: string | null;
	status: PersonalTodoStatus;
	subtodoStatus: PersonalTodoStatus | null;
	category: string | null;
	deadline: string | null;
	source: TodoMaterialSource;
	/** 带入模型与回看的正文快照（标题/子项/备注，逐字节保留）。 */
	text: string;
	capturedAt: string;
};

export type WorkbenchMaterial = ReadingSegmentMaterial | TodoMaterial;

/**
 * 材料判同键：同一目标会话内按「有效快照」去重，`capturedAt` 只是登记时间，不参与判同。
 *
 * 为什么不能只按身份字段（todoId/subtodoId/rootRevision）：离线乐观编辑可以在 revision 不变时
 * 改标题/备注/状态/子项文本；只按身份会把旧快照当成同一份保留，新的编辑永远进不了输入框。
 * 因此待办键包含全部内容字段（含 source），书段键包含版本身份 + 核验档位 + 偏移 + 原文。
 */
export function workbenchMaterialKey(material: WorkbenchMaterial): string {
	if (material.kind === "reading_segment") {
		return `reading_segment:${JSON.stringify({
			workId: material.workId,
			editionId: material.editionId,
			contentVersion: material.contentVersion,
			workTitle: material.workTitle,
			editionTitle: material.editionTitle,
			chapterHref: material.chapterHref,
			chapterNum: material.chapterNum,
			chapterTitle: material.chapterTitle,
			start: material.start,
			end: material.end,
			verify: material.verify,
			text: material.text,
		})}`;
	}
	// source 的字段顺序由调用方决定：展开成固定序字符串，避免对象字面量键序不同导致误判
	const sourceKey = `${material.source.kind}\u0000${material.source.namespace ?? ""}\u0000${material.source.sourceId ?? ""}`;
	return `todo:${JSON.stringify({
		todoId: material.todoId,
		subtodoId: material.subtodoId,
		rootRevision: material.rootRevision,
		title: material.title,
		note: material.note,
		subtodoText: material.subtodoText,
		subtodoNote: material.subtodoNote,
		status: material.status,
		subtodoStatus: material.subtodoStatus,
		category: material.category,
		deadline: material.deadline,
		source: sourceKey,
		text: material.text,
	})}`;
}

/** 首个非空行（材料标签用）：压平空白、去首尾。 */
function firstNonEmptyLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.find((line) => line.length > 0) ?? ""
	);
}

/**
 * 材料短标签（chip / 折叠后的人读文本共用）。
 *
 * - 书段：优先章节标题，缺失时取原文首个非空行；
 * - 待办：父项标题；子项再拼子项文本首行，便于区分同父的多个子项。
 */
export function workbenchMaterialLabel(material: WorkbenchMaterial): string {
	if (material.kind === "reading_segment") {
		const chapter = material.chapterTitle?.trim();
		return chapter && chapter.length > 0 ? chapter : firstNonEmptyLine(material.text);
	}
	const base = material.title.trim() || firstNonEmptyLine(material.text);
	const subtodo = material.subtodoText ? firstNonEmptyLine(material.subtodoText) : "";
	return subtodo ? `${base} · ${subtodo}` : base;
}

/** 材料来源一句话（回看/预览用）：书段给书与章节，待办给事项身份，都不含路径。 */
export function workbenchMaterialSourceLine(material: WorkbenchMaterial): string {
	if (material.kind === "reading_segment") {
		const work = material.workTitle?.trim() || material.workId;
		const chapter = material.chapterTitle?.trim() || (material.chapterNum !== null ? `#${material.chapterNum}` : material.chapterHref);
		return `${work} · ${chapter}`;
	}
	const subtodo = material.subtodoId ? ` (${material.subtodoId})` : "";
	return `${material.title}${subtodo}`;
}
