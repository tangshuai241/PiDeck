/**
 * 确认单点击的域路由：真实 brief 措辞不得把正式文稿轮降级成原生批准。
 *
 * 复现的是真实验收缺陷（会话 0933dc13）：正式 Word brief 里出现「本轮只提交确认单」，
 * 而 `提交` 被当成工程语境 → 旧实现只看 brief 判断本轮目标 → 返回 proceedWithAlignment
 * → 一点绑定都没有（record 停在 revision1、active:null、versions:[]）。
 *
 * 这里钉住统一后的当前轮路由：用户原话优先于模型措辞、当前 revision 的 brief 参与判断、
 * 旧 brief 不参与、明确工程轮不被历史文稿域吞掉。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { alignmentSnapshot, createDocumentWorkHarness, runtimeSnapshot, userMessage } from "./helpers/documentWorkHookHarness.mjs";

/** 真实验收里的 brief 目标（逐字保留，含「本轮只提交确认单」）。 */
const REAL_BRIEF_GOAL = "按用户给定内容起草正式 Word 报告《桥梁监测安排》（DOCX）：正文只含两节，逐字使用消息中提供的文字，不加事实、不扩写；本轮只提交确认单，待用户确认后再生成文件。";

/** 真实验收里用户原话（正式文稿要求）。 */
const REAL_USER_REQUEST = "请帮我生成正式 Word 报告《桥梁监测安排》（DOCX）：全部内容直接在本消息内，不引用外部材料，不要生成目录。正文只含两节，一节标题「一、总览」，其下逐字使用我提供的文字；一节标题「二、实施安排」。使用宋体小四，标题使用 Word Heading 1，文件名《桥梁监测安排.docx》。";

/** 真实验收里的工作记录（已授权成果目录，还没有版本）。 */
const AUTHORIZED_WORK = { workId: "dw_a9c05d32666640669a874e14", sessionId: "s1", revision: 1, title: REAL_BRIEF_GOAL, outputRootLabel: "outputs", requirementsSummary: "", active: null, versions: [], revisionReady: false };

function realBriefAlignment(overrides = {}) {
	return alignmentSnapshot({ brief: { goal: REAL_BRIEF_GOAL, scope: ["一、总览", "二、实施安排"], materials: [], deliverable: "《桥梁监测安排》.docx", preserve: [], acceptance: ["两节逐字一致"], questions: [] }, ...overrides });
}

/** 挂载 hook 并把工作快照/运行时/消息推进到真实验收那一刻。 */
async function mountLiveCase(options = {}) {
	const harness = createDocumentWorkHarness({ initialViews: options.views ?? [AUTHORIZED_WORK] });
	harness.render();
	await harness.flush();
	harness.render();
	harness.setMessages([userMessage(options.userText ?? REAL_USER_REQUEST)]);
	harness.setRuntime(runtimeSnapshot(options.alignment ?? realBriefAlignment()));
	harness.render();
	return harness;
}

test("真实 brief + 正式用户原话：确认一次只走文稿路径（prepare/start 各一次，不回退原生批准）", async () => {
	const harness = await mountLiveCase();
	// 真实验收回执：批准期间对齐快照被推到 approved（brief/revision 不变）。
	const timer = setTimeout(() => harness.setAlignment({ ...realBriefAlignment(), phase: "approved" }), 20);
	const outcome = await harness.controls.prepareAndStartForApproval();
	clearTimeout(timer);

	assert.equal(outcome, "documentWorkDispatched", "正式文稿轮必须被文稿域接住");
	assert.equal(harness.calls.prepare.length, 1, "只准备一次");
	assert.equal(harness.calls.start.length, 1, "只开始一次");
	assert.equal(harness.calls.start[0].authorization.kind, "alignment_confirmation");
	assert.equal(harness.calls.start[0].authorization.briefId, "brief-1");
	// 真实等待器必须靠定时器成功拿到权威回执：既不能超时，也不能因环境缺 timer 被当成失败。
	assert.equal(harness.mode(), "normal", "权威回执到达后回到普通模式");
	assert.deepEqual(harness.notices, [], `不得出现失败提示，实际 ${JSON.stringify(harness.notices)}`);
});

test("用户原话是普通编码提交轮：即使存在正式工作记录也走原生批准", async () => {
	const harness = await mountLiveCase({ userText: "把这次改动提交代码到分支，顺便跑一下单元测试。" });
	harness.setMode("alignment");
	const outcome = await harness.controls.prepareAndStartForApproval();
	assert.equal(outcome, "proceedWithAlignment", "明确的工程轮不得被文稿域吞掉");
	assert.equal(harness.calls.prepare.length, 0);
	assert.equal(harness.calls.start.length, 0);
	assert.equal(harness.mode(), "alignment", "没有文稿回执，模式不变（原生控件负责后续切换）");
});

test("正式轮之后的后续普通编码轮仍然走原生批准", async () => {
	const harness = createDocumentWorkHarness({ initialViews: [AUTHORIZED_WORK] });
	harness.render();
	await harness.flush();
	harness.render();
	// 上一轮正式要求之后，用户又发了编码要求：revision 前进、briefRevision 留在旧值。
	harness.setMessages([userMessage("帮我重构这个模块并补单元测试。")]);
	harness.setRuntime(runtimeSnapshot({ ...realBriefAlignment({ revision: 2, briefRevision: 1 }), phase: "clarifying" }));
	harness.render();
	const outcome = await harness.controls.prepareAndStartForApproval();
	assert.equal(outcome, "proceedWithAlignment");
	assert.equal(harness.calls.prepare.length, 0);
	assert.equal(harness.calls.start.length, 0);
});

test("用户原话没有明确信号时由当前 revision 的 brief 决定（旧 brief 不参与）", async () => {
	// 当前 brief 就是本轮的 → 文稿域。
	const current = await mountLiveCase({ userText: "按上面的要求执行。" });
	const timer = setTimeout(() => current.setAlignment({ ...realBriefAlignment(), phase: "approved" }), 20);
	const outcome = await current.controls.prepareAndStartForApproval();
	clearTimeout(timer);
	assert.equal(outcome, "documentWorkDispatched", "中立原话 + 当前 brief 走文稿域");
	assert.equal(current.calls.start.length, 1);

	// 旧 brief（briefRevision < revision）+ 中立原话 → 不得进文稿域。
	const stale = await mountLiveCase({ userText: "继续吧。", alignment: realBriefAlignment({ revision: 3, briefRevision: 1 }) });
	const staleOutcome = await stale.controls.prepareAndStartForApproval();
	assert.equal(staleOutcome, "proceedWithAlignment", "旧 brief 不得把新轮拉进文稿域");
	assert.equal(stale.calls.prepare.length, 0);
	assert.equal(stale.calls.start.length, 0);
});

test("模型 brief 措辞含糊时，正式用户原话仍然定域（不得被 brief 静默降级）", async () => {
	// 更常见的一种「模型措辞」失败：brief 写成泛泛的「按用户要求处理」，
	// 只按 brief 判断就会把正式轮降级成原生批准。用户原话是决定性的。
	const vagueBrief = alignmentSnapshot({ brief: { goal: "按用户要求处理该任务", scope: [], materials: [], deliverable: "按要求产出", preserve: [], acceptance: ["按要求"], questions: [] } });
	const harness = await mountLiveCase({ userText: "请帮我生成一份正式 Word 文档，用于对外交付。", alignment: vagueBrief });
	const timer = setTimeout(() => harness.setAlignment({ ...vagueBrief, phase: "approved" }), 20);
	const outcome = await harness.controls.prepareAndStartForApproval();
	clearTimeout(timer);
	assert.equal(outcome, "documentWorkDispatched", "用户原话优先：含糊 brief 不得降级正式轮");
	assert.equal(harness.calls.prepare.length, 1);
	assert.equal(harness.calls.start.length, 1);
});

test("正式产物 + 技术题材（类型/接口）仍走文稿域，代码产物轮仍走原生", async () => {
	// 题材里出现「桥梁类型」「传感器接口」不改变用户要的是正式报告。
	const technicalTopic = await mountLiveCase({ userText: "生成一份正式 Word 报告，介绍桥梁类型和传感器接口。", alignment: realBriefAlignment() });
	const timer = setTimeout(() => technicalTopic.setAlignment({ ...realBriefAlignment(), phase: "approved" }), 20);
	const topicOutcome = await technicalTopic.controls.prepareAndStartForApproval();
	clearTimeout(timer);
	assert.equal(topicOutcome, "documentWorkDispatched", "正式产物 + 技术题材仍是文稿轮");
	assert.equal(technicalTopic.calls.prepare.length, 1);
	assert.equal(technicalTopic.calls.start.length, 1);

	// 用户要的是代码产物：即使提到 docx/Word 也必须是普通轮。
	for (const userText of ["写一个处理 docx 的函数", "重构 Word 报告生成接口", "帮我写一个生成 Word 文档的脚本"]) {
		const coding = await mountLiveCase({ userText });
		const outcome = await coding.controls.prepareAndStartForApproval();
		assert.equal(outcome, "proceedWithAlignment", userText);
		assert.equal(coding.calls.prepare.length, 0, userText);
		assert.equal(coding.calls.start.length, 0, userText);
	}
});

test("缺成果目录仍 blocked：正式轮不发批准也不回退原生", async () => {
	const harness = createDocumentWorkHarness({ initialViews: [] });
	harness.render();
	await harness.flush();
	harness.render();
	harness.setMessages([userMessage(REAL_USER_REQUEST)]);
	harness.setRuntime(runtimeSnapshot(realBriefAlignment()));
	harness.render();
	const outcome = await harness.controls.prepareAndStartForApproval();
	assert.equal(outcome, "blocked", "明确文稿但还没有工作记录 → blocked");
	assert.equal(harness.calls.prepare.length, 0);
	assert.equal(harness.calls.start.length, 0);
});

test("没有可用运行时/对齐快照时保持 fail-closed", async () => {
	// 无 runtime：不批准任何一侧。
	const blank = createDocumentWorkHarness({ initialViews: [AUTHORIZED_WORK] });
	blank.render();
	await blank.flush();
	blank.render();
	blank.setMessages([userMessage(REAL_USER_REQUEST)]);
	blank.render();
	const blankOutcome = await blank.controls.prepareAndStartForApproval();
	assert.equal(blankOutcome, "aborted", "缺运行时必须 fail-closed");
	assert.equal(blank.calls.prepare.length, 0);
	assert.equal(blank.calls.start.length, 0);

	// 有 runtime 但对齐已退出（cancelled）：正式原话不能被静默降级成原生批准。
	// 没有可绑定的对齐 brief 就没有受控执行入口，只能 fail-closed，由用户重新对齐。
	const cancelled = await mountLiveCase({ alignment: realBriefAlignment({ phase: "cancelled" }) });
	const cancelledOutcome = await cancelled.controls.prepareAndStartForApproval();
	assert.equal(cancelledOutcome, "aborted", "正式轮没有可绑定的 brief → 不得回退原生批准");
	assert.equal(cancelled.calls.prepare.length, 0);
	assert.equal(cancelled.calls.start.length, 0);

	// 同样是 cancelled，但当前轮是普通编码：按普通轮处理，不涉及文稿域。
	const cancelledOrdinary = await mountLiveCase({ userText: "帮我重构这个模块并补单元测试。", alignment: realBriefAlignment({ phase: "cancelled" }) });
	const ordinaryOutcome = await cancelledOrdinary.controls.prepareAndStartForApproval();
	assert.equal(ordinaryOutcome, "proceedWithAlignment", "工程轮走原生批准");
	assert.equal(cancelledOrdinary.calls.prepare.length, 0);
});
