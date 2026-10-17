/**
 * 图表随原生 toolResult 完成历史投影：同一轮多张图各自成条，缺图的消息不受影响。
 *
 * 用真实序列化形态（会话 JSONL 里的 toolResult 条目：toolCallId / toolName / details）
 * 断言，而不是构造只在本测试里成立的形状。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { AgentMessageProjector } = loadTsCommonJs(join(ROOT, "src/main/pi/AgentMessageProjector.ts"), {
	stubs: {
		"./messageContent": {
			extractMessageText: (content) =>
				Array.isArray(content)
					? content
							.filter((item) => item?.type === "text")
							.map((item) => item.text ?? "")
							.join("\n")
					: typeof content === "string"
						? content
						: "",
		},
	},
});

function createProjector() {
	return new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
}

function chartDetails(chartId, title) {
	return {
		tpaChart: {
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
		},
	};
}

/** 一轮真实形状：用户消息 → 助手调用工具 → 两条 toolResult（其中两条都是图表）。 */
function turnEntries() {
	return [
		{ role: "user", content: [{ type: "text", text: "画两张图" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolUse", toolCallId: "call-a", name: "render_chart", input: {} }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "call-a", toolName: "render_chart", content: [{ type: "text", text: "Chart ready: A" }], details: chartDetails("chart-call-a", "第一张"), timestamp: 3 },
		{ role: "toolResult", toolCallId: "call-b", toolName: "render_chart", content: [{ type: "text", text: "Chart ready: B" }], details: chartDetails("chart-call-b", "第二张"), timestamp: 4 },
		{ role: "toolResult", toolCallId: "call-c", toolName: "bash", content: [{ type: "text", text: "ok" }], details: { tpaChart: chartDetails("chart-call-c", "不该出现").tpaChart }, timestamp: 5 },
	];
}

test("projects each chart tool result as its own message with a chart artifact", () => {
	const messages = createProjector().convert("agent", turnEntries());
	const chartMessages = messages.filter((message) => message.chart);
	assert.equal(chartMessages.length, 2, "同一轮的两张图必须各成一条");
	assert.deepEqual(
		chartMessages.map((message) => message.chart.chartId),
		["chart-call-a", "chart-call-b"],
	);
	assert.equal(chartMessages[0].chart.spec.title, "第一张");
	assert.equal(chartMessages[0].chart.spec.rows[1].labor, 0);
});

test("keeps tool text and meta intact alongside the chart field", () => {
	const messages = createProjector().convert("agent", [turnEntries()[0], turnEntries()[2]]);
	const toolMessage = messages.find((message) => message.role === "tool");
	assert.equal(toolMessage.meta.status, "done");
	assert.equal(toolMessage.meta.toolName, "render_chart");
	assert.equal(toolMessage.meta.toolCallId, "call-a");
	assert.ok(toolMessage.meta.detailText.length > 0);
});

test("leaves messages without charts unchanged", () => {
	const messages = createProjector().convert("agent", [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: 3 },
	]);
	assert.equal(
		messages.some((message) => message.chart),
		false,
	);
});

test("ignores a chart payload attached to another tool", () => {
	const messages = createProjector().convert("agent", [turnEntries()[0], turnEntries()[4]]);
	assert.equal(
		messages.some((message) => message.chart),
		false,
	);
});
