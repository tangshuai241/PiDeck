/**
 * 笔记规则：已保存判据（applied + revision）、草稿身份（同载荷重试/改内容新稿）、
 * 截断不作覆盖底稿、未定位只按原文标签显示。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里创建的对象属于另一个 realm；先归一成纯 JSON 再比对。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const notes = loadTsCommonJs("src/renderer/src/utils/readingNotes.ts");

const summary = { noteId: "n_1", source: "deepread", name: "概念", chapterLabel: "5.标题", revision: "sha256:aa", updatedAt: null, unlocated: false, linkStatus: "linked" };

function operationCreate(overrides = {}) {
	return { op: "create", workId: "w1", editionId: "e1", concept: "概念", chapter: "5.标题", quote: null, understanding: "正文", ...overrides };
}

function draft(overrides = {}) {
	return { requestId: "rd-old", workId: "w1", editionId: "e1", noteId: null, op: "create", section: null, content: "正文", operation: operationCreate(), updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

test("已保存判据：只有 applied 且 revision 非空才算 saved", () => {
	assert.equal(notes.readingNoteSaveState({ ok: true, note: summary, requestId: "rd-1" }), "saved");
	assert.equal(notes.readingNoteSaveState({ ok: true, note: { ...summary, revision: null }, requestId: "rd-1" }), "unknown", "applied 但缺 revision 不算已保存");
	assert.equal(notes.readingNoteSaveState({ ok: false, error: { code: "unknownOutcome", message: "x" }, draft: draft() }), "pending", "未确认但有落盘草稿 → 待确认");
	assert.equal(notes.readingNoteSaveState({ ok: false, error: { code: "writeFailed", message: "x" } }), "failed");
});

test("段落白名单：四个段落各有文案，未知段落返回 null（不静默改写）", () => {
	assert.deepEqual([...notes.READING_NOTE_SECTIONS.map((section) => section.id)], ["quote", "understanding", "connection", "explore"]);
	assert.equal(notes.readingNoteSectionLabelKey("connection"), "reading.noteSectionConnection");
	assert.equal(notes.readingNoteSectionLabelKey("future-section"), null);
	assert.equal(notes.readingNoteSectionLabelKey("引用原文"), null, "中文别名由主进程归一，界面只发 canonical id");
});

test("草稿身份：同载荷复用原 requestId，改内容开新稿（旧稿不被覆盖）", () => {
	const drafts = [draft()];
	const same = plain(notes.planReadingNoteSubmit({ drafts, operation: operationCreate(), now: 1700000000000, nonce: "abcdef" }));
	assert.deepEqual(same, { kind: "retry", requestId: "rd-old" }, "同一份载荷重交必须复用原请求");
	const changed = plain(notes.planReadingNoteSubmit({ drafts, operation: operationCreate({ understanding: "改过的正文" }), now: 1700000000000, nonce: "abcdef" }));
	assert.equal(changed.kind, "new");
	assert.notEqual(changed.requestId, "rd-old", "改内容必须新开草稿，不能盖掉旧身份");
	// 不同目标笔记即便内容相同也不算同一份载荷
	const updateDraft = [draft({ requestId: "rd-up", noteId: "n_1", op: "append", section: "explore", content: "追加", operation: { op: "append", workId: "w1", editionId: "e1", noteId: "n_1", section: "explore", content: "追加", expectedRevision: "sha256:aa" } })];
	assert.deepEqual(plain(notes.planReadingNoteSubmit({ drafts: updateDraft, operation: { op: "append", workId: "w1", editionId: "e1", noteId: "n_1", section: "explore", content: "追加", expectedRevision: "sha256:aa" }, now: 1, nonce: "x" })), { kind: "retry", requestId: "rd-up" });
	assert.equal(notes.planReadingNoteSubmit({ drafts: updateDraft, operation: { op: "append", workId: "w1", editionId: "e1", noteId: "n_2", section: "explore", content: "追加", expectedRevision: "sha256:aa" }, now: 1, nonce: "x" }).kind, "new");
});

test("requestId：落在主进程校验的形状里（字母数字_-.，长度有界）", () => {
	const id = notes.createReadingNoteRequestId({ now: 1700000000000, nonce: "a b/c!d_e-f" });
	assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
	assert.ok(id.length <= 128);
	const long = notes.createReadingNoteRequestId({ now: 1700000000000, nonce: "x".repeat(200) });
	assert.match(long, /^[A-Za-z0-9_-]{1,128}$/);
});

test("截断全文不能作覆盖底稿；CAS 缺失时只能新建", () => {
	assert.equal(notes.canOverwriteFromReading({ ok: true, note: summary, content: "全文", truncated: false }), true);
	assert.equal(notes.canOverwriteFromReading({ ok: true, note: summary, content: "截断", truncated: true }), false);
	assert.equal(notes.canOverwriteFromReading(null), false);
	assert.equal(notes.readingNoteHasCas(summary), true);
	assert.equal(notes.readingNoteHasCas({ ...summary, revision: null }), false);
	assert.equal(notes.readingNoteHasCas({ ...summary, revision: "" }), false);
});

test("定位呈现：旧标签原文显示，未定位/待确认各自给提示，不宣称精准定位", () => {
	assert.deepEqual(plain(notes.readingNoteLocationHint({ chapterLabel: "5.标题", unlocated: true, linkStatus: "linked" })), { label: "5.标题", hintKey: "reading.noteUnlocatedHint" });
	assert.deepEqual(plain(notes.readingNoteLocationHint({ chapterLabel: "5.标题", unlocated: false, linkStatus: "pending" })), { label: "5.标题", hintKey: "reading.noteLinkPendingHint" });
	assert.deepEqual(plain(notes.readingNoteLocationHint({ chapterLabel: "  ", unlocated: false, linkStatus: "linked" })), { label: null, hintKey: null });
	assert.deepEqual(plain(notes.readingNoteLocationHint({ chapterLabel: null, unlocated: false, linkStatus: null })), { label: null, hintKey: null });
});

test("草稿按书过滤：别的书的草稿不出现在当前书，也不被覆盖", () => {
	const list = [draft(), draft({ requestId: "rd-b", editionId: "e2", operation: operationCreate({ editionId: "e2" }) })];
	assert.deepEqual([...notes.readingNoteDraftsForBook(list, { workId: "w1", editionId: "e1" }).map((entry) => entry.requestId)], ["rd-old"]);
});
