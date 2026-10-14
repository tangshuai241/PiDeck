/**
 * P04 工作台材料会话策略测试（renderer/utils/workbenchMaterialSession）。
 *
 * 锁住的契约：
 * - 追加不覆盖用户原文字；同一目标会话按材料身份去重；快照仓按草稿引用 prune；
 * - 跨会话隔离：只改传入会话的 draft/quotes，不触碰其他会话状态；
 * - A/B 迟到守卫：epoch 或 work/edition/contentVersion 任一不符即丢弃；
 * - 书段材料核验档位：无核验偏移绝不冒充 exact；待办材料保留 todoId/subtodoId/rootRevision/source。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const utils = loadTsCommonJs("src/renderer/src/utils/workbenchMaterialSession.ts");
const materials = loadTsCommonJs("src/shared/types/workbenchMaterial.ts");
const { buildQuoteToken, extractQuoteTokens } = loadTsCommonJs("src/renderer/src/components/session/composer/quoteChip.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

const READING_MATERIAL = {
	kind: "reading_segment",
	workId: "w1",
	editionId: "e1",
	contentVersion: "v1",
	workTitle: "书名",
	editionTitle: null,
	chapterHref: "ch1.xhtml",
	chapterNum: 1,
	chapterTitle: "第一章",
	start: 3,
	end: 9,
	verify: "exact",
	text: "选中原文\n第二行",
	capturedAt: "2026-10-15T00:00:00.000Z",
};

const TODO_ITEM = {
	id: "todo_1",
	title: "写周报",
	note: "本周备注",
	category: "工作",
	deadline: null,
	urgency: null,
	status: "open",
	revision: "rev-9",
	createdAt: null,
	updatedAt: null,
	linkedTaskIds: [],
	subtodos: [{ id: "sub_1", text: "收数据", note: "从台账", status: "open", assignee: null, linkedTaskIds: [], sourceId: "s1" }],
	subtodoProgress: { total: 1, done: 0, open: 1, cancelled: 0 },
	source: { kind: "legacy", namespace: "workbench", sourceId: "src-1", fingerprint: "fp", rawAvailable: true },
	isRoot: true,
	parentId: null,
	parentSubtaskId: null,
	historyCount: null,
};

function todoView(overrides = {}) {
	const item = { ...TODO_ITEM, ...(overrides.item ?? {}) };
	return { item, confirmed: item, draft: null, sync: { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: [] };
}

test("追加材料：保留原文字、token 追加在末尾、快照携带材料且不伪造 messageId", () => {
	const outcome = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft: "原有草稿文字",
		quotes: {},
		material: READING_MATERIAL,
		now: 123,
		createId: () => "q12345678",
	});
	assert.equal(outcome.duplicate, false);
	assert.equal(outcome.draft, "原有草稿文字 #q12345678 ");
	assert.equal(outcome.quotes.q12345678.messageId, "", "材料不是 Pi 消息，不得伪造 messageId");
	assert.deepEqual(plain(outcome.quotes.q12345678.material), READING_MATERIAL);
	assert.equal(outcome.quotes.q12345678.createdAt, 123);
});

test("同一材料重复带入：按身份去重，不追加第二个 chip", () => {
	const first = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft: "原有文字",
		quotes: {},
		material: READING_MATERIAL,
		createId: () => "qaaaaaa01",
	});
	const second = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft: first.draft,
		quotes: first.quotes,
		material: { ...READING_MATERIAL, text: "另一段同身份材料（键含版本身份与偏移）" },
	});
	// 键包含原文，文本不同即不同材料；同原文 + 同偏移才算重复
	assert.equal(second.duplicate, false);
	const third = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft: second.draft,
		quotes: second.quotes,
		material: READING_MATERIAL,
		createId: () => "qbbbbbb02",
	});
	assert.equal(third.duplicate, true, "同身份材料不得重复追加");
	assert.equal(third.snippetId, "qaaaaaa01");
	assert.equal(extractQuoteTokens(third.draft).length, 2, "草稿 token 数不因重复带入增长");
});

test("跨会话隔离：只改传入会话，其它会话的 draft/quotes 对象不被修改", () => {
	const drafts = { "sess-a": "A 的草稿", "sess-b": "B 的草稿" };
	const quotes = { "sess-b": {} };
	const outcome = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft: drafts["sess-a"],
		quotes: quotes["sess-a"] ?? {},
		material: READING_MATERIAL,
		createId: () => "qccccccc01",
	});
	assert.equal(drafts["sess-b"], "B 的草稿");
	assert.deepEqual(quotes["sess-b"], {}, "目标会话 A 的材料不得写入 B 的快照仓");
	assert.ok(outcome.quotes.qccccccc01);
});

test("prune：草稿已删除的旧引用快照在下次登记时清理", () => {
	const orphan = { id: "qdeadbeef", text: "旧引用", messageId: "m1", createdAt: 1 };
	const kept = { id: "qfeedface", text: "仍在草稿", messageId: "m1", createdAt: 1 };
	const draft = `#${kept.id} 继续追问`;
	const outcome = utils.appendWorkbenchMaterialToSessionState({
		sessionId: "sess-a",
		draft,
		quotes: { [orphan.id]: orphan, [kept.id]: kept },
		material: READING_MATERIAL,
		createId: () => "q11111111",
	});
	assert.equal(outcome.quotes[orphan.id], undefined, "无引用快照应被 prune");
	assert.ok(outcome.quotes[kept.id]);
	assert.ok(outcome.quotes.q11111111);
	assert.ok(outcome.draft.includes(buildQuoteToken(kept.id)));
});

test("书段材料核验档位：按服务端状态保留 exact/normalized，unverified 必须无偏移", () => {
	const snapshot = { workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "c1", chapterNum: 1, text: "原文", start: 5, end: 12, capturedAt: "2026-10-15T00:00:00.000Z" };
	const exact = utils.createReadingSegmentMaterial({ snapshot, verify: "exact", workTitle: "书", chapterTitle: "章" });
	assert.equal(exact.verify, "exact");
	assert.equal(exact.start, 5);
	assert.equal(exact.end, 12);

	// normalized 也是核验通过，偏移可用，但状态必须如实保留（不能冒充 exact）
	const normalized = utils.createReadingSegmentMaterial({ snapshot, verify: "normalized" });
	assert.equal(normalized.verify, "normalized");
	assert.equal(normalized.start, 5);

	const unverified = utils.createReadingSegmentMaterial({ snapshot, verify: "unverified" });
	assert.equal(unverified.verify, "unverified");
	assert.equal(unverified.start, null, "未核验时不得带上偏移");
	assert.equal(unverified.end, null);

	// 服务端状态映射：exact/normalized 如实，其余（ambiguous/unmatched/失败）一律 unverified
	assert.equal(utils.readingSegmentVerifyFromQuote({ ok: true, identity: { workId: "w1", editionId: "e1", contentVersion: "v1", filename: null, size: null }, status: "exact", candidates: [], candidatesTruncated: false, note: null }), "exact");
	assert.equal(utils.readingSegmentVerifyFromQuote({ ok: true, identity: { workId: "w1", editionId: "e1", contentVersion: "v1", filename: null, size: null }, status: "normalized", candidates: [], candidatesTruncated: false, note: null }), "normalized");
	assert.equal(utils.readingSegmentVerifyFromQuote({ ok: true, identity: { workId: "w1", editionId: "e1", contentVersion: "v1", filename: null, size: null }, status: "ambiguous", candidates: [], candidatesTruncated: false, note: null }), "unverified");
	assert.equal(utils.readingSegmentVerifyFromQuote(null), "unverified");
});

test("A/B 迟到守卫：epoch 或作用域任一不符即丢弃", () => {
	const scopeA = { workId: "w1", editionId: "e1", contentVersion: "vA" };
	const scopeB = { workId: "w1", editionId: "e1", contentVersion: "vB" };
	assert.equal(utils.shouldAcceptReadingMaterial({ epoch: 2, currentEpoch: 2, materialScope: scopeA, currentScope: scopeA }), true);
	assert.equal(utils.shouldAcceptReadingMaterial({ epoch: 1, currentEpoch: 2, materialScope: scopeA, currentScope: scopeA }), false, "epoch 不符必须丢弃");
	assert.equal(utils.shouldAcceptReadingMaterial({ epoch: 2, currentEpoch: 2, materialScope: scopeA, currentScope: scopeB }), false, "contentVersion 不符必须丢弃");
	assert.equal(utils.shouldAcceptReadingMaterial({ epoch: 2, currentEpoch: 2, materialScope: scopeA, currentScope: { ...scopeA, workId: "w2" } }), false);
	assert.equal(utils.shouldAcceptReadingMaterial({ epoch: 2, currentEpoch: 2, materialScope: scopeA, currentScope: null }), false, "当前没有作用域时不得写入");
});

test("待办材料：父项与子项保留身份/来源，文本快照含子项上下文", () => {
	const parent = utils.createTodoMaterial({ view: todoView(), capturedAt: "2026-10-15T00:00:00.000Z" });
	assert.equal(parent.todoId, "todo_1");
	assert.equal(parent.subtodoId, null);
	assert.equal(parent.rootRevision, "rev-9");
	assert.deepEqual(plain(parent.source), { kind: "legacy", namespace: "workbench", sourceId: "src-1" });
	assert.equal(parent.text, "写周报\n\n本周备注");
	assert.equal(parent.status, "open");

	const sub = utils.createTodoMaterial({ view: todoView(), subtodoId: "sub_1", capturedAt: "2026-10-15T00:00:00.000Z" });
	assert.equal(sub.subtodoId, "sub_1");
	assert.equal(sub.subtodoText, "收数据");
	assert.equal(sub.subtodoNote, "从台账");
	assert.equal(sub.subtodoStatus, "open");
	assert.equal(sub.source.sourceId, "s1", "子项来源 id 优先取子项自身");
	assert.equal(sub.text, "写周报\n\n收数据\n\n从台账");
});

test("待办材料：未知子项或非根项视图拒绝带入（返回 null，不造半截材料）", () => {
	assert.equal(utils.createTodoMaterial({ view: todoView(), subtodoId: "sub-missing" }), null);
	assert.equal(utils.createTodoMaterial({ view: todoView({ item: { isRoot: false, parentId: "todo_root" } }) }), null);
});

test("材料判同：同有效快照（capturedAt 不同）去重；离线编辑改变正文/状态（revision 不变）算新材料", () => {
	const base = utils.createTodoMaterial({ view: todoView(), capturedAt: "2026-10-15T00:00:00.000Z" });
	const reCaptured = { ...base, capturedAt: "2026-10-16T08:00:00.000Z" };
	assert.equal(materials.workbenchMaterialKey(base), materials.workbenchMaterialKey(reCaptured), "capturedAt 不参与判同");

	const edited = { ...base, title: "写周报（改）", note: "改了备注", text: "写周报（改）\n\n改了备注" };
	assert.notEqual(materials.workbenchMaterialKey(base), materials.workbenchMaterialKey(edited), "同 revision 的正文编辑必须算新材料");
	const statusChanged = { ...base, status: "done", subtodoStatus: "done" };
	assert.notEqual(materials.workbenchMaterialKey(base), materials.workbenchMaterialKey(statusChanged), "同 revision 的状态变化必须算新材料");

	// findMaterialSnippet 用同一键：离线编辑后的快照不得被旧快照去重
	const quotes = { qaaaaaa01: { id: "qaaaaaa01", text: base.text, messageId: "", createdAt: 1, material: base } };
	const draft = "#qaaaaaa01 追问";
	assert.equal(utils.findMaterialSnippet({ quotes, draft, material: base })?.id, "qaaaaaa01", "未编辑的同快照仍应去重");
	assert.equal(utils.findMaterialSnippet({ quotes, draft, material: edited }), null, "离线编辑后的同一 revision 必须算新材料");
});
