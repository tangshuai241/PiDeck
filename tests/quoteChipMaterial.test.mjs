/**
 * P04 引用 chip 兼容与材料展开测试（renderer/composer/quoteChip + shared 材料块）。
 *
 * 锁住的契约：
 * - 旧消息引用（无 material）行为完全不变：展开仍是 <quoted_context label message_id>；
 * - 材料 chip 展开为材料块（书段/待办），来源身份与原文随消息持久化；
 * - 编辑重发把两类材料块还原成 #q token + 携带 material 的快照，再次展开同形（往返不丢身份）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const quote = loadTsCommonJs("src/renderer/src/components/session/composer/quoteChip.ts");
const blocks = loadTsCommonJs("src/shared/workbenchMaterialBlocks.ts");

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
	start: null,
	end: null,
	verify: "unverified",
	text: "选中原文\n第二行",
	capturedAt: "2026-10-15T00:00:00.000Z",
};

const TODO_MATERIAL = {
	kind: "todo",
	todoId: "todo_1",
	subtodoId: null,
	rootRevision: "rev-9",
	title: "写周报",
	note: "本周备注",
	subtodoText: null,
	subtodoNote: null,
	status: "open",
	subtodoStatus: null,
	category: null,
	deadline: null,
	source: { kind: "canonical", namespace: null, sourceId: null },
	text: "写周报\n\n本周备注",
	capturedAt: "2026-10-15T00:00:00.000Z",
};

test("旧消息引用回归：无 material 的 snippet 展开仍是 <quoted_context> 且字节不变", () => {
	const snippet = { id: "qaaaaaa01", text: "引用全文", messageId: "m-42", createdAt: 1 };
	const expanded = quote.expandQuoteTokens("#qaaaaaa01 为什么", () => snippet);
	assert.equal(expanded, `${quote.formatQuoteBlock("引用全文", { label: "引用全文", messageId: "m-42" })}\n\n为什么`);
	assert.ok(expanded.includes('<quoted_context label="引用全文" message_id="m-42">'));
	assert.equal(expanded.includes("<reading_segment"), false);
});

test("材料 chip 展开：按种类产出材料块，原文与身份一并进入消息", () => {
	const reading = quote.expandQuoteTokens("#qaaaaaa01 帮我看", () => ({ id: "qaaaaaa01", text: READING_MATERIAL.text, messageId: "", createdAt: 1, material: READING_MATERIAL }));
	assert.equal(reading, `${blocks.formatReadingSegmentBlock(READING_MATERIAL)}\n\n帮我看`);

	const todo = quote.expandQuoteTokens("#qbbbbbb02", () => ({ id: "qbbbbbb02", text: TODO_MATERIAL.text, messageId: "", createdAt: 1, material: TODO_MATERIAL }));
	assert.equal(todo, blocks.formatPersonalTodoBlock(TODO_MATERIAL));
});

test("混合展开：旧引用与材料各自保持原形，顺序按 token 出现位置", () => {
	const map = {
		qaaaaaa01: { id: "qaaaaaa01", text: "旧引用", messageId: "m1", createdAt: 1 },
		qbbbbbb02: { id: "qbbbbbb02", text: TODO_MATERIAL.text, messageId: "", createdAt: 1, material: TODO_MATERIAL },
	};
	const expanded = quote.expandQuoteTokens("#qaaaaaa01 先问旧引用\n#qbbbbbb02 再问待办", (id) => map[id]);
	const firstBlockIndex = expanded.indexOf("<quoted_context");
	const secondBlockIndex = expanded.indexOf("<personal_todo");
	assert.ok(firstBlockIndex >= 0 && secondBlockIndex > firstBlockIndex);
	assert.ok(expanded.includes("先问旧引用"));
	assert.ok(expanded.includes("再问待办"));
});

test("编辑重发还原：材料块 → #q token + material 快照，再展开同形（身份往返）", () => {
	const message = `${blocks.formatReadingSegmentBlock(READING_MATERIAL)}\n\n${blocks.formatPersonalTodoBlock(TODO_MATERIAL)}\n\n帮我整理`;
	const rehydrated = quote.rehydrateDraftFromMessage(
		message,
		(() => {
			let index = 0;
			return () => `q0000000${index++}`;
		})(),
	);
	assert.equal(rehydrated.quotes.length, 2);
	assert.equal(rehydrated.draft, "#q00000000 #q00000001 帮我整理");
	assert.deepEqual(plain(rehydrated.quotes[0].material), READING_MATERIAL);
	assert.deepEqual(plain(rehydrated.quotes[1].material), TODO_MATERIAL);
	assert.equal(rehydrated.quotes[0].messageId, "");
	assert.equal(rehydrated.quotes[0].text, READING_MATERIAL.text, "原文快照必须逐字节带回");

	// 再次展开：同形材料块（除 #q id 外内容一致）
	const rebuilt = quote.expandQuoteTokens(rehydrated.draft, (id) => rehydrated.quotes.find((entry) => entry.id === id));
	assert.equal(rebuilt, `${blocks.formatReadingSegmentBlock(READING_MATERIAL)}\n\n${blocks.formatPersonalTodoBlock(TODO_MATERIAL)}\n\n帮我整理`);
});

test("气泡片段：材料块折叠成 chip，正文保留，不把 XML 漏进正文", () => {
	const message = `开头 ${blocks.formatReadingSegmentBlock(READING_MATERIAL)} 结尾`;
	const segments = quote.buildBubbleRefSegments(message);
	assert.deepEqual(plain(segments.map((segment) => segment.kind)), ["text", "chip", "text"]);
	assert.equal(segments[1].block.kind, "reading_material");
	assert.equal(segments[1].block.label, "第一章");
	assert.equal(segments[0].value, "开头");
});
