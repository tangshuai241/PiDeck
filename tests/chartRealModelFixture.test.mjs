/**
 * 真实模型产出的图表结果回归夹具。
 *
 * 来源：2026-10-17 用 pi 非交互模式跑真实扩展工具（`pi --print --model
 * magpie/group/auto-deepseek-v4-1-flash --thinking high -e resources/extensions/pi-deck-chart.ts`），
 * 提示词要求画分组柱状图并区分「合法 0」与「缺失」。夹具是那次运行会话 JSONL 里
 * toolResult 条目的 `details.tpaChart` 原文（未手工修改），用来证明宿主解码器接受
 * 真实模型产物，而不是只接受我们自己写的样例。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decodeChartToolResult } = loadTsCommonJs("src/shared/chartDecode.ts");

/** 真实运行产物（模型自选中文键名，未按示例改写）。 */
const REAL_MODEL_CHART = {
	chartId: "chart-call_00_fvqofm7lxueswrcpxiqk5d2q",
	spec: {
		schemaVersion: 1,
		title: "月度支出",
		kind: "bar",
		layout: "vertical",
		stacked: false,
		x: { key: "月份", label: "月份", kind: "category" },
		series: [
			{ key: "人工费", label: "人工费", unit: "元" },
			{ key: "材料费", label: "材料费", unit: "元" },
		],
		rows: [
			{ 月份: "01", 人工费: 100, 材料费: 80 },
			{ 月份: "02", 人工费: 0, 材料费: 90 },
			{ 月份: "03", 人工费: 120, 材料费: null },
		],
	},
};

test("host decoder accepts a real model chart result", () => {
	const outcome = decodeChartToolResult("render_chart", {
		content: [{ type: "text", text: "Chart ready: 月度支出" }],
		details: { tpaChart: REAL_MODEL_CHART },
	});
	assert.equal(outcome.ok, true, outcome.ok ? "" : `real fixture rejected: ${outcome.reason}`);
	assert.equal(outcome.artifact.chartId, "chart-call_00_fvqofm7lxueswrcpxiqk5d2q");
	assert.equal(outcome.artifact.spec.rows[1]["人工费"], 0);
	assert.equal(outcome.artifact.spec.rows[2]["材料费"], null);
	assert.equal(outcome.artifact.spec.series[1].unit, "元");
});
