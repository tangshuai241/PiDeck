/**
 * PiDeck 交互图表工具（pi 侧）：`render_chart`。
 *
 * 模型把已经聚合好的数据交给本工具；工具只做规范化与身份绑定，不重算业务数据：
 * - 图形、系列、轴与行都来自模型参数，零值保持零、缺失值保持缺失；
 * - 图表身份由真实 `toolCallId` 生成，模型要改图时通过 `parentChartId` 引用
 *   上一次工具回执里的身份（见 `chartToolSummary` 输出），不自行编造；
 * - 完整绘图数据放在原生 toolResult 的 `details.tpaChart` 里，模型可见内容只有
 *   一段摘要，避免把整表塞进上下文。
 *
 * 宿主侧解码见 `src/shared/chartDecode.ts`；两侧字段以
 * `resources/extensions/pi-deck-chart-contract.ts` 为准。
 *
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CHART_AXIS_KINDS, CHART_KINDS, CHART_MAX_ROWS, CHART_MAX_SERIES, TPA_CHART_DETAILS_KEY, chartIdForToolCall, chartToolSummary, normalizeChartSpec } from "./pi-deck-chart-contract";

const ChartParams = Type.Object(
	{
		title: Type.String({ description: "Chart title shown to the user" }),
		description: Type.Optional(Type.String({ description: "One short sentence under the title" })),
		kind: StringEnum(CHART_KINDS, { description: "Chart type; use bar for category comparison, line for trends, area for volume over time, pie for a single non-negative share" }),
		layout: Type.Optional(StringEnum(["vertical", "horizontal"] as const, { description: "Use horizontal bars when category labels are long or numerous" })),
		stacked: Type.Optional(Type.Boolean({ description: "Stack the series (area/bar) instead of placing them side by side" })),
		x: Type.Object(
			{
				key: Type.String({ description: "Row key holding the category/date/number of the x axis" }),
				label: Type.Optional(Type.String({ description: "Axis label shown to the user; defaults to the key" })),
				kind: Type.Optional(StringEnum(CHART_AXIS_KINDS, { description: "Axis value kind; defaults to category" })),
			},
			{ additionalProperties: false },
		),
		series: Type.Array(
			Type.Object(
				{
					key: Type.String({ description: "Row key holding this series' numbers" }),
					label: Type.Optional(Type.String({ description: "Series label; defaults to the key" })),
					unit: Type.Optional(Type.String({ description: "Unit shown with values, e.g. CNY or %" })),
				},
				{ additionalProperties: false },
			),
			{ description: "Plotted series, in legend order", minItems: 1, maxItems: CHART_MAX_SERIES },
		),
		rows: Type.Array(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Null()])), {
			description: "Chart rows; only the declared x key and series keys are plotted",
			maxItems: CHART_MAX_ROWS,
		}),
		sources: Type.Optional(
			Type.Array(
				Type.Object(
					{
						label: Type.String({ description: "Where the numbers come from" }),
						locator: Type.Optional(Type.String({ description: "File path, sheet name, or other locator" })),
					},
					{ additionalProperties: false },
				),
				{ description: "Data sources shown under the chart" },
			),
		),
		parentChartId: Type.Optional(
			Type.String({ description: "The chartId from an earlier render_chart receipt when this chart revises that one; use the exact value, do not invent one" }),
		),
	},
	{ additionalProperties: false },
);

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default function piDeckChartExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "render_chart",
		label: "Chart",
		description:
			"Render an interactive chart card in the conversation from data you have already prepared. The user can hover values, toggle series, read the data table, zoom, and export. Group, sort, aggregate, and compute the numbers yourself before calling this tool; the chart never recomputes business values.",
		promptSnippet: "Render an interactive chart card (bar / line / area / pie) in the conversation",
		promptGuidelines: [
			"Call render_chart when the answer is clearer as a chart: comparisons across categories, trends over time, composition shares. Do not announce the tool; just present the result.",
			"Prepare the data first: group, sort and aggregate in your own reasoning or with tools, then pass the finished rows. Never pass placeholder or fabricated numbers.",
			"Keep zero and missing values distinct: pass 0 as 0, and omit or pass null for genuinely missing values. Never fill gaps with zero, and never smooth a series into a shape the source data does not have.",
			"Match the chart type to the data: bar for categories, line for trends, area (optionally stacked) for volume over time, pie only for one non-negative share.",
			"At most 2000 rows and 8 series per chart. Aggregate before charting when the data is larger; the tool refuses oversized input instead of truncating it.",
			"To revise a chart the user already saw, call render_chart again with the exact chartId from the earlier receipt as parentChartId. The previous chart stays visible; never rewrite it.",
			"After the tool result, keep the reply short: one sentence of interpretation is enough, the card carries the numbers.",
		],
		parameters: ChartParams,

		async execute(toolCallId, params) {
			const normalized = normalizeChartSpec(params);
			if (!normalized.ok) {
				// 校验失败抛错：由 pi 转成 isError，模型看到原因后可修正或先聚合。
				throw new Error(normalized.error);
			}
			const chartId = chartIdForToolCall(toolCallId);
			const parentChartId = nonEmptyString((params as { parentChartId?: unknown }).parentChartId);
			const summary = chartToolSummary(normalized.spec, chartId);
			return {
				content: [{ type: "text" as const, text: parentChartId ? `${summary}\nrevises: ${parentChartId}` : summary }],
				details: {
					[TPA_CHART_DETAILS_KEY]: {
						chartId,
						...(parentChartId ? { parentChartId } : {}),
						spec: normalized.spec,
					},
				},
			};
		},
	});
}
