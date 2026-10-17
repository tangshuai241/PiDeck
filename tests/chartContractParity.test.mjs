/**
 * 图表契约两侧一致性：宿主 `src/shared/types/chart.ts` + `src/shared/chartDecode.ts`
 * 与扩展镜像 `resources/extensions/pi-deck-chart-contract.ts`。
 *
 * 扩展跑在 pi 进程里，不能 import 仓库 TS，因此契约有一份镜像。这里守住的是
 * 「字段名、枚举、上限、拒绝理由」不能各自漂移：扩展产出的结果必须能被宿主解码，
 * 扩展拒绝的输入宿主也不能默默接受。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const hostTypes = loadTsCommonJs(join(ROOT, "src/shared/types/chart.ts"));
const hostDecode = loadTsCommonJs(join(ROOT, "src/shared/chartDecode.ts"));
const mirror = loadTsCommonJs(join(ROOT, "resources/extensions/pi-deck-chart-contract.ts"));

function params(overrides = {}) {
	return {
		title: "月度支出",
		description: "两类支出对比",
		kind: "bar",
		x: { key: "month", label: "月份", kind: "category" },
		series: [{ key: "labor", label: "人工费", unit: "元" }],
		rows: [
			{ month: "01", labor: 100 },
			{ month: "02", labor: 0 },
			{ month: "03", labor: null },
		],
		...overrides,
	};
}

test("both sides agree on the wire constants", () => {
	assert.equal(mirror.CHART_SCHEMA_VERSION, hostTypes.CHART_SCHEMA_VERSION);
	assert.equal(mirror.CHART_TOOL_NAME, hostTypes.TPA_CHART_TOOL_NAME);
	assert.equal(mirror.TPA_CHART_DETAILS_KEY, hostTypes.TPA_CHART_DETAILS_KEY);
	assert.deepEqual([...mirror.CHART_KINDS], [...hostTypes.CHART_KINDS]);
	assert.equal(mirror.CHART_MAX_ROWS, hostTypes.CHART_MAX_ROWS);
	assert.equal(mirror.CHART_MAX_SERIES, hostTypes.CHART_MAX_SERIES);
	assert.equal(mirror.CHART_MAX_PAYLOAD_BYTES, hostTypes.CHART_MAX_PAYLOAD_BYTES);
});

test("host decodes what the extension produces", () => {
	const normalized = mirror.normalizeChartSpec(params());
	assert.equal(normalized.ok, true);
	const outcome = hostDecode.decodeChartToolResult(mirror.CHART_TOOL_NAME, {
		content: [{ type: "text", text: mirror.chartToolSummary(normalized.spec, "chart-call-1") }],
		details: { [mirror.TPA_CHART_DETAILS_KEY]: { chartId: "chart-call-1", spec: normalized.spec } },
	});
	assert.equal(outcome.ok, true, outcome.ok ? "" : `host rejected extension output: ${outcome.reason}`);
	assert.equal(outcome.artifact.spec.rows[1].labor, 0);
	assert.equal(outcome.artifact.spec.rows[2].labor, null);
});

test("both sides reject the same incompatible inputs", () => {
	const cases = [
		{ label: "negative pie", overrides: { kind: "pie", rows: [{ month: "01", labor: -1 }] } },
		{ label: "multi-series pie", overrides: { kind: "pie", series: [{ key: "labor" }, { key: "material" }], rows: [{ month: "01", labor: 1, material: 2 }] } },
		{ label: "all missing", overrides: { rows: [{ month: "01", labor: null }] } },
	];
	for (const entry of cases) {
		const normalized = mirror.normalizeChartSpec(params(entry.overrides));
		assert.equal(normalized.ok, false, `${entry.label}: extension must refuse`);
		const decoded = hostDecode.decodeChartToolResult(mirror.CHART_TOOL_NAME, {
			content: [],
			details: { [mirror.TPA_CHART_DETAILS_KEY]: { chartId: "chart-x", spec: { ...params(entry.overrides), schemaVersion: 1 } } },
		});
		assert.equal(decoded.ok, false, `${entry.label}: host must refuse`);
	}
});

test("both sides reject oversized charts", () => {
	const rows = Array.from({ length: hostTypes.CHART_MAX_ROWS + 1 }, (_, index) => ({ month: String(index), labor: index }));
	const normalized = mirror.normalizeChartSpec(params({ rows }));
	assert.equal(normalized.ok, false);
	const decoded = hostDecode.decodeChartToolResult(mirror.CHART_TOOL_NAME, {
		content: [],
		details: { [mirror.TPA_CHART_DETAILS_KEY]: { chartId: "chart-x", spec: { ...params(), rows, schemaVersion: 1 } } },
	});
	assert.equal(decoded.ok, false);
	assert.equal(decoded.reason, "row-budget");
});
