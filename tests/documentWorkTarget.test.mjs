/**
 * 正式文稿 vs 普通开发的纯策略矩阵（renderer 与主进程共用同一份实现）。
 *
 * 判据只来自权威要求单的文字：普通 Plan（重构代码、修 bug、解释材料）一律不强制归档；
 * 模糊时同样按普通处理；明确文档产物才进文稿。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const policy = loadTsCommonJs("src/shared/documentWorkTarget.ts");

test("明确文档目标进入文稿，普通开发与模糊请求不进入", () => {
	const document = [
		{ goal: "写一份季度复盘", deliverable: "季度复盘报告.docx" },
		{ goal: "整理会议记录", deliverable: "会议纪要" },
		{ goal: "写方案", deliverable: "方案书" },
		{ goal: "帮我写一份说明文档", deliverable: "README（Markdown）" },
		{ goal: "draft a project report", deliverable: "report.md" },
	];
	for (const input of document) assert.equal(policy.classifyDocumentTarget(input).kind, "document", JSON.stringify(input));

	const plain = [
		{ goal: "重构 foo.ts 里的解析逻辑", deliverable: "更新后的 foo.ts" },
		{ goal: "修复登录 bug", deliverable: "修改 src/auth.ts" },
		{ goal: "解释一下这段代码", deliverable: "口头说明" },
		{ goal: "读一下这些材料", deliverable: "总结要点" },
		{ goal: "研究一下这个方案", deliverable: "结论" },
		{ goal: "", deliverable: "" },
		{ goal: "优化构建流程", deliverable: "package.json 与 CI 配置" },
	];
	for (const input of plain) assert.equal(policy.classifyDocumentTarget(input).kind, "plain", JSON.stringify(input));

	// 代码扩展名优先于"文档"字样：写一个 .ts 不是正式文稿。
	assert.equal(policy.classifyDocumentTarget({ goal: "更新文档注释", deliverable: "src/foo.ts" }).kind, "plain");
});

test("路由只在 pi 后端 + 需求模式 + 明确文档目标时进入文稿", () => {
	assert.equal(policy.shouldRouteRoundToDocumentWork({ backend: "pi", mode: "alignment", brief: { goal: "写报告", deliverable: "报告.docx" } }).route, "document");
	assert.equal(policy.shouldRouteRoundToDocumentWork({ backend: "pi", mode: "alignment", brief: { goal: "重构 foo.ts", deliverable: "foo.ts" } }).route, "plain");
	assert.equal(policy.shouldRouteRoundToDocumentWork({ backend: "pi", mode: "normal", brief: { goal: "写报告", deliverable: "报告.docx" } }).route, "plain");
	assert.equal(policy.shouldRouteRoundToDocumentWork({ backend: "dsh", mode: "alignment", brief: { goal: "写报告", deliverable: "报告.docx" } }).route, "plain");
	// 要求单还没发布：无从判断，按普通处理（模糊不强制归档）。
	assert.equal(policy.shouldRouteRoundToDocumentWork({ backend: "pi", mode: "alignment", brief: undefined }).route, "plain");
});

test("只有文稿轮次缺成果目录才拦批准", () => {
	assert.deepEqual({ ...policy.shouldBlockDocumentApproval({ route: "document", hasWork: true, hasOutputRoot: false }) }, { block: true, reason: "the document round needs an output folder before it can start" });
	assert.equal(policy.shouldBlockDocumentApproval({ route: "document", hasWork: true, hasOutputRoot: true }).block, false);
	assert.equal(policy.shouldBlockDocumentApproval({ route: "plain", hasWork: true, hasOutputRoot: false }).block, false, "普通开发不得被要求选目录");
	assert.equal(policy.shouldBlockDocumentApproval({ route: "document", hasWork: false, hasOutputRoot: false }).block, false);
});
