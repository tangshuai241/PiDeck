/**
 * P04 工作台材料块编解码测试（shared/workbenchMaterialBlocks + expandedRefBlocks 集成）。
 *
 * 锁住的契约：
 * - 材料块自带原文与真实来源身份，解析回填与原对象逐字段相等；
 * - 原文（含换行/回车/首尾空白）逐字节保留，闭合标签逃逸不提前截断；
 * - 材料块能被既有折叠出口识别（气泡/预览/标题），不把 XML 漏给人；
 * - 缺必填属性的块按普通文本处理，不伪造来源、不抛异常。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const blocks = loadTsCommonJs("src/shared/workbenchMaterialBlocks.ts");
const materials = loadTsCommonJs("src/shared/types/workbenchMaterial.ts");
const refs = loadTsCommonJs("src/shared/expandedRefBlocks.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

const READING = {
	kind: "reading_segment",
	workId: "work_1",
	editionId: "edition_1",
	contentVersion: "abc123def456",
	workTitle: "测试作品",
	editionTitle: "初版",
	chapterHref: "OEBPS/ch003.xhtml",
	chapterNum: 3,
	chapterTitle: "第三章",
	start: 10,
	end: 42,
	verify: "exact",
	text: '第一行\n第二行 <标签> & "引号"\n',
	capturedAt: "2026-10-15T01:02:03.000Z",
};

const TODO = {
	kind: "todo",
	todoId: "todo_1",
	subtodoId: "sub_2",
	rootRevision: "rev-77",
	title: "写周报",
	note: "备注第一行\n备注第二行",
	subtodoText: "收集数据",
	subtodoNote: "从台账导出",
	status: "open",
	subtodoStatus: "open",
	category: "工作",
	deadline: "2026-10-20",
	source: { kind: "legacy", namespace: "workbench", sourceId: "s2" },
	text: "写周报\n\n收集数据\n\n从台账导出",
	capturedAt: "2026-10-15T01:02:03.000Z",
};

const TODO_PARENT = {
	...TODO,
	subtodoId: null,
	subtodoText: null,
	subtodoNote: null,
	subtodoStatus: null,
	category: null,
	deadline: null,
	source: { kind: "canonical", namespace: null, sourceId: null },
	text: "写周报\n\n备注第一行\n备注第二行",
};

test("书段材料块：format → parse 逐字段与原文往返（含尾换行）", () => {
	const formatted = blocks.formatReadingSegmentBlock(READING);
	const parsed = blocks.parseReadingSegmentMaterialBlocks(formatted);
	assert.equal(parsed.length, 1);
	assert.deepEqual(plain(parsed[0].material), READING);
	assert.equal(parsed[0].text, READING.text, "原文必须逐字节保留");
	assert.equal(parsed[0].start, 0);
	assert.equal(parsed[0].end, formatted.length);
});

test("书段材料块：原文首尾空白/CRLF/CR 不被框定换行吃掉", () => {
	const cases = ["\n开头就是换行", "结尾是换行\n", "CRLF\r\n混排\r\n", "尾回车\r", "  两侧空白  ", ""];
	for (const text of cases) {
		const formatted = blocks.formatReadingSegmentBlock({ ...READING, text });
		const parsed = blocks.parseReadingSegmentMaterialBlocks(formatted);
		assert.equal(parsed.length, 1, `text=${JSON.stringify(text)} 应解析出一个块`);
		assert.equal(parsed[0].material.text, text, `text=${JSON.stringify(text)} 原文必须原样往返`);
	}
});

test("书段材料块：正文里的闭合标签/另一材料块/实体逐字节 roundtrip，且不产生额外块", () => {
	const text = '前 </reading_segment> 后 </READING_SEGMENT> <personal_todo todo_id="x">\n</personal_todo> 原有 &lt; 与 &amp; 与 < >';
	const formatted = blocks.formatReadingSegmentBlock({ ...READING, text });
	assert.ok(formatted.includes("&lt;/reading_segment&gt;"), "写入端必须可逆转义闭合标签");
	assert.ok(formatted.includes('body_encoding="xml-escaped"'), "写入端必须标正文编码");
	// 正文里的 personal_todo 标签必须被转义，不得被解析成另一个块
	assert.equal(blocks.parsePersonalTodoMaterialBlocks(formatted).length, 0);
	const parsed = blocks.parseReadingSegmentMaterialBlocks(formatted);
	assert.equal(parsed.length, 1, "逃逸后仍是一个完整块");
	assert.equal(parsed[0].material.text, text, "含闭合标签/另一材料块/实体的原文必须逐字节不变");
});

test("书段材料块：verify 保留 exact/normalized/unverified 三档", () => {
	for (const verify of ["exact", "normalized", "unverified"]) {
		const material = { ...READING, verify, start: verify === "unverified" ? null : 10, end: verify === "unverified" ? null : 42 };
		const parsed = blocks.parseReadingSegmentMaterialBlocks(blocks.formatReadingSegmentBlock(material));
		assert.equal(parsed.length, 1);
		assert.deepEqual(plain(parsed[0].material), material, `verify=${verify} 必须如实往返`);
	}
});

test("待办材料块：父项/子项往返，null 字段与空备注不丢语义", () => {
	for (const material of [TODO, TODO_PARENT]) {
		const formatted = blocks.formatPersonalTodoBlock(material);
		const parsed = blocks.parsePersonalTodoMaterialBlocks(formatted);
		assert.equal(parsed.length, 1);
		assert.deepEqual(plain(parsed[0].material), material);
	}
	const parent = blocks.parsePersonalTodoMaterialBlocks(blocks.formatPersonalTodoBlock(TODO_PARENT))[0];
	assert.equal(parent.material.subtodoId, null);
	assert.equal(parent.material.source.namespace, null);
	assert.equal(parent.material.source.sourceId, null);
});

test("待办材料块：正文含自身闭合标签时逐字节往返", () => {
	const material = { ...TODO_PARENT, text: "写周报\n\n</personal_todo> 与 </reading_segment> 都保留" };
	const parsed = blocks.parsePersonalTodoMaterialBlocks(blocks.formatPersonalTodoBlock(material));
	assert.equal(parsed.length, 1);
	assert.deepEqual(plain(parsed[0].material), material);
});

test("待办材料块：空备注与含引号/尖括号的标题往返", () => {
	const material = { ...TODO_PARENT, title: '读 "A&B" <草稿>', note: "", text: '读 "A&B" <草稿>' };
	const parsed = blocks.parsePersonalTodoMaterialBlocks(blocks.formatPersonalTodoBlock(material));
	assert.equal(parsed.length, 1);
	assert.deepEqual(plain(parsed[0].material), material);
});

test("材料块：缺必填身份的块被跳过，正文当普通文本", () => {
	const missingEdition = '<reading_segment work_id="w">\n正文\n</reading_segment>';
	assert.deepEqual(plain(blocks.parseReadingSegmentMaterialBlocks(missingEdition)), []);
	const missingTodo = '<personal_todo subtodo_id="s">\n正文\n</personal_todo>';
	assert.deepEqual(plain(blocks.parsePersonalTodoMaterialBlocks(missingTodo)), []);
});

test("材料标签与身份键：书段优先章节标题，待办含子项，键按有效快照区分", () => {
	assert.equal(materials.workbenchMaterialLabel(READING), "第三章");
	assert.equal(materials.workbenchMaterialLabel({ ...READING, chapterTitle: null }), "第一行");
	assert.equal(materials.workbenchMaterialLabel(TODO), "写周报 · 收集数据");
	assert.notEqual(materials.workbenchMaterialKey(READING), materials.workbenchMaterialKey({ ...READING, contentVersion: "other" }));
	assert.notEqual(materials.workbenchMaterialKey(READING), materials.workbenchMaterialKey({ ...READING, verify: "normalized" }));
	// capturedAt 只是登记时间：不参与判同
	assert.equal(materials.workbenchMaterialKey(TODO), materials.workbenchMaterialKey({ ...TODO, capturedAt: "2026-10-16T00:00:00.000Z" }));
	// 离线乐观编辑（revision 不变）改了正文/状态/来源：必须算新材料，不得被旧快照去重吞掉
	assert.notEqual(materials.workbenchMaterialKey(TODO), materials.workbenchMaterialKey({ ...TODO, text: "改写正文", note: "改过的备注" }));
	assert.notEqual(materials.workbenchMaterialKey(TODO), materials.workbenchMaterialKey({ ...TODO, status: "done", subtodoStatus: "done" }));
	assert.notEqual(materials.workbenchMaterialKey(TODO_PARENT), materials.workbenchMaterialKey({ ...TODO_PARENT, source: { kind: "legacy", namespace: "workbench", sourceId: "s9" } }));
});

test("expandedRefBlocks 集成：材料块折叠为独立标签，不混入 /技能 命名空间", () => {
	const message = `${blocks.formatReadingSegmentBlock(READING)}\n\n${blocks.formatPersonalTodoBlock(TODO)}\n\n用户的提问`;
	const parsed = refs.parseExpandedRefBlocks(message);
	assert.deepEqual(plain(parsed.map((block) => block.kind)), ["reading_material", "todo_material"]);
	assert.equal(parsed[0].label, "第三章");
	assert.equal(parsed[1].label, "写周报 · 收集数据");
	assert.deepEqual(plain(parsed[0].material), READING);
	assert.deepEqual(plain(parsed[1].material), TODO);

	const folded = refs.replaceExpandedRefBlocksWithLabels(message);
	assert.ok(folded.includes("📖第三章"), folded);
	assert.ok(folded.includes("☑写周报 · 收集数据"), folded);
	assert.ok(!folded.includes("<reading_segment"), "折叠后不得漏 XML");
	assert.ok(!folded.includes("<personal_todo"), "折叠后不得漏 XML");
});

test("expandedRefBlocks 集成：会话标题只用块外文字，脏标题能被识别重写", () => {
	const message = `${blocks.formatReadingSegmentBlock(READING)}\n\n这段话帮我改改`;
	assert.equal(refs.textForSessionTitle(message), "这段话帮我改改");
	// 只插材料不写字时回退到标签，标题不能是空串，也不能是 XML
	assert.equal(refs.textForSessionTitle(blocks.formatReadingSegmentBlock(READING)), "📖第三章");
	assert.equal(refs.looksLikeExpandedRefBlockTitle(`<reading_segment work_id="w"`), true);
	assert.equal(refs.looksLikeExpandedRefBlockTitle(`<personal_todo todo_id="t" root_revision="r"`), true);
	assert.equal(refs.looksLikeExpandedRefBlockTitle("正常标题"), false);
});

test("expandedRefBlocks 集成：旧四类块行为不变（回归）", () => {
	const legacy = '<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n\n<referenced_session name="会话B">\n[User]: x\n</referenced_session>';
	const kinds = refs.parseExpandedRefBlocks(legacy).map((block) => block.kind);
	assert.deepEqual(plain(kinds), ["quote", "session"]);
	assert.equal(refs.replaceExpandedRefBlocksWithLabels(legacy), "❝引用A\n\n&会话B");
});
