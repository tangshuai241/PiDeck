/**
 * 首次建档的转场行为：hook 先挂载，runtime/用户消息后到达时仍要自动暴露建档入口。
 *
 * 复现的是真实验收里的缺陷：`documentWork.list` 一直返回 `[]`、文档卡从不出现、
 * 点确认只得到 needsOutputRoot。根因是创建 effect 的依赖写成了稳定 atom，
 * 值变了却不重跑；这个文件用真的比较 effect 依赖的渲染台把它钉住。
 *
 * 同时钉住正式意图门禁：普通计划/编码轮、空模式都不得出现文稿卡。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { alignmentSnapshot, createDocumentWorkHarness, runtimeSnapshot, userMessage } from "./helpers/documentWorkHookHarness.mjs";

const FORMAL_REQUEST = "请帮我生成一份正式 Word 文档（DOCX），内容是季度经营分析的完整报告。";
const CODING_REQUEST = "帮我重构这个模块并补单元测试，顺便解释一下这段代码。";

test("挂载早于 runtime：ready 文稿要求到达后自动暴露建档入口（needsLocation）", () => {
	const harness = createDocumentWorkHarness();
	// 1) 首次渲染：会话还没有 runtime、也没有用户消息（真实验收的初始状态）。
	let controls = harness.render();
	assert.equal(controls.presentation.kind, "hidden", "没有 runtime 时不应出现文稿卡");

	// 2) 用户消息到达。
	harness.setMessages([userMessage(FORMAL_REQUEST)]);
	controls = harness.render();
	assert.equal(controls.presentation.kind, "hidden", "只有用户消息、还没对齐状态时不建档");

	// 3) Pi 发布 ready brief（revision 1）——真实验收里就停在这一步。
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot()));
	controls = harness.render();

	assert.equal(harness.calls.create.length, 0, "建档必须等用户选定成果目录，不能自动建");
	assert.equal(controls.presentation.kind, "needsLocation", "正式文稿轮必须自动暴露「选择保存目录」入口");
	assert.equal(controls.needsOutputRoot, true);
	assert.equal(harness.calls.chooseOutputRoot, 0, "不应自动弹系统选择器");
});

test("待建状态跨渲染保持，且不会重复建档", async () => {
	const harness = createDocumentWorkHarness();
	harness.render();
	harness.setMessages([userMessage(FORMAL_REQUEST)]);
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot()));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "needsLocation");

	// 多次重渲染（例如流式输出）不得把待建状态清掉，也不得重复请求建档。
	for (let index = 0; index < 3; index++) harness.render();
	assert.equal(harness.controls.presentation.kind, "needsLocation", "待建状态必须保持");
	assert.equal(harness.calls.create.length, 0);

	// 用户点「选择保存目录」：只建档一次，随后卡片转入工作态。
	const first = await harness.controls.createForSession();
	assert.equal(harness.calls.create.length, 1);
	assert.equal(harness.calls.chooseOutputRoot, 1);
	assert.equal(first?.workId, "dw_1");
	harness.render();
	assert.notEqual(harness.controls.presentation.kind, "needsLocation", "建档完成后不再显示选择目录入口");
	assert.equal(harness.controls.view?.workId, "dw_1");

	const second = await harness.controls.createForSession();
	assert.equal(second, null, "待建已消费：再次调用不得重复建档");
	assert.equal(harness.calls.create.length, 1);
});

test("普通计划/编码对齐轮不出现文稿卡", () => {
	const harness = createDocumentWorkHarness();
	harness.render();
	harness.setMessages([userMessage(CODING_REQUEST)]);
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot({ brief: null })));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "hidden", "编码轮不得出现建档入口");

	// 模型为该轮发布了编码性质的 brief：仍然不得出现。
	harness.setRuntime(
		runtimeSnapshot(
			alignmentSnapshot({
				brief: { goal: "重构会话模块并补单元测试", scope: ["module"], materials: [], deliverable: "重构后的代码与测试用例", preserve: [], acceptance: ["测试通过"], questions: [] },
			}),
		),
	);
	harness.render();
	assert.equal(harness.controls.presentation.kind, "hidden", "编码 brief 不得触发文稿卡");
	assert.equal(harness.calls.create.length, 0);
});

test("空模式（revision 0）不建档；退出对齐后不残留待建", () => {
	const harness = createDocumentWorkHarness();
	harness.render();
	harness.setMessages([userMessage(FORMAL_REQUEST)]);
	// 只选了需求模式：revision 仍是 0。
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot({ revision: 0, briefRevision: 0, phase: "clarifying" })));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "hidden", "空模式不建记录");

	// 用户真的提交要求（revision 前进）→ 出现建档入口。
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot()));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "needsLocation");

	// 用户退出对齐（cancelled）且没有工作记录 → 待建撤掉，不残留文稿卡。
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot({ phase: "cancelled" })));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "hidden", "退出对齐后不得残留待建卡");
});

test("已存在工作时不重复进入建档流程（工作快照异步载入后撤掉待建）", async () => {
	const existing = { workId: "dw_existing", sessionId: "s1", revision: 4, title: "既有文稿", outputRootLabel: "文稿", requirementsSummary: "", active: null, versions: [], revisionReady: false };
	const harness = createDocumentWorkHarness({ initialViews: [existing] });
	// 挂载即请求工作列表；快照是异步返回的（真实验收里 list 先返回 []，这里直接返回既有工作）。
	harness.render();
	await new Promise((resolve) => setImmediate(resolve));
	harness.render();
	harness.setMessages([userMessage(FORMAL_REQUEST)]);
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot()));
	harness.render();
	assert.equal(harness.calls.create.length, 0, "已有工作不得再建");
	assert.equal(harness.controls.view?.workId, "dw_existing");
	assert.equal(harness.controls.presentation.kind !== "needsLocation", true, "已有工作不显示选择目录入口");
});

test("用户轮身份以当前最新一轮为准（同一轮不会被重复建档）", async () => {
	const harness = createDocumentWorkHarness();
	harness.render();
	harness.setMessages([userMessage(FORMAL_REQUEST, "turn-7")]);
	harness.setRuntime(runtimeSnapshot(alignmentSnapshot()));
	harness.render();
	assert.equal(harness.controls.presentation.kind, "needsLocation");
	await harness.controls.createForSession();
	assert.equal(harness.calls.create.length, 1);
	assert.equal(harness.calls.create[0].sourceTurnId, "turn-7", "建档必须绑定最新真实用户轮");
});
