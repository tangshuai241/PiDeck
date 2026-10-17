/**
 * 图表视图纯派生：可见系列/范围、配色身份、数值显示与导出文本。
 *
 * 断言的都是用户可观察的规则：隐藏系列不换色、范围只裁视图、零值不变成缺失、
 * 导出文本对应当前视图且按 RFC 4180 转义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const view = loadTsCommonJs("src/renderer/src/components/session/chart/chartView.ts");

function spec(overrides = {}) {
	return {
		schemaVersion: 1,
		title: "月度支出",
		kind: "bar",
		layout: "vertical",
		stacked: false,
		x: { key: "month", label: "月份", kind: "category" },
		series: [
			{ key: "labor", label: "人工费", unit: "元" },
			{ key: "material", label: "材料费", unit: "元" },
		],
		rows: [
			{ month: "01", labor: 100, material: 80 },
			{ month: "02", labor: 0, material: null },
			{ month: "03", labor: 120, material: 90 },
		],
		...overrides,
	};
}

test("keeps zero as zero and missing as missing in the derived view", () => {
	const derived = view.deriveChartView(spec(), view.initialChartInteraction(spec()));
	assert.equal(derived.rows[1].labor, 0);
	assert.equal(derived.rows[1].material, null);
	assert.equal(view.viewHasNumericValue(derived.rows, derived.series), true);
});

test("hidden series keep the colours of the source order", () => {
	const base = view.deriveChartView(spec(), view.initialChartInteraction(spec()));
	assert.equal(base.config.labor.color, "var(--color-chart-1)");
	assert.equal(base.config.material.color, "var(--color-chart-2)");

	const hidden = view.deriveChartView(spec(), { ...view.initialChartInteraction(spec()), hiddenSeries: ["labor"] });
	assert.deepEqual(JSON.parse(JSON.stringify(hidden.series.map((entry) => entry.key))), ["material"]);
	// 材料费仍是第 2 号色，不因人工费被隐藏而改色（同一数据在两次视图里颜色一致）。
	assert.equal(hidden.config.material.color, "var(--color-chart-2)");
});

test("range filtering slices the view without touching the source rows", () => {
	const source = spec();
	const rows = view.visibleRows(source, { start: 1, end: 2 });
	assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.month))), ["02", "03"]);
	assert.equal(source.rows.length, 3);
});

test("range is clamped to the available rows", () => {
	const source = spec();
	assert.equal(view.visibleRows(source, { start: -5, end: 99 }).length, 3);
	assert.equal(view.visibleRows(source, { start: 2, end: 0 }).length, 1);
});

test("value formatting keeps the original precision and only adds the unit", () => {
	assert.equal(view.formatChartValue(100, "元"), "100 元");
	assert.equal(view.formatChartValue(0, "元"), "0 元");
	assert.equal(view.formatChartValue(0.123456789, "元"), "0.123456789 元");
	assert.equal(view.formatChartValue(null, "元"), "—");
	assert.equal(view.formatChartValue(1234567.89, "元"), "1234567.89 元");
	assert.equal(view.formatChartValueForTooltip(1234567, "元"), "1,234,567 元");
});

test("delimited export matches the current view and escapes separators", () => {
	const source = spec({ rows: [{ month: '01，"一月"', labor: 100, material: 80 }] });
	const derived = view.deriveChartView(source, view.initialChartInteraction(source));
	const text = view.toDelimitedText(source, derived.rows, derived.series, ",");
	const lines = text.split("\n");
	assert.equal(lines[0], "月份,人工费 (元),材料费 (元)");
	assert.equal(lines[1], '"01，""一月""",100,80');
});

test("delimited export drops hidden series and keeps the raw numbers", () => {
	const source = spec();
	const state = { ...view.initialChartInteraction(source), hiddenSeries: ["labor"] };
	const derived = view.deriveChartView(source, state);
	const text = view.toDelimitedText(source, derived.rows, derived.series, "\t");
	assert.equal(text.split("\n")[0], "月份\t材料费 (元)");
	assert.equal(text.split("\n")[2], "02\t");
});

test("compatible kinds exclude pie for multi-series or negative data", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(view.compatibleChartKinds(spec()))), ["bar", "line", "area"]);
	assert.deepEqual(JSON.parse(JSON.stringify(view.compatibleChartKinds(spec({ series: [{ key: "labor", label: "人工费" }] })))), ["bar", "line", "area", "pie"]);
	assert.deepEqual(JSON.parse(JSON.stringify(view.compatibleChartKinds(spec({ series: [{ key: "labor", label: "人工费" }], rows: [{ month: "01", labor: -5 }] })))), ["bar", "line", "area"]);
});

test("the series legend stays while every series is hidden", () => {
	const source = spec();
	assert.equal(view.shouldShowSeriesLegend("bar", source), true);
	assert.equal(view.shouldShowSeriesLegend("line", source), true);
	// 全部隐藏后仍要渲染图例（规则与隐藏状态无关），否则用户只能重置整图。
	const allHidden = { ...view.initialChartInteraction(source), hiddenSeries: ["labor", "material"] };
	assert.deepEqual(JSON.parse(JSON.stringify(view.deriveChartView(source, allHidden).series)), []);
	assert.equal(view.shouldShowSeriesLegend("bar", source), true);
	// 饼图没有系列图例（它按扇区展示），也不该因为单系列就消失。
	assert.equal(view.shouldShowSeriesLegend("pie", source), false);
});

test("pie share is derived from the visible total and refuses nonsense", () => {
	assert.equal(view.formatChartShare(100, 220), "45.5%");
	assert.equal(view.formatChartShare(0, 220), "0.0%");
	assert.equal(view.formatChartShare(null, 220), undefined);
	assert.equal(view.formatChartShare(100, 0), undefined);
	assert.equal(view.formatChartShare(100, undefined), undefined);
});

test("initial state follows the source spec, and resets return to it", () => {
	const source = spec({ kind: "line", layout: "horizontal", stacked: true });
	const state = view.initialChartInteraction(source);
	assert.equal(state.kind, "line");
	assert.equal(state.layout, "horizontal");
	assert.equal(state.stacked, true);
	assert.equal(state.range, null);
});
