/**
 * 图表成果的纯解码与边界校验（不依赖 Node/Electron/pi）。
 *
 * 输入是模型经 `render_chart` 工具产出的原生 toolResult（主进程实时通道与历史
 * 读取通道共用同一份 `details`），属于不可信数据：这里集中检查版本、图形枚举、
 * 实际使用的数据键、系列数、有限数值和图形相容性，并保留零值与缺失值的区别。
 *
 * 失败不抛异常，返回稳定原因码；渲染层据此显示简短说明，工具原文不受影响。
 */
import { CHART_KINDS, CHART_MAX_ROWS, CHART_MAX_SERIES, CHART_SCHEMA_VERSION, TPA_CHART_DETAILS_KEY, TPA_CHART_TOOL_NAME, type ChartArtifact, type ChartAxis, type ChartAxisKind, type ChartCell, type ChartKind, type ChartSeries, type ChartSource, type ChartSpec } from "./types/chart";

export type ChartDecodeFailureReason = "not-chart-tool" | "missing-details" | "unsupported-version" | "invalid-spec" | "row-budget" | "series-budget" | "incompatible-kind";

export type ChartDecodeOutcome = { ok: true; artifact: ChartArtifact } | { ok: false; reason: ChartDecodeFailureReason };

const AXIS_KINDS: readonly ChartAxisKind[] = ["category", "date", "number"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/** 可选文本字段：非字符串或空白一律视为缺省，不因为多余字段拒绝整张图。 */
function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * 系列单元格：有限数值 → 数值；null / 缺省 → 显式缺失；其余（字符串、NaN、
 * Infinity、对象）判为非法。零是合法数值，绝不与缺失混同。
 */
function readCell(value: unknown): ChartCell | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return undefined;
}

function decodeAxis(value: unknown): ChartAxis | undefined {
	if (!isRecord(value)) return undefined;
	const key = readNonEmptyString(value.key);
	if (!key) return undefined;
	const kind = typeof value.kind === "string" && (AXIS_KINDS as readonly string[]).includes(value.kind) ? (value.kind as ChartAxisKind) : "category";
	return { key, label: readOptionalString(value.label) ?? key, kind };
}

function decodeSeries(value: unknown): ChartSeries | undefined {
	if (!isRecord(value)) return undefined;
	const key = readNonEmptyString(value.key);
	if (!key) return undefined;
	const unit = readOptionalString(value.unit);
	return { key, label: readOptionalString(value.label) ?? key, ...(unit ? { unit } : {}) };
}

function decodeSources(value: unknown): ChartSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sources: ChartSource[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const label = readNonEmptyString(entry.label);
		if (!label) continue;
		const locator = readOptionalString(entry.locator);
		sources.push({ label, ...(locator ? { locator } : {}) });
	}
	return sources.length > 0 ? sources : undefined;
}

function hasNumericValue(rows: Array<Record<string, ChartCell>>, series: ChartSeries[]): boolean {
	return rows.some((row) => series.some((entry) => typeof row[entry.key] === "number"));
}

/** 饼图限制：单一非负系列，且不能对负值计算占比。 */
function isPieCompatible(rows: Array<Record<string, ChartCell>>, series: ChartSeries[]): boolean {
	if (series.length !== 1) return false;
	const key = series[0]?.key;
	if (!key) return false;
	return rows.every((row) => {
		const value = row[key] ?? null;
		return value === null || (typeof value === "number" && value >= 0);
	});
}

/**
 * 从 `render_chart` 的原生结果里取出图表成果。
 *
 * 结果形态：`{ content, details: { tpaChart: ChartArtifact } }`。历史条目里
 * `details` 是持久化字段；实时通道的 RPC 结果同样带 `details`。个别 pi 版本会把
 * 结构化字段直接挂在结果顶层（既有 `ask_question` 卡片处理同一差异），因此这里
 * 也接受顶层 `tpaChart`，与主进程既有读取方式保持一致。
 */
export function decodeChartToolResult(toolName: string, result: unknown): ChartDecodeOutcome {
	if (toolName !== TPA_CHART_TOOL_NAME) return { ok: false, reason: "not-chart-tool" };
	if (!isRecord(result)) return { ok: false, reason: "missing-details" };
	const details = isRecord(result.details) ? result.details : result;
	const raw = details[TPA_CHART_DETAILS_KEY];
	if (!isRecord(raw)) return { ok: false, reason: "missing-details" };

	const chartId = readNonEmptyString(raw.chartId);
	if (!chartId) return { ok: false, reason: "missing-details" };
	const specValue = raw.spec;
	if (!isRecord(specValue)) return { ok: false, reason: "invalid-spec" };

	const version = specValue.schemaVersion;
	if (version !== CHART_SCHEMA_VERSION) return { ok: false, reason: "unsupported-version" };

	const title = readNonEmptyString(specValue.title);
	if (!title) return { ok: false, reason: "invalid-spec" };

	const kind = specValue.kind;
	if (typeof kind !== "string" || !(CHART_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "invalid-spec" };

	const x = decodeAxis(specValue.x);
	if (!x) return { ok: false, reason: "invalid-spec" };

	const seriesValue = specValue.series;
	if (!Array.isArray(seriesValue) || seriesValue.length === 0) return { ok: false, reason: "invalid-spec" };
	if (seriesValue.length > CHART_MAX_SERIES) return { ok: false, reason: "series-budget" };
	const series: ChartSeries[] = [];
	for (const entry of seriesValue) {
		const decoded = decodeSeries(entry);
		if (!decoded) return { ok: false, reason: "invalid-spec" };
		if (series.some((existing) => existing.key === decoded.key)) return { ok: false, reason: "invalid-spec" };
		series.push(decoded);
	}

	const rowsValue = specValue.rows;
	if (!Array.isArray(rowsValue)) return { ok: false, reason: "invalid-spec" };
	if (rowsValue.length > CHART_MAX_ROWS) return { ok: false, reason: "row-budget" };

	const rows: Array<Record<string, ChartCell>> = [];
	for (const entry of rowsValue) {
		if (!isRecord(entry)) return { ok: false, reason: "invalid-spec" };
		const axisRaw = entry[x.key];
		let axisCell: ChartCell;
		if (typeof axisRaw === "string") axisCell = axisRaw;
		else if (typeof axisRaw === "number" && Number.isFinite(axisRaw)) axisCell = axisRaw;
		else return { ok: false, reason: "invalid-spec" };
		const row: Record<string, ChartCell> = {};
		row[x.key] = axisCell;
		for (const entrySeries of series) {
			const cell = readCell(entry[entrySeries.key]);
			if (cell === undefined) return { ok: false, reason: "invalid-spec" };
			row[entrySeries.key] = cell;
		}
		rows.push(row);
	}

	const layout = specValue.layout === "horizontal" ? "horizontal" : "vertical";
	const stacked = kind === "area" && specValue.stacked === true;
	const description = readOptionalString(specValue.description);
	const sources = decodeSources(specValue.sources);

	const spec: ChartSpec = {
		schemaVersion: CHART_SCHEMA_VERSION,
		title,
		...(description ? { description } : {}),
		kind: kind as ChartKind,
		layout,
		stacked,
		x,
		series,
		rows,
		...(sources ? { sources } : {}),
	};

	// 图形相容性：条形/折线/面积需要至少一个数值；饼图需要单一非负系列。
	if (kind === "pie") {
		if (!isPieCompatible(rows, series)) return { ok: false, reason: "incompatible-kind" };
	} else if (!hasNumericValue(rows, series)) {
		return { ok: false, reason: "incompatible-kind" };
	}

	const parentChartId = readNonEmptyString(raw.parentChartId);
	return { ok: true, artifact: { chartId, ...(parentChartId ? { parentChartId } : {}), spec } };
}

/** 仅判断是否为图表工具结果（用于工具详情文案，不解析数据）。 */
export function isChartToolName(toolName: string): boolean {
	return toolName === TPA_CHART_TOOL_NAME;
}
