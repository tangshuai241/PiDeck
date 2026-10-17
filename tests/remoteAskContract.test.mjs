import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const desktop = loadTsCommonJs("src/renderer/src/utils/askUi.ts");
const phone = loadTsCommonJs("packages/tpa-remote/src/ask.ts");

const questions = [
	{ id: "b1", type: "select" },
	{ id: "b2", type: "multi_select" },
	{ id: "b3", type: "confirm" },
	{ id: "b4", type: "input" },
];
const answers = { b1: "React", b2: ["Node", "Deno"], b3: true, b4: "my-app" };

test("手机端批量答案信封与桌面逐字段一致", () => {
	assert.equal(phone.serializeBatchAnswers(questions, answers), desktop.serializeBatchAnswers(questions, answers));
	assert.equal(phone.batchAnswerLabel(false), desktop.batchAnswerLabel(false));
	assert.equal(phone.batchAnswerLabel(["A", "B"]), desktop.batchAnswerLabel(["A", "B"]));
});

test("待回答摘要：单题取标题，批量题取第一题，内部标记不进入摘要", () => {
	assert.equal(phone.askQuestionSummary({ title: "选择发布方式" }), "选择发布方式");
	assert.equal(phone.askQuestionSummary({ title: "", questions: [{ question: "环境？" }, { question: "端口？" }] }), "环境？");
	assert.equal(phone.askQuestionSummary({ title: "[PI_DECK_PLAN_NEXT] 开始执行" }), "开始执行");
	assert.equal(phone.askQuestionSummary({ title: "" }), undefined);
});
