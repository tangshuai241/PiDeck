/**
 * 笔记 hook 的行为复现：ACK 必须按「发起的书 + 编辑目标/输入槽 + 原载荷快照」结算。
 *
 * 上一轮的缺口：`applyWriteResult` 在 saved 时无条件清空*当前*输入槽并把*当前*编辑目标置空——
 * 用户等待 ACK 期间继续输入或切换目标时，新稿会被旧 ACK 清掉；切书后回来还会永久 pending。
 * 本文件同时覆盖「写入被拒绝保留原稿」「未确认不算已保存」「未发送输入按作用域隔离」。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { createReadingHookHarness } from "./helpers/readingHookHost.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => nextTask();

const NOTE = { noteId: "n_1", source: "deepread", name: "概念", chapterLabel: "5.标题", revision: "sha256:aa", updatedAt: null, unlocated: false, linkStatus: "linked" };

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createClient(options = {}) {
	const calls = { listNotes: [], listNoteDrafts: 0, writeNote: [], resumeNoteDraft: [], discardNoteDraft: [] };
	let writeImpl = options.writeNote ?? (async () => ({ ok: true, note: NOTE, requestId: "rd-1" }));
	return {
		calls,
		listNotes: async (workId, editionId) => {
			calls.listNotes.push({ workId, editionId });
			return { ok: true, notes: [NOTE], unattributed: [] };
		},
		readNote: async () => ({ ok: true, note: NOTE, content: "正文", truncated: false }),
		listNoteDrafts: async () => {
			calls.listNoteDrafts += 1;
			return { ok: true, drafts: [], issue: null };
		},
		writeNote: async (input) => {
			calls.writeNote.push(plain(input));
			return writeImpl(input);
		},
		resumeNoteDraft: async (ref) => {
			calls.resumeNoteDraft.push(plain(ref));
			return { ok: false, error: { code: "unknownOutcome", message: "x" } };
		},
		discardNoteDraft: async (ref) => {
			calls.discardNoteDraft.push(plain(ref));
			return { ok: true, discarded: true };
		},
		setWriteImpl(next) {
			writeImpl = next;
		},
	};
}

/** 挂载宿主：身份可切换（切书 = 换 props，atom 按 bookKey 分族）。 */
function mount(client, identity = { workId: "w1", editionId: "e1" }) {
	const harness = createReadingHookHarness();
	const { useReadingNotes } = harness.load("src/renderer/src/hooks/useReadingNotes.ts");
	let current = identity;
	let notes = harness.render(() => useReadingNotes({ client, ...current }));
	return {
		harness,
		get notes() {
			return notes;
		},
		render: (next) => {
			if (next) current = next;
			notes = harness.render(() => useReadingNotes({ client, ...current }));
			return notes;
		},
	};
}

test("写入被拒绝：保留原稿、给出结构化失败、不显示已保存", async () => {
	const client = createClient({ writeNote: async () => Promise.reject(new Error("ipc down")) });
	const page = mount(client);
	await tick();
	page.render();
	assert.equal(client.calls.listNoteDrafts, 1, "打开页面读一次草稿列表");

	page.render().setConcept("概念");
	page.render().setContent("一段理解");
	const submitting = page.render();
	assert.equal(submitting.canSubmit, true);
	await submitting.submit().catch(() => {});
	const after = page.render();
	assert.equal(after.input.content, "一段理解", "失败必须保留用户原稿");
	assert.equal(after.input.concept, "概念");
	assert.equal(after.submitState.pending, false, "在飞标记必须收尾");
	assert.equal(after.submitState.lastState, "failed", "IPC 拒绝是失败，不是已保存");
	assert.equal(after.submitState.error?.code, "internalError");
});

test("服务端未确认（pending 草稿）：保留原稿、列为未确认草稿，不显示已保存", async () => {
	const draft = {
		requestId: "rd-9",
		origin: "http://127.0.0.1:18965",
		user: "default",
		workId: "w1",
		editionId: "e1",
		noteId: null,
		op: "create",
		section: null,
		content: "一段理解",
		chapterLabel: "5.标题",
		updatedAt: "2026-10-14T10:00:00.000Z",
		operation: { op: "create", workId: "w1", editionId: "e1", concept: "概念", chapter: "5.标题", quote: null, understanding: "一段理解" },
	};
	const client = createClient({ writeNote: async () => ({ ok: false, error: { code: "unknownOutcome", message: "未确认" }, draft }) });
	const page = mount(client);
	await tick();
	page.render().setConcept("概念");
	page.render().setContent("一段理解");
	await page.render().submit();
	const after = page.render();
	assert.equal(after.input.content, "一段理解", "未确认时同样保留原稿");
	assert.equal(after.submitState.lastState, "pending");
	assert.equal(after.drafts.length, 1, "主进程返回的草稿要并进列表");
	assert.equal(after.drafts[0].requestId, "rd-9");
});

test("写入成功（applied + revision）且原槽未变：清空该槽的未发送输入", async () => {
	const client = createClient();
	const page = mount(client);
	await tick();
	page.render().setConcept("概念");
	page.render().setContent("一段理解");
	await page.render().submit();
	const after = page.render();
	assert.equal(after.submitState.lastState, "saved");
	assert.equal(after.input.content, "", "受理成功且原槽未改才清输入");
	assert.equal(client.calls.writeNote.length, 1);
	assert.match(client.calls.writeNote[0].clientRequestId, /^[A-Za-z0-9_-]{1,128}$/);
});

test("ACK 结算：等待期间继续输入不清新稿、不把当前编辑目标置空", async () => {
	const pending = deferred();
	const client = createClient({ writeNote: async () => pending.promise });
	const page = mount(client);
	await tick();
	page.render().setConcept("概念");
	page.render().setContent("原文");
	const inflight = page.render().submit();
	await tick();
	assert.equal(client.calls.writeNote.length, 1);

	// 用户没等 ACK，继续在原槽上追加内容
	page.render().setContent("原文 + 追加");
	pending.resolve({ ok: true, note: NOTE, requestId: client.calls.writeNote[0].clientRequestId });
	await inflight;

	const after = page.render();
	assert.equal(after.input.content, "原文 + 追加", "旧 ACK 不得清掉等待期间继续输入的新稿");
	assert.equal(after.input.concept, "概念");
	assert.equal(after.targetSummary, null, "新建槽仍然保持新建（当前编辑目标未被置空成别的对象）");
	assert.equal(after.submitState.pending, false, "ACK 必须结算在飞标记");
	assert.equal(after.submitState.lastState, "saved", "ACK 仍要结算为已保存");
});

test("ACK 结算：切换编辑目标后不置空当前目标、当前目标原稿保留；原槽仅原文才清除", async () => {
	const pending = deferred();
	const client = createClient({ writeNote: async () => pending.promise });
	const page = mount(client);
	await tick();
	page.render().setConcept("概念");
	page.render().setContent("原文");
	const inflight = page.render().submit();
	await tick();

	// 等待 ACK 期间切到已有笔记 n_1 并输入追加内容
	page.render().selectTarget("n_1", "append");
	page.render().setSection("explore");
	page.render().setContent("追加内容");
	const switched = page.render();
	assert.equal(switched.targetSummary?.noteId, "n_1", "切目标后当前目标是 n_1");

	pending.resolve({ ok: true, note: NOTE, requestId: client.calls.writeNote[0].clientRequestId });
	await inflight;

	const after = page.render();
	assert.equal(after.targetSummary?.noteId, "n_1", "旧 ACK 不得把当前编辑目标置空");
	assert.equal(after.input.content, "追加内容", "当前目标的原稿必须保留");
	assert.equal(after.input.section, "explore");
	assert.equal(after.submitState.lastState, "saved", "旧 ACK 仍要结算为已保存");

	// 回到新建槽（不传 op：只切目标，不动槽内容）：已确认的原稿应已清除
	after.selectTarget(null);
	const back = page.render();
	assert.equal(back.input.content, "", "原编辑槽仍是提交时的原文 → 已确认的原稿清除");
	assert.equal(back.input.concept, "");
	assert.equal(back.targetSummary, null);
});

test("ACK 结算：旧书的回执不写当前书，回到原书不能永久 pending", async () => {
	const pending = deferred();
	const client = createClient({ writeNote: async () => pending.promise });
	const page = mount(client, { workId: "w1", editionId: "e1" });
	await tick();
	page.render().setConcept("概念");
	page.render().setContent("原文");
	const inflight = page.render().submit();
	await tick();

	// 切到另一个版本
	const other = page.render({ workId: "w1", editionId: "e2" });
	await tick();
	page.render();
	assert.equal(other.submitState.pending, false, "另一版本本来没有在飞提交");

	pending.resolve({ ok: true, note: NOTE, requestId: client.calls.writeNote[0].clientRequestId });
	await inflight;

	const onOther = page.render();
	assert.equal(onOther.submitState.lastState, null, "旧书的 ACK 不得写进当前书的提交状态");
	assert.equal(onOther.submitState.pending, false);

	const back = page.render({ workId: "w1", editionId: "e1" });
	assert.equal(back.submitState.pending, false, "回到原书不能永久 pending");
	assert.equal(back.submitState.lastState, "saved", "原书的 ACK 已按发起书结算");
	assert.equal(back.input.content, "", "回到原书：原槽未变 → 已确认原稿已清除");
});

test("帖子纯策略：原载荷快照逐字节比较 + 清除判定（不按 trim/同义比较）", () => {
	const harness = createReadingHookHarness();
	const notesUtil = harness.load("src/renderer/src/utils/readingNotes.ts");
	const base = { op: "create", noteId: null, section: "understanding", concept: "概念", chapterLabel: "5.标题", content: "原文" };
	assert.equal(notesUtil.readingNoteInputEquals({ ...base }, { ...base }), true);
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, content: "原文 " }, { ...base }), false, "尾部空格不算同一份载荷");
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, content: "原文\n" }, { ...base }), false, "换行不算同一份载荷");
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, op: "append" }, { ...base }), false);
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, section: "quote" }, { ...base }), false);
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, concept: "概念2" }, { ...base }), false);
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, chapterLabel: "" }, { ...base }), false);
	assert.equal(notesUtil.readingNoteInputEquals({ ...base, noteId: "n_1" }, { ...base }), false);

	assert.deepEqual(plain(notesUtil.readingNoteAckDisposition({ acked: base, stored: { ...base } })), { clearInput: true, reason: "input-unchanged" });
	assert.deepEqual(plain(notesUtil.readingNoteAckDisposition({ acked: base, stored: { ...base, content: "原文 + 追加" } })), { clearInput: false, reason: "input-changed" });
	assert.deepEqual(plain(notesUtil.readingNoteAckDisposition({ acked: null, stored: { ...base } })), { clearInput: false, reason: "no-acked-slot" });
	assert.deepEqual(plain(notesUtil.readingNoteAckDisposition({ acked: base, stored: null })), { clearInput: false, reason: "no-stored-slot" });
});
