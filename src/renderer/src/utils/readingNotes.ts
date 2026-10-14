/**
 * 笔记的呈现与提交规则（纯函数）。
 *
 * 主账在 DeepRead，界面只认服务端 `noteId` 与不透明 `revision`（CAS）。本层固化三条产品规则：
 *
 * 1. 「已保存」只有一个判据：服务端 `state="applied"` 且 note 带非空 `revision`。
 *    缺 state、applied 但无 revision、pending/unknown 一律不算已保存（契约 §笔记）。
 * 2. 未确认草稿按「原请求」重试：同一份载荷复用同一 requestId；内容改了就开新稿，
 *    旧稿原样留着可查看可丢弃——绝不静默覆盖（任务规则：改内容不得静默覆盖旧未知请求）。
 * 3. 截断的全文只能看，不能作为覆盖的底稿（任务规则：截断全文不用于覆盖）。
 */
import type { ReadingNoteDraft, ReadingNoteReadResult, ReadingNoteSummary, ReadingNoteWriteOperation, ReadingNoteWriteResult } from "../../../shared/types/reading";
import type { TranslationKey } from "../i18n";

/** 段落白名单：wire 只认这四个 id（主进程把中文别名归一到同一组，见 readingValidation.canonicalNoteSection）。 */
export const READING_NOTE_SECTIONS = [
	{ id: "quote", labelKey: "reading.noteSectionQuote" },
	{ id: "understanding", labelKey: "reading.noteSectionUnderstanding" },
	{ id: "connection", labelKey: "reading.noteSectionConnection" },
	{ id: "explore", labelKey: "reading.noteSectionExplore" },
] as const;

export type ReadingNoteSectionId = (typeof READING_NOTE_SECTIONS)[number]["id"];

/** 界面上只有白名单里的段落可选；未知段落（服务端未来新增）显示原文，不静默改写成默认段。 */
export function readingNoteSectionLabelKey(section: string): TranslationKey | null {
	const hit = READING_NOTE_SECTIONS.find((entry) => entry.id === section);
	return hit ? hit.labelKey : null;
}

export type ReadingNoteSaveState = "saved" | "pending" | "unknown" | "failed";

/**
 * 写回执 → 界面状态。`ok:true` 但没有 revision 不能显示已保存（服务端未给 CAS 凭据，
 * 后续更新无从校验），按 unknown 处理并保留用户原稿。
 */
export function readingNoteSaveState(result: ReadingNoteWriteResult): ReadingNoteSaveState {
	if (result.ok) return result.note.revision !== null && result.note.revision.length > 0 ? "saved" : "unknown";
	return result.draft ? "pending" : "failed";
}

/** 状态 → 文案 key；saved 也需要一句话（「已保存到 DeepRead」），避免只有一个对勾无说明。 */
export function readingNoteSaveStateKey(state: ReadingNoteSaveState): TranslationKey {
	switch (state) {
		case "saved":
			return "reading.noteSaved";
		case "pending":
			return "reading.notePending";
		case "unknown":
			return "reading.noteUnknown";
		case "failed":
		default:
			return "reading.noteWriteFailed";
	}
}

/** 读到的全文是否可作为覆盖/追加的底稿：截断时只能用来看，不能拿截断内容覆盖服务端全文。 */
export function canOverwriteFromReading(result: ReadingNoteReadResult | null): boolean {
	return result !== null && result.ok && result.truncated === false;
}

/** CAS 是否齐备：没有 revision 的笔记只能走 create，update/append 会被拒绝（决策在界面提前给出）。 */
export function readingNoteHasCas(summary: ReadingNoteSummary): boolean {
	return summary.revision !== null && summary.revision.length > 0;
}

/** 稳定的载荷签名：逐字段拼接，不依赖对象键顺序；用于判断「同一份载荷」。 */
export function readingNoteOperationSignature(operation: ReadingNoteWriteOperation): string {
	if (operation.op === "create") return ["create", operation.workId, operation.editionId, operation.concept, operation.chapter ?? "", operation.quote ?? "", operation.understanding ?? ""].join("\u0001");
	return [operation.op, operation.workId, operation.editionId, operation.noteId, operation.section, operation.content, operation.expectedRevision].join("\u0001");
}

/** 同一份载荷的未确认草稿（同书同目标同操作同内容）——重试必须复用它，而不是新开一份。 */
export function findReusableReadingDraft(drafts: readonly ReadingNoteDraft[], operation: ReadingNoteWriteOperation): ReadingNoteDraft | null {
	const signature = readingNoteOperationSignature(operation);
	return drafts.find((draft) => draft.workId === operation.workId && draft.editionId === operation.editionId && draft.op === operation.op && readingNoteOperationSignature(draft.operation) === signature) ?? null;
}

/** 本任务可见的草稿：版本内所有草稿；按书过滤由调用方给身份（切书后旧稿不可见也不被覆盖）。 */
export function readingNoteDraftsForBook(drafts: readonly ReadingNoteDraft[], identity: { workId: string; editionId: string }): ReadingNoteDraft[] {
	return drafts.filter((draft) => draft.workId === identity.workId && draft.editionId === identity.editionId);
}

/**
 * requestId 由界面生成后作为草稿身份（服务端台账同名）。格式必须落在主进程校验里：
 * `^[A-Za-z0-9_-]{1,128}$`。时间与非随机数由调用方传入，便于测试确定性。
 */
export function createReadingNoteRequestId(input: { now: number; nonce: string }): string {
	const stamp = Math.max(0, Math.floor(input.now)).toString(36);
	const nonce = input.nonce.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "0";
	return `rd-${stamp}-${nonce}`.slice(0, 128);
}

/** 提交计划：同载荷 → 复用原 requestId（重试原请求）；否则新 requestId（新稿，旧稿保留）。 */
export type ReadingNoteSubmitPlan = { kind: "retry"; requestId: string } | { kind: "new"; requestId: string };

export function planReadingNoteSubmit(input: { drafts: readonly ReadingNoteDraft[]; operation: ReadingNoteWriteOperation; now: number; nonce: string }): ReadingNoteSubmitPlan {
	const reusable = findReusableReadingDraft(input.drafts, input.operation);
	if (reusable) return { kind: "retry", requestId: reusable.requestId };
	return { kind: "new", requestId: createReadingNoteRequestId({ now: input.now, nonce: input.nonce }) };
}

export type ReadingNoteLocationHint = { label: string | null; hintKey: TranslationKey | null };

/**
 * 章节标签的呈现：旧标签一律原文显示；`unlocated` 时提示「未能定位到当前版本」。
 * 绝不因为标签里有章节名就宣称精准定位（任务规则）。
 */
export function readingNoteLocationHint(summary: { chapterLabel: string | null; unlocated: boolean; linkStatus: "linked" | "pending" | null }): ReadingNoteLocationHint {
	const label = summary.chapterLabel !== null && summary.chapterLabel.trim().length > 0 ? summary.chapterLabel : null;
	if (summary.unlocated) return { label, hintKey: "reading.noteUnlocatedHint" };
	if (summary.linkStatus === "pending") return { label, hintKey: "reading.noteLinkPendingHint" };
	return { label, hintKey: null };
}

/** 笔记列表分区：主账笔记与归属未知笔记必须分开显示（契约：单独显示，不合并）。 */
export function splitReadingNotes(notes: readonly ReadingNoteSummary[], unattributed: readonly ReadingNoteSummary[]): { notes: ReadingNoteSummary[]; unattributed: ReadingNoteSummary[] } {
	return { notes: [...notes], unattributed: [...unattributed] };
}

/** 默认段落：新建笔记默认「我的理解」（正文段落），用户可在白名单里改。 */
export const READING_NOTE_DEFAULT_SECTION: ReadingNoteSectionId = "understanding";

// ── 未发送输入的作用域与回执结算 ──────────────────────────────────────────────
//
// 输入槽的身份是「书 + 编辑目标」（key 由 readingScope.readingNoteInputKey 给出）。
// ACK 结算必须回到**发起时那个槽**去判断，而不是拿当前渲染的 setter 去清当前槽：
// 用户等待 ACK 期间完全可能继续输入、切目标、甚至切书。

/** 未发送的笔记输入（界面唯一形态；atom family 与 hook 共用这一个定义）。 */
export type ReadingNoteInput = { op: "create" | "update" | "append"; noteId: string | null; section: string; concept: string; chapterLabel: string; content: string };

/** 空输入槽：默认新建、「我的理解」段落。 */
export function emptyReadingNoteInput(): ReadingNoteInput {
	return { op: "create", noteId: null, section: READING_NOTE_DEFAULT_SECTION, concept: "", chapterLabel: "", content: "" };
}

/**
 * 原载荷快照的逐字节比较：不做 trim、不做同义归一。
 * 用户多打一个空格、多一个换行、换段落、换目标，都是「不同的稿」——旧 ACK 不得动它。
 */
export function readingNoteInputEquals(left: ReadingNoteInput, right: ReadingNoteInput): boolean {
	return left.op === right.op && left.noteId === right.noteId && left.section === right.section && left.concept === right.concept && left.chapterLabel === right.chapterLabel && left.content === right.content;
}

export type ReadingNoteAckDisposition = { clearInput: boolean; reason: "input-unchanged" | "input-changed" | "no-acked-slot" | "no-stored-slot" };

/** 已确认的原稿该不该清：只有「原槽还在、且仍是提交时那份原文」才清。 */
export function readingNoteAckDisposition(input: { acked: ReadingNoteInput | null; stored: ReadingNoteInput | null }): ReadingNoteAckDisposition {
	if (input.acked === null) return { clearInput: false, reason: "no-acked-slot" };
	if (input.stored === null) return { clearInput: false, reason: "no-stored-slot" };
	return readingNoteInputEquals(input.acked, input.stored) ? { clearInput: true, reason: "input-unchanged" } : { clearInput: false, reason: "input-changed" };
}

/**
 * 由 wire operation 反推它对应的输入槽与载荷（草稿重试用）。
 * 反推不出来的形状返回 null：宁可不清理输入槽，也不误清新稿。
 */
export function readingNoteInputFromOperation(operation: ReadingNoteWriteOperation): { targetId: string | null; input: ReadingNoteInput } | null {
	if (operation.op === "create") {
		const concept = operation.concept;
		const content = operation.understanding ?? "";
		return { targetId: null, input: { op: "create", noteId: null, section: READING_NOTE_DEFAULT_SECTION, concept, chapterLabel: operation.chapter ?? "", content } };
	}
	return { targetId: operation.noteId, input: { op: operation.op, noteId: operation.noteId, section: operation.section, concept: "", chapterLabel: "", content: operation.content } };
}
