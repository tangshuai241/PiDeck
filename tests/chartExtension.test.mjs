/**
 * 扩展侧图表契约与 `render_chart` 工具注册的行为测试。
 *
 * 关心的行为：规范化保留零/缺失、超预算拒绝并要求聚合、饼图限制、身份绑定
 * （chartId 来自 toolCallId，parentChartId 透传）、结果结构含 details.tpaChart。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const ROOT = process.cwd();

const Type = {
	Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
	Optional: (schema) => ({ ...schema, optional: true }),
	String: (options = {}) => ({ type: "string", ...options }),
	Number: (options = {}) => ({ type: "number", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Null: () => ({ type: "null" }),
	Array: (items, options = {}) => ({ type: "array", items, ...options }),
	Record: (key, value, options = {}) => ({ type: "object", additionalProperties: value, ...options }),
	Union: (anyOf) => ({ anyOf }),
	Literal: (value) => ({ const: value }),
};

const sandbox = createTsSandbox({
	stubs: {
		typebox: { Type },
		"@earendil-works/pi-ai": { StringEnum: (values) => ({ enum: values }) },
	},
	globals: {},
});

const contract = sandbox(join(ROOT, "resources/extensions/pi-deck-chart-contract.ts"));
const extension = sandbox(join(ROOT, "resources/extensions/pi-deck-chart.ts"));

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function registerTool() {
	let registered;
	const api = {
		registerTool(spec) {
			registered = spec;
		},
	};
	extension.default(api);
	assert.ok(registered, "extension must register its tool");
	return registered;
}

function params(overrides = {}) {
	return {
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

test("registers a render_chart tool with the chart parameters", () => {
	const tool = registerTool();
	assert.equal(tool.name, "render_chart");
	assert.equal(typeof tool.execute, "function");
	assert.equal(tool.parameters.type, "object");
	assert.ok(tool.promptSnippet.includes("chart"));
});

test("returns details.tpaChart and a model-facing summary", async () => {
	const tool = registerTool();
	const result = await tool.execute("call-7", params());
	const details = result.details[contract.TPA_CHART_DETAILS_KEY];
	assert.equal(details.chartId, "chart-call-7");
	assert.equal(details.spec.title, "月度支出");
	assert.equal(details.spec.rows[1].labor, 0);
	assert.equal(details.spec.series[0].unit, "元");
	const text = result.content.map((block) => block.text).join("\n");
	assert.ok(text.includes("chartId: chart-call-7"), "summary must expose the chart identity for follow-ups");
	assert.ok(text.includes("rows: 2"));
});

test("passes parentChartId through for follow-up modifications", async () => {
	const tool = registerTool();
	const result = await tool.execute("call-8", params({ parentChartId: "chart-call-7", kind: "line" }));
	const details = result.details[contract.TPA_CHART_DETAILS_KEY];
	assert.equal(details.parentChartId, "chart-call-7");
	assert.ok(
		result.content
			.map((block) => block.text)
			.join("\n")
			.includes("revises: chart-call-7"),
	);
});

test("keeps missing values missing instead of filling zeros", () => {
	const normalized = contract.normalizeChartSpec(
		params({
			series: [{ key: "labor" }, { key: "material" }],
			rows: [
				{ month: "01", labor: 3 },
				{ month: "02", labor: 4, material: 9 },
			],
		}),
	);
	assert.equal(normalized.ok, true);
	assert.equal(normalized.spec.rows[0].material, null);
	assert.notEqual(normalized.spec.rows[0].material, 0);
});

test("drops undeclared row keys so only declared series are charted", () => {
	const normalized = contract.normalizeChartSpec(params({ rows: [{ month: "01", labor: 1, extra: 99 }] }));
	assert.equal(normalized.ok, true);
	assert.equal(Object.hasOwn(normalized.spec.rows[0], "extra"), false);
});

test("refuses oversized input and asks for aggregation instead of truncating", () => {
	const rows = Array.from({ length: contract.CHART_MAX_ROWS + 1 }, (_, index) => ({ month: String(index), labor: index }));
	const normalized = contract.normalizeChartSpec(params({ rows }));
	assert.equal(normalized.ok, false);
	assert.ok(normalized.error.includes("aggregate"), `expected an aggregation hint, got: ${normalized.error}`);
});

test("refuses a pie chart with negative values and suggests another kind", () => {
	const normalized = contract.normalizeChartSpec(params({ kind: "pie", rows: [{ month: "01", labor: -3 }] }));
	assert.equal(normalized.ok, false);
	assert.ok(normalized.error.includes("negative"));
});

test("rejects duplicate series keys", () => {
	const normalized = contract.normalizeChartSpec(params({ series: [{ key: "labor" }, { key: "labor" }] }));
	assert.equal(normalized.ok, false);
});

test("computes utf-8 byte length for the payload budget", () => {
	assert.equal(contract.utf8ByteLength("abc"), 3);
	assert.equal(contract.utf8ByteLength("中文"), 6);
	assert.equal(contract.utf8ByteLength("😀"), 4);
});

test("produces a spec the host decoder accepts", async () => {
	const tool = registerTool();
	const result = await tool.execute("call-9", params({ description: "两类支出对比", sources: [{ label: "台账", locator: "材料.xlsx" }] }));
	assert.deepEqual(plain(result.details[contract.TPA_CHART_DETAILS_KEY].spec).schemaVersion, 1);
});
