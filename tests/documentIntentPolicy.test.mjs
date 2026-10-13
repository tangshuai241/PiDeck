/**
 * 文稿意图与改稿请求策略：普通 Plan/编码/解释不得被接进文稿归档；
 * 明确改稿要自动接续（不要求用户切模式），但讨论/否定/先解释一律不启动。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
/** 被加载模块在 vm 里有独立原型链：结构比较前先 JSON 归一。 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const policy = loadTsCommonJs(`${ROOT}/src/shared/documentIntentPolicy.ts`);

const intent = (text) => policy.isDocumentWorkIntent(text);

test("明确文稿任务才接进文稿生命周期", () => {
	for (const text of ["帮我写一份季度报告", "起草一份合作方案，输出 Word 文档", "把这个整理成正式文档并归档", "写一版对外说明的初稿"]) {
		assert.equal(intent(text), true, text);
	}
});

test("普通 Plan、编码、解释与读材料都不接进文稿归档", () => {
	for (const text of ["先分析一下这个函数的性能", "解释一下这段代码做了什么", "帮我重构这个模块并补单元测试", "读一下这个文件然后告诉我结构", "帮我看看这个报错堆栈", "plz 生成 api 的类型定义", "提交这些改动到分支"]) {
		assert.equal(intent(text), false, text);
	}
});

test("策略只管「这一轮是不是文稿任务」，可用基稿由调用方决定", () => {
	// 同一句话无论有没有可用基稿都必须被认成文稿任务：否则「改稿却没基稿」会被
	// 误判成普通聊天并交给原生批准，用户的要求就悄悄丢了。
	assert.equal(intent("再写一份季度报告"), true);
	assert.equal(intent("把第二节改短一点"), false, "只声明改哪里不算制作任务，走改稿策略");
});

test("明确改稿请求自动接续：必须同时有改稿动词与定位词", () => {
	assert.equal(policy.isExplicitRevisionRequest("把第二节改短一点"), true);
	assert.equal(policy.isExplicitRevisionRequest("第二章的数据换成最新口径"), true);
	assert.equal(policy.isExplicitRevisionRequest("标题改成更正式的写法"), true);
	assert.equal(policy.isExplicitRevisionRequest("最后一段删掉"), true);
	// 只有动词没有定位：范围不明，先澄清而不是自动开工。
	assert.equal(policy.isExplicitRevisionRequest("帮我改一下"), false);
	assert.equal(policy.isExplicitRevisionRequest("这段再润色一下"), false);
});

test("讨论、否定与「先解释」都不构成改稿授权", () => {
	for (const text of ["别改，先解释一下为什么这样写", "不要改第二章，先说明依据", "第三章现在是什么内容？", "这个方案的缺点是什么", "先别动标题，我想想", "只是想问问第三节的格式", "帮我改一下这个函数的命名"]) {
		assert.equal(policy.isExplicitRevisionRequest(text), false, text);
	}
});

test("裸「提交」不是工程语境，工程搭配仍然是", () => {
	// 真实验收 defect：正式 brief 里的「本轮只提交确认单」被当成工程词，整轮被降级成原生批准。
	const liveBrief = "按用户给定内容起草正式 Word 报告《桥梁监测安排》（DOCX）：正文只含两节，逐字使用消息中提供的文字，不加事实、不扩写；本轮只提交确认单，待用户确认后再生成文件。";
	assert.equal(policy.hasOrdinaryEngineeringIntent("本轮只提交确认单，待用户确认后再生成文件"), false, "裸提交不得当工程语境");
	assert.equal(policy.isDocumentWorkIntent(liveBrief), true, "真实 brief 必须被判成正式文稿要求");
	assert.equal(policy.isDocumentWorkIntent("起草一份正式报告并提交确认单，待确认后生成文件"), true, "文稿语境里的提交不被否决");
	// 工程搭配与其余工程词的保护原样保留。
	for (const text of ["提交代码到分支", "提交这次改动", "git commit 一下", "帮我重构这个模块", "补一下单元测试"]) {
		assert.equal(policy.hasOrdinaryEngineeringIntent(text), true, text);
		assert.equal(policy.isDocumentWorkIntent(text), false, text);
	}
});

test("正式文稿内容里的技术名词不得否决文稿域，代码动作仍判普通轮", () => {
	// 用户要的是「正式 Word 报告」，内容里出现「类型/接口」等词是正常的题材描述。
	assert.equal(policy.isDocumentWorkIntent("生成一份正式 Word 报告，介绍桥梁类型和传感器接口"), true, "正式产物 + 技术题材仍是文稿");
	assert.equal(policy.routeDocumentTurn({ userText: "生成一份正式 Word 报告，介绍桥梁类型和传感器接口", briefText: "" }), "document");
	// 反过来，用户要的是代码产物时，即使提到 Word/docx 也必须是普通轮。
	for (const text of ["写一个处理 docx 的函数", "重构 Word 报告生成接口", "帮我写一个生成 Word 文档的脚本"]) {
		assert.equal(policy.isDocumentWorkIntent(text), false, text);
		assert.equal(policy.routeDocumentTurn({ userText: text, briefText: "" }), "ordinary", text);
	}
});

test("当前轮路由：用户原话优先，旧版 brief 不参与", () => {
	const brief = "起草正式 Word 报告《季度经营分析》（DOCX），只提交确认单，待确认后生成文件。";
	assert.equal(policy.routeDocumentTurn({ userText: "请帮我生成一份正式 Word 文档", briefText: brief }), "document", "用户原话与 brief 都是文稿 → 文稿域");
	assert.equal(policy.routeDocumentTurn({ userText: "", briefText: brief }), "document", "用户原话无信号时由当前 brief 决定");
	assert.equal(policy.routeDocumentTurn({ userText: "按上面的要求执行。", briefText: brief }), "document");
	assert.equal(policy.routeDocumentTurn({ userText: "帮我重构这个模块并补单元测试", briefText: brief }), "ordinary", "明确工程轮不得被 brief 拖进文稿域");
	assert.equal(policy.routeDocumentTurn({ userText: "", briefText: "" }), "ordinary", "两侧都没有证据 → 普通轮");
	// 旧 brief 由调用方负责不传入（briefRevision ≠ revision）；传空即普通轮。
	assert.equal(policy.routeDocumentTurn({ userText: "继续吧。", briefText: "" }), "ordinary");
});
