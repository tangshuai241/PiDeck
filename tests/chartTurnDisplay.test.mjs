/**
 * 图表成果在回合展示策略里的位置与常显语义。
 *
 * 断言的是一条产品规则：图表成果不随执行过程折叠消失，也不是每条图都追加到会话末尾；
 * 它出现在对应工具调用的位置，并与工具摘要引用同一个 toolCallId。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildTurnDisplay, hasFoldableContent } = loadTsCommonJs("src/renderer/src/components/session/timeline/buildTurnDisplay.ts");

/** 沙箱对象原型与测试进程不同：结构比较前 JSON 归一。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function chartArtifact(chartId, title = "月度支出") {
	return {
		chartId,
		spec: {
			schemaVersion: 1,
			title,
			kind: "bar",
			layout: "vertical",
			stacked: false,
			x: { key: "month", label: "月份", kind: "category" },
			series: [{ key: "labor", label: "人工费", unit: "元" }],
			rows: [
				{ month: "01", labor: 100 },
				{ month: "02", labor: 0 },
			],
		},
	};
}

function toolMessage(id, toolCallId, chart, status = "done") {
	return {
		id,
		agentId: "agent-a",
		role: "tool",
		text: "✓ render_chart",
		timestamp: 10,
		meta: { status, toolName: "render_chart", toolCallId },
		...(chart ? { chart } : {}),
	};
}

function assistantMessage(id, text, stopReason = "toolUse") {
	return { id, agentId: "agent-a", role: "assistant", text, timestamp: 5, stopReason };
}

function run(items) {
	return { kind: "agent-run", id: "run-a", items, startedAt: 1, endedAt: 20, askWaitMs: 0, askPending: false };
}

test("chart artifact appears as an always-visible item next to the folded tool step", () => {
	const display = buildTurnDisplay(
		run([
			{ kind: "message", message: assistantMessage("m1", "先图再看") },
			{ kind: "tool-group", id: "tg1", messages: [toolMessage("t1", "call-1", chartArtifact("chart-call-1"))] },
			{ kind: "message", message: { ...assistantMessage("m2", "结论：一月最高。", "stop") } },
		]),
		{ showThinking: false, isComplete: true },
	);

	const kinds = display.map((item) => item.kind);
	assert.deepEqual(plain(kinds), ["interim-answer", "process-entry", "chart-artifact", "final-answer"]);
	const artifact = display.find((item) => item.kind === "chart-artifact");
	assert.equal(artifact.artifact.chartId, "chart-call-1");
	assert.equal(artifact.artifact.spec.rows[1].labor, 0);
	assert.equal(artifact.id, "chart-t1");
});

test("a running chart tool shows a short pending state instead of an empty card", () => {
	const display = buildTurnDisplay(run([{ kind: "tool-group", id: "tg1", messages: [toolMessage("t1", "call-1", undefined, "running")] }]), { showThinking: false, isComplete: false });
	const pending = display.filter((item) => item.kind === "chart-pending");
	assert.equal(pending.length, 1);
	assert.equal(
		display.some((item) => item.kind === "chart-artifact"),
		false,
	);
});

test("charts alone do not produce a fold summary button", () => {
	const display = buildTurnDisplay(run([{ kind: "tool-group", id: "tg1", messages: [toolMessage("t1", "call-1", chartArtifact("chart-call-1"))] }]), { showThinking: false, isComplete: true });
	// 工具步本身可折叠（execution process），但图表项不应被计入可折叠内容。
	const withoutProcessEntries = display.filter((item) => item.kind !== "process-entry");
	assert.equal(hasFoldableContent(withoutProcessEntries), false);
	assert.equal(hasFoldableContent(display), true);
});

test("two charts in one turn keep their own order and identity", () => {
	const display = buildTurnDisplay(
		run([
			{ kind: "tool-group", id: "tg1", messages: [toolMessage("t1", "call-1", chartArtifact("chart-call-1", "第一张"))] },
			{ kind: "tool-group", id: "tg2", messages: [toolMessage("t2", "call-2", chartArtifact("chart-call-2", "第二张"))] },
		]),
		{ showThinking: false, isComplete: true },
	);
	const charts = display.filter((item) => item.kind === "chart-artifact");
	assert.deepEqual(plain(charts.map((item) => item.id)), ["chart-t1", "chart-t2"]);
	assert.deepEqual(plain(charts.map((item) => item.artifact.spec.title)), ["第一张", "第二张"]);
});

test("a chart result that failed to decode leaves no artifact and no pending state", () => {
	const failed = toolMessage("t1", "call-1", undefined, "done");
	failed.meta._chartDecodeReason = "incompatible-kind";
	const display = buildTurnDisplay(run([{ kind: "tool-group", id: "tg1", messages: [failed] }]), { showThinking: false, isComplete: true });
	assert.equal(
		display.some((item) => item.kind === "chart-artifact" || item.kind === "chart-pending"),
		false,
	);
});
