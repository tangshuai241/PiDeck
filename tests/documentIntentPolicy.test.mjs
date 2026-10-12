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

const intent = (text, hasWork = false, hasUsableBase = true) => policy.isDocumentWorkIntent({ text, hasWork, hasUsableBase });

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

test("已有工作但没有可用基稿时不接续", () => {
	assert.equal(intent("再写一份季度报告", true, false), false);
	assert.equal(intent("再写一份季度报告", true, true), true);
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

test("改稿范围提示只取用户指到的块名", () => {
	assert.deepEqual(plain(policy.revisionScopeHints("把第二节改短，标题也换一下")), ["第二节", "标题"]);
	assert.deepEqual(plain(policy.revisionScopeHints("润色附录和摘要")), ["附录", "摘要"]);
	assert.deepEqual(plain(policy.revisionScopeHints("随便看看")), []);
});
