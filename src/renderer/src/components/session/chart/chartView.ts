/**
 * 图表视图的纯派生逻辑（无 React 依赖，可单测）。
 *
 * 纪律：这里只做「当前视图」的派生——隐藏哪些系列、看到哪些行、按什么图形画；
 * 不改写源数据，不做业务重算（不加总、不排序、不补零），导出也只是把视图原样序列化。
 */
import type { ChartArtifact, ChartCell, ChartInteractionState, ChartKind, ChartSeries, ChartSpec } from "../../../../../shared/types/chart";

export const DEFAULT_CHART_INTERACTION: ChartInteractionState = {
	hiddenSeries: [],
	layout: "vertical",
	stacked: false,
	kind: "bar",
	range: null,
	zoomed: false,
};

/** 系列配色：按系列在下标顺序里循环取 --chart-1..6（换图形不变身份）。 */
const SERIES_COLOR_COUNT = 6;

export function seriesColorValue(index: number): string {
	return `var(--color-chart-${(index % SERIES_COLOR_COUNT) + 1})`;
}

/** 交互状态按 `sessionId + chartId` 隔离：多栏/多会话不串图。 */
export function chartInteractionKey(sessionId: string | undefined, chartId: string): string {
	return `${sessionId ?? "no-session"}::${chartId}`;
}

/** 该图形是否支持堆叠（面积与柱状；折线是无堆叠概念，饼图更不适用）。 */
export function supportsStacking(kind: ChartKind): boolean {
	return kind === "area" || kind === "bar";
}

/** 图形相容性：能被当前数据表达的图形候选（供工具栏切换，饼图需单一非负系列）。 */
export function compatibleChartKinds(spec: ChartSpec): ChartKind[] {
	const kinds: ChartKind[] = ["bar", "line", "area"];
	const singleSeries = spec.series.length === 1;
	const nonNegative =
		singleSeries &&
		spec.rows.every((row) => {
			const value = row[spec.series[0]?.key ?? ""] ?? null;
			return value === null || (typeof value === "number" && value >= 0);
		});
	if (nonNegative) kinds.push("pie");
	return kinds;
}

/** 当前可见系列（保持源顺序，只做隐藏过滤）。 */
export function visibleSeries(spec: ChartSpec, hiddenSeries: readonly string[]): ChartSeries[] {
	const hidden = new Set(hiddenSeries);
	return spec.series.filter((series) => !hidden.has(series.key));
}

/**
 * 系列图例是否渲染：只看**全部系列**与图形，不看当前隐藏了谁。
 * 隐藏到最后一项时图例也必须留着，否则用户只能重置整张图才能把系列点回来。
 */
export function shouldShowSeriesLegend(kind: ChartKind, spec: ChartSpec): boolean {
	return kind !== "pie" && spec.series.length > 0;
}

/** 当前可见行（范围筛选只裁剪视图，不改源数据；越界按下标夹紧）。 */
export function visibleRows(spec: ChartSpec, range: ChartInteractionState["range"]): Array<Record<string, ChartCell>> {
	if (!range || spec.rows.length === 0) return spec.rows;
	const start = Math.max(0, Math.min(range.start, spec.rows.length - 1));
	const end = Math.max(start, Math.min(range.end, spec.rows.length - 1));
	return spec.rows.slice(start, end + 1);
}

/** 视图内是否至少有一个数值（全零饼图或全缺失时只出数据表，不画虚构图形）。 */
export function viewHasNumericValue(rows: Array<Record<string, ChartCell>>, series: readonly ChartSeries[]): boolean {
	return rows.some((row) => series.some((entry) => typeof row[entry.key] === "number"));
}

/**
 * 数值显示：保留原始精度，只按单位加后缀（不做四舍五入改写数值）。
 * 数字用与源值一致的字符串（`String` 不做本地化改写），负号与小数原样保留。
 */
export function formatChartValue(value: ChartCell, unit?: string): string {
	if (value === null || value === undefined) return "—";
	const text = typeof value === "number" ? String(value) : value;
	return unit ? `${text} ${unit}` : text;
}

/** 提示框里的数值：千分位便于阅读，但导出与数据表仍用原始值。 */
export function formatChartValueForTooltip(value: ChartCell, unit?: string): string {
	if (value === null || value === undefined) return "—";
	if (typeof value !== "number") return unit ? `${value} ${unit}` : value;
	const text = Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
	return unit ? `${text} ${unit}` : text;
}

/**
 * 占比（仅用于同图扇区提示）：分母是当前视图合计，非有限值或零合计时不给占比。
 * 这是展示派生，不改源数据，也不做新的业务口径。
 */
export function formatChartShare(value: ChartCell, total: number | undefined): string | undefined {
	if (typeof value !== "number" || typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
	return `${((value / total) * 100).toFixed(1)}%`;
}

/** 表格/导出用的一行：先 x 列，再按系列顺序展开。 */
export function chartRowCells(spec: ChartSpec, row: Record<string, ChartCell>, series: readonly ChartSeries[]): ChartCell[] {
	return [row[spec.x.key] ?? null, ...series.map((entry) => row[entry.key] ?? null)];
}

export function chartTableHeader(spec: ChartSpec, series: readonly ChartSeries[]): string[] {
	return [spec.x.label, ...series.map((entry) => (entry.unit ? `${entry.label} (${entry.unit})` : entry.label))];
}

/**
 * 序列化为分隔文本（数据表复制与 CSV 导出共用）。
 * 含分隔符、引号或换行的单元格按 RFC 4180 加引号转义；数值保留原始精度。
 */
export function toDelimitedText(spec: ChartSpec, rows: Array<Record<string, ChartCell>>, series: readonly ChartSeries[], delimiter: "," | "\t" = ","): string {
	const escape = (cell: ChartCell): string => {
		const text = cell === null || cell === undefined ? "" : String(cell);
		return /["\n\r]|,|\t/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	const lines = [chartTableHeader(spec, series).map(escape).join(delimiter)];
	for (const row of rows) {
		lines.push(chartRowCells(spec, row, series).map(escape).join(delimiter));
	}
	return lines.join("\n");
}

/**
 * 解析后的默认交互状态：图形沿用源图形，布局与堆叠沿用源声明。
 * 参数与默认值合并后，视图与历史恢复都从同一份状态起步。
 */
export function initialChartInteraction(spec: ChartSpec): ChartInteractionState {
	return {
		...DEFAULT_CHART_INTERACTION,
		kind: spec.kind,
		layout: spec.layout ?? "vertical",
		stacked: spec.stacked === true,
	};
}

/** 卡片标题区的身份：修改版显示与原图的关系。 */
export function chartRevisionLabel(artifact: ChartArtifact): { chartId: string; parentChartId?: string } {
	return { chartId: artifact.chartId, ...(artifact.parentChartId ? { parentChartId: artifact.parentChartId } : {}) };
}

/** 图形体与数据表共同的输入：当前可见系列 + 可见行 + 容器配置。 */
export type ChartView = {
	rows: Array<Record<string, ChartCell>>;
	series: ChartSeries[];
	/** ChartContainer 的 config（label + --chart-N 色值），键即系列键。 */
	config: Record<string, { label: string; color: string }>;
	hasValues: boolean;
	compatibleKinds: ChartKind[];
};

/**
 * 从源 spec + 当前交互状态派生视图。隐藏系列后仍保留原始配色下标，
 * 因此隐藏／恢复某个系列不会让其它系列换颜色。
 */
export function deriveChartView(spec: ChartSpec, state: ChartInteractionState): ChartView {
	const hidden = new Set(state.hiddenSeries);
	const series = spec.series.filter((entry) => !hidden.has(entry.key));
	const rows = visibleRows(spec, state.range);
	const config: ChartView["config"] = {};
	spec.series.forEach((entry, index) => {
		config[entry.key] = { label: entry.label, color: seriesColorValue(index) };
	});
	return {
		rows,
		series,
		config,
		hasValues: viewHasNumericValue(rows, series),
		compatibleKinds: compatibleChartKinds(spec),
	};
}
