/**
 * 图表解码纯函数的边界测试。
 *
 * 只从公开入口断言「哪些结果被接受、哪些必须被拒绝」，并守住两条数据纪律：
 * 合法零值不被当成缺失，缺失值不被补成零。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const decode = loadTsCommonJs(join(ROOT, "src/shared/chartDecode.ts"));
const chartTypes = loadTsCommonJs(join(ROOT, "src/shared/types/chart.ts"));

/** 沙箱对象原型与测试进程不同：比较前 JSON 归一。 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function spec(overrides = {}) {
	return {
		schemaVersion: 1,
		title: "月度支出",
		kind: "bar",
		x: { key: "month", label: "月份", kind: "category" },
		series: [{ key: "labor", label: "人工费", unit: "元" }],
		rows: [
			{ month: "01", labor: 100 },
			{ month: "02", labor: 0 },
		],
		...overrides,
	};
}

function result(chart, extras = {}) {
	return { content: [{ type: "text", text: "ok" }], details: { tpaChart: { chartId: "chart-call-1", ...chart } }, ...extras };
}

test("decodes a well-formed chart tool result", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec() }));
	assert.equal(outcome.ok, true);
	assert.equal(outcome.artifact.chartId, "chart-call-1");
	assert.equal(outcome.artifact.spec.title, "月度支出");
	assert.equal(outcome.artifact.spec.series[0].unit, "元");
});

test("keeps a legal zero distinct from a missing value", () => {
	const outcome = decode.decodeChartToolResult(
		"render_chart",
		result({
			spec: spec({
				series: [{ key: "labor" }, { key: "material" }],
				rows: [
					{ month: "01", labor: 0, material: null },
					{ month: "02", labor: 5, material: 7 },
				],
			}),
		}),
	);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.artifact.spec.rows[0].labor, 0);
	assert.equal(outcome.artifact.spec.rows[0].material, null);
});

test("treats an absent series cell as explicit missing, never as zero", () => {
	const outcome = decode.decodeChartToolResult(
		"render_chart",
		result({
			spec: spec({
				series: [{ key: "labor" }, { key: "material" }],
				rows: [
					{ month: "01", labor: 3 },
					{ month: "02", labor: 4, material: 9 },
				],
			}),
		}),
	);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.artifact.spec.rows[0].material, null);
	assert.notEqual(outcome.artifact.spec.rows[0].material, 0);
});

test("rejects negative values in a pie chart with a compatible-kind reason", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ kind: "pie", rows: [{ month: "01", labor: -1 }] }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "incompatible-kind");
});

test("rejects a pie chart with more than one series", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ kind: "pie", series: [{ key: "labor" }, { key: "material" }], rows: [{ month: "01", labor: 1, material: 2 }] }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "incompatible-kind");
});

test("accepts an all-zero pie chart and leaves the rendering decision to the view", () => {
	const outcome = decode.decodeChartToolResult(
		"render_chart",
		result({
			spec: spec({
				kind: "pie",
				rows: [
					{ month: "01", labor: 0 },
					{ month: "02", labor: 0 },
				],
			}),
		}),
	);
	assert.equal(outcome.ok, true);
});

test("rejects a chart whose every series value is missing", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ kind: "line", rows: [{ month: "01", labor: null }] }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "incompatible-kind");
});

test("rejects an unsupported schema version", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ schemaVersion: 2 }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "unsupported-version");
});

test("rejects rows over the product budget instead of truncating them", () => {
	const rows = Array.from({ length: chartTypes.CHART_MAX_ROWS + 1 }, (_, index) => ({ month: String(index), labor: index }));
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ rows }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "row-budget");
});

test("rejects series over the product budget", () => {
	const series = Array.from({ length: chartTypes.CHART_MAX_SERIES + 1 }, (_, index) => ({ key: `s${index}` }));
	const row = { month: "01" };
	for (const entry of series) row[entry.key] = 1;
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ series, rows: [row] }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "series-budget");
});

test("rejects non-finite and non-numeric series values", () => {
	for (const bad of ["12", Number.POSITIVE_INFINITY, { value: 1 }]) {
		const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ rows: [{ month: "01", labor: bad }] }) }));
		assert.equal(outcome.ok, false, `expected ${String(bad)} to be rejected`);
		assert.equal(outcome.reason, "invalid-spec");
	}
});

test("rejects rows that do not carry the declared x key", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ rows: [{ labor: 1 }] }) }));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "invalid-spec");
});

test("ignores other tools and missing details", () => {
	assert.equal(decode.decodeChartToolResult("bash", result({ spec: spec() })).reason, "not-chart-tool");
	assert.equal(decode.decodeChartToolResult("render_chart", { content: [] }).reason, "missing-details");
	assert.equal(decode.decodeChartToolResult("render_chart", { content: [], details: { other: 1 } }).reason, "missing-details");
});

test("keeps the parent chart identity for follow-up modifications", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ chartId: "chart-call-2", parentChartId: "chart-call-1", spec: spec({ kind: "line" }) }));
	assert.equal(outcome.ok, true);
	assert.deepEqual(plain(outcome.artifact), {
		chartId: "chart-call-2",
		parentChartId: "chart-call-1",
		spec: {
			schemaVersion: 1,
			title: "月度支出",
			kind: "line",
			layout: "vertical",
			stacked: false,
			x: { key: "month", label: "月份", kind: "category" },
			series: [{ key: "labor", label: "人工费", unit: "元" }],
			rows: [
				{ month: "01", labor: 100 },
				{ month: "02", labor: 0 },
			],
		},
	});
});

test("drops unknown keys that the chart does not declare", () => {
	const outcome = decode.decodeChartToolResult("render_chart", result({ spec: spec({ rows: [{ month: "01", labor: 1, note: "should not be charted" }] }) }));
	assert.equal(outcome.ok, true);
	assert.equal(Object.hasOwn(outcome.artifact.spec.rows[0], "note"), false);
});
