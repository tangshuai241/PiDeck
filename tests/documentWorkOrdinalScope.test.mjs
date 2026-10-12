/**
 * 普通聊天改稿的序号范围：用真实 service + 真实检查器跑根协调者复现的原指令。
 *
 * 反例（`ordinal-scope-probe/result.json`）：旧实现把「第一节保持不变」也算进 allow，
 * 且序号从不映射到真实标题，于是「只改第二节」的合法改稿被判 preserved_block_changed。
 * 这里同时钉住四件事：合法的只改第二节通过、未授权的第一节改动失败、保留句不进 allow、
 * 解析不到目标时整轮不启动（不放开全文档）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ID, createHarness, createWork, plain, prepareCreate, startRound, waitFor } from "./helpers/documentWorkServiceHarness.mjs";

/** 与根协调者探针一致的合成基稿（两个标题、各一段正文）。 */
const BASE_MD = ["# 一、项目背景", "", "长度 120 米，合成样例。", "", "# 二、实施安排", "", "先布设传感器，再进行每日检查。", ""].join("\n");
const EXACT_INSTRUCTION = "把第二节改短，改成“布设传感器后每日检查。”，第一节保持不变。";
/** 合法改稿：只动第二节。 */
const REVISED_SECOND_ONLY = ["# 一、项目背景", "", "长度 120 米，合成样例。", "", "# 二、实施安排", "", "布设传感器后每日检查。", ""].join("\n");
/** 未授权改稿：同时动了明确要求保留的第一节。 */
const REVISED_FIRST_TOO = ["# 一、项目背景", "", "长度 150 米，被改过的样例。", "", "# 二、实施安排", "", "布设传感器后每日检查。", ""].join("\n");

function pushUserTurn(harness, text, id) {
	harness.state.messages.push({ id, role: "user", text, agentId: "agent-a", timestamp: Date.now() });
}

/** 建立一件带可用基稿的工作（第一轮建档 → 归档并通过检查）。 */
async function mountWorkWithBase(harness) {
	const view = await createWork(harness);
	harness.alignment();
	const prepared = await prepareCreate(harness, view);
	assert.equal(prepared.ok, true, JSON.stringify(prepared));
	assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
	await harness.finishRound(BASE_MD);
	assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
	return view;
}

/** 触发一次普通聊天改稿并返回本轮准备记录（含解析后的范围）。 */
async function runRevisionRound(harness, workId, instruction) {
	pushUserTurn(harness, instruction, "turn-rev");
	harness.runtime.busy();
	const engaged = await harness.domain.service.autoRevise(SESSION_ID, "auto-1");
	return engaged;
}

async function preparationOf(harness, workId, requestId) {
	const operation = await harness.domain.store.getOperation(workId, requestId);
	assert.ok(operation, `缺少操作记录 ${requestId}`);
	return harness.domain.store.getPreparation(workId, operation.preparation.preparationId);
}

test("原指令只改第二节：范围解析成真实标题，合法改稿归档并通过检查", async () => {
	const harness = createHarness();
	try {
		const view = await mountWorkWithBase(harness);
		const engaged = await runRevisionRound(harness, view.workId, EXACT_INSTRUCTION);
		assert.equal(engaged.ok, true, JSON.stringify(engaged));
		assert.equal(engaged.value.engaged, true, "明确的改稿指令必须接续");
		harness.runtime.settle();
		await waitFor(() => harness.state.dispatched.some((message) => message.startsWith("改稿要求：")));

		// 准备记录里的范围：目标解析成真实标题，保留句只在 preserve 里。
		const preparation = await preparationOf(harness, view.workId, "auto-1_s");
		assert.deepEqual(plain(preparation.scope.allow), ["二、实施安排"], `allow 必须解析成真实标题，实际 ${JSON.stringify(preparation.scope.allow)}`);
		assert.equal(preparation.scope.allow.includes("一、项目背景"), false, "「第一节保持不变」绝不能扩充 allow");
		assert.equal(preparation.scope.preserve.includes("一、项目背景"), true, "被明确要求保留的块进 preserve");

		await harness.finishRound(REVISED_SECOND_ONLY);
		const operation = await harness.terminal(view.workId, "auto-1_s");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2, "改稿另存新版本");
		assert.equal(finalView.versions[0].inspection, "passed", "只改第二节必须通过保留块检查");
	} finally {
		await harness.cleanup();
	}
});

test("未授权改动被要求保留的第一节：归档后检查失败", async () => {
	const harness = createHarness();
	try {
		const view = await mountWorkWithBase(harness);
		const engaged = await runRevisionRound(harness, view.workId, EXACT_INSTRUCTION);
		assert.equal(engaged.ok, true);
		harness.runtime.settle();
		await waitFor(() => harness.state.dispatched.some((message) => message.startsWith("改稿要求：")));
		await harness.finishRound(REVISED_FIRST_TOO);
		const operation = await harness.terminal(view.workId, "auto-1_s");
		assert.equal(operation.phase, "failed", JSON.stringify(operation));
		assert.equal(operation.error.code, "INSPECTION_UNVERIFIED");
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions[0].inspection, "failed", "未被允许的块被改 → 检查失败");
	} finally {
		await harness.cleanup();
	}
});

test("解析不到正向目标时不启动本轮（不放开全文档）", async () => {
	for (const instruction of ["改第三节。", "把正文整体重写一遍。"]) {
		const harness = createHarness();
		try {
			const view = await mountWorkWithBase(harness);
			const before = harness.state.dispatched.length;
			const engaged = await runRevisionRound(harness, view.workId, instruction);
			assert.equal(engaged.ok, false, `${instruction} 必须 fail closed，实际 ${JSON.stringify(engaged)}`);
			assert.equal(engaged.error.code, "BASE_AMBIGUOUS", instruction);
			assert.equal(harness.state.dispatched.length, before, "不得分发任何改稿提示");
			const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
			assert.equal(finalView.active, null, "本轮不留活动操作");
			assert.equal(finalView.versions.length, 1, "不产生新版本");
		} finally {
			await harness.cleanup();
		}
	}
});

test("整轮否定/先解释仍是普通聊天：不接续、不分发", async () => {
	const harness = createHarness();
	try {
		const view = await mountWorkWithBase(harness);
		const before = harness.state.dispatched.length;
		const engaged = await runRevisionRound(harness, view.workId, "先不要改，先解释一下为什么第一节要这样写。");
		assert.equal(engaged.ok, true, JSON.stringify(engaged));
		assert.equal(engaged.value.engaged, false, "否定/解释轮不得启动改稿");
		assert.equal(harness.state.dispatched.length, before, "不得分发改稿提示");
	} finally {
		await harness.cleanup();
	}
});

test("同一指令在 DOCX 与 Markdown 上解析出同样的范围", async () => {
	const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { buildDocxXml, buildStylesXml, buildZip } = await import("./helpers/minimalZip.mjs");
	const { loadTsCommonJs } = await import("./helpers/loadTsCommonJs.mjs");
	const root = process.cwd();
	const { docxInspector, markdownInspector } = loadTsCommonJs(`${root}/src/main/document-work/documentInspectors.ts`);
	const { resolveRevisionScope } = loadTsCommonJs(`${root}/src/shared/documentRevisionScope.ts`);
	const directory = mkdtempSync(join(tmpdir(), "pideck-docwork-scope-"));
	try {
		const docxPath = join(directory, "base.docx");
		writeFileSync(
			docxPath,
			buildZip([
				{ name: "word/document.xml", content: buildDocxXml([{ styleId: "Heading1", text: "一、项目背景" }, "长度 120 米，合成样例。", { styleId: "Heading1", text: "二、实施安排" }, "先布设传感器，再进行每日检查。"]) },
				{ name: "word/styles.xml", content: buildStylesXml([{ styleId: "Heading1", name: "heading 1" }]) },
			]),
		);
		const markdownPath = join(directory, "base.md");
		writeFileSync(markdownPath, BASE_MD, "utf8");
		const budgets = { artifactByteBudget: 1 << 20, unpackByteBudget: 1 << 20, memberByteBudget: 1 << 20, deadlineAt: Date.now() + 2_000 };
		const docxAnalysis = await docxInspector.analyze({ filePath: docxPath, ...budgets });
		const markdownAnalysis = await markdownInspector.analyze({ filePath: markdownPath, ...budgets });
		assert.deepEqual(plain(docxAnalysis.headings), plain(markdownAnalysis.headings), "DOCX 与 Markdown 必须得到同一组标题");
		assert.deepEqual(plain(docxAnalysis.headings), ["一、项目背景", "二、实施安排"]);
		const docxScope = resolveRevisionScope({ instruction: EXACT_INSTRUCTION, headings: docxAnalysis.headings });
		const markdownScope = resolveRevisionScope({ instruction: EXACT_INSTRUCTION, headings: markdownAnalysis.headings });
		assert.deepEqual(plain(docxScope), plain(markdownScope), "同一指令在两种格式上解析结果一致");
		assert.deepEqual(plain(docxScope.allow), ["二、实施安排"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
