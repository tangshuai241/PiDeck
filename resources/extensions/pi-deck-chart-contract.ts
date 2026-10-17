/**
 * render_chart 图表契约（扩展侧镜像，纯函数、零依赖）。
 *
 * 为什么单独一个文件：扩展跑在 pi 进程里，不能 import 仓库 TS（打包后 src/ 不在
 * 扩展的相对路径上），因此宿主的 `src/shared/types/chart.ts` +
 * `src/shared/chartDecode.ts` 在这里有一份镜像。两侧的字段名、枚举与上限必须一致，
 * 由 `tests/chartContractParity.test.mjs` 与 `tests/chartExtension.test.mjs` 兜底。
 *
 * 本模块不做模型调用、不碰文件系统，只把模型参数规范化成可持久化、可解码的
 * `ChartSpec`，并给出一句话结果摘要。
 */

export const CHART_SCHEMA_VERSION = 1;
export const CHART_TOOL_NAME = "render_chart";
export const TPA_CHART_DETAILS_KEY = "tpaChart";

export const CHART_MAX_ROWS = 2000;
export const CHART_MAX_SERIES = 8;
export const CHART_MAX_PAYLOAD_BYTES = 256 * 1024;

export const CHART_KINDS = ["bar", "line", "pie", "area"] as const;
export const CHART_AXIS_KINDS = ["category", "date", "number"] as const;

export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartAxisKind = (typeof CHART_AXIS_KINDS)[number];
export type ChartCell = string | number | null;
export type ChartLayout = "vertical" | "horizontal";

export type ChartAxis = { key: string; label: string; kind: ChartAxisKind };
export type ChartSeries = { key: string; label: string; unit?: string };
export type ChartSource = { label: string; locator?: string };

export type ChartSpec = {
	schemaVersion: number;
	title: string;
	description?: string;
	kind: ChartKind;
	layout?: ChartLayout;
	stacked?: boolean;
	x: ChartAxis;
	series: ChartSeries[];
	rows: Array<Record<string, ChartCell>>;
	sources?: ChartSource[];
};

export type ChartNormalizeResult = { ok: true; spec: ChartSpec } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/** UTF-8 字节数（不依赖 Buffer/TextEncoder，便于在任意沙箱里加载）。 */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// 代理对：一个字符串单元对占 4 字节，跳过低位代理。
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/** 图表身份来自真实 toolCallId，模型不能自行编造已有结果的身份。 */
export function chartIdForToolCall(toolCallId: string): string {
	return `chart-${toolCallId}`;
}

function normalizeAxis(input: unknown): ChartAxis | undefined {
	if (!isRecord(input)) return undefined;
	const key = nonEmptyString(input.key);
	if (!key) return undefined;
	const kind = typeof input.kind === "string" && (CHART_AXIS_KINDS as readonly string[]).includes(input.kind) ? (input.kind as ChartAxisKind) : "category";
	return { key, label: nonEmptyString(input.label) ?? key, kind };
}

function normalizeSeries(input: unknown): ChartSeries | undefined {
	if (!isRecord(input)) return undefined;
	const key = nonEmptyString(input.key);
	if (!key) return undefined;
	const unit = nonEmptyString(input.unit);
	return { key, label: nonEmptyString(input.label) ?? key, ...(unit ? { unit } : {}) };
}

function normalizeSources(input: unknown): ChartSource[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const sources: ChartSource[] = [];
	for (const entry of input) {
		if (!isRecord(entry)) continue;
		const label = nonEmptyString(entry.label);
		if (!label) continue;
		const locator = nonEmptyString(entry.locator);
		sources.push({ label, ...(locator ? { locator } : {}) });
	}
	return sources.length > 0 ? sources : undefined;
}

/**
 * 把模型参数规范化为 `ChartSpec`。
 *
 * 规则（方案 5.3）：
 * - 只保留声明的 x 键与系列键，多余字段丢弃（图表只画声明的系列）；
 * - 系列值只接受有限数值或 null；缺省视为显式缺失，不补零；
 * - 行数/系列数/序列化载荷超预算时拒绝，并要求先聚合，不静默截断；
 * - 饼图只接受单一非负系列。
 */
export function normalizeChartSpec(input: unknown): ChartNormalizeResult {
	if (!isRecord(input)) return { ok: false, error: "Chart parameters must be an object." };

	const title = nonEmptyString(input.title);
	if (!title) return { ok: false, error: "A non-empty title is required." };

	const kind = input.kind;
	if (typeof kind !== "string" || !(CHART_KINDS as readonly string[]).includes(kind)) {
		return { ok: false, error: `kind must be one of: ${CHART_KINDS.join(", ")}.` };
	}

	const x = normalizeAxis(input.x);
	if (!x) return { ok: false, error: "x must be an object with a non-empty key." };

	const seriesInput = input.series;
	if (!Array.isArray(seriesInput) || seriesInput.length === 0) return { ok: false, error: "series must contain at least one series." };
	if (seriesInput.length > CHART_MAX_SERIES) return { ok: false, error: `Too many series (${seriesInput.length}); at most ${CHART_MAX_SERIES} are supported.` };
	const series: ChartSeries[] = [];
	for (const entry of seriesInput) {
		const decoded = normalizeSeries(entry);
		if (!decoded) return { ok: false, error: "Every series needs a non-empty key." };
		if (series.some((existing) => existing.key === decoded.key)) return { ok: false, error: `Duplicate series key "${decoded.key}".` };
		series.push(decoded);
	}

	const rowsInput = input.rows;
	if (!Array.isArray(rowsInput)) return { ok: false, error: "rows must be an array of objects." };
	if (rowsInput.length > CHART_MAX_ROWS) return { ok: false, error: `Too many rows (${rowsInput.length}); aggregate the data to at most ${CHART_MAX_ROWS} rows before charting.` };

	const rows: Array<Record<string, ChartCell>> = [];
	for (let index = 0; index < rowsInput.length; index += 1) {
		const entry = rowsInput[index];
		if (!isRecord(entry)) return { ok: false, error: `rows[${index}] must be an object.` };
		const axisValue = entry[x.key];
		if (axisValue === undefined || axisValue === null) return { ok: false, error: `rows[${index}] is missing the x key "${x.key}".` };
		if (typeof axisValue !== "string" && !(typeof axisValue === "number" && Number.isFinite(axisValue))) {
			return { ok: false, error: `rows[${index}]["${x.key}"] must be a string or a finite number.` };
		}
		const row: Record<string, ChartCell> = { [x.key]: axisValue };
		for (const entrySeries of series) {
			const raw = entry[entrySeries.key];
			if (raw === undefined || raw === null) {
				row[entrySeries.key] = null;
				continue;
			}
			if (typeof raw !== "number" || !Number.isFinite(raw)) {
				return { ok: false, error: `rows[${index}]["${entrySeries.key}"] must be a finite number or null.` };
			}
			row[entrySeries.key] = raw;
		}
		rows.push(row);
	}

	if (kind === "pie") {
		if (series.length !== 1) return { ok: false, error: "A pie chart takes exactly one series." };
		const key = series[0].key;
		const negativeIndex = rows.findIndex((row) => typeof row[key] === "number" && (row[key] as number) < 0);
		if (negativeIndex >= 0) return { ok: false, error: `A pie chart cannot use negative values (rows[${negativeIndex}]); use a bar or line chart instead.` };
	} else if (!rows.some((row) => series.some((entry) => typeof row[entry.key] === "number"))) {
		return { ok: false, error: "No numeric values to chart; every series value is missing." };
	}

	const layout = input.layout === "horizontal" ? "horizontal" : "vertical";
	const stacked = input.stacked === true;
	const description = nonEmptyString(input.description);
	const sources = normalizeSources(input.sources);
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

	const payloadBytes = utf8ByteLength(JSON.stringify(spec));
	if (payloadBytes > CHART_MAX_PAYLOAD_BYTES) {
		return { ok: false, error: `Chart payload is ${payloadBytes} bytes, over the ${CHART_MAX_PAYLOAD_BYTES} byte budget; aggregate or trim the data before charting.` };
	}

	return { ok: true, spec };
}

/**
 * 工具结果里模型可见的摘要：身份 + 标题 + 图形 + 系列 + 行数。
 * 完整绘图数据放在 `details.tpaChart`，不进模型上下文。
 */
export function chartToolSummary(spec: ChartSpec, chartId: string): string {
	const seriesText = spec.series.map((entry) => (entry.unit ? `${entry.label} (${entry.unit})` : entry.label)).join(", ");
	const axisText = `${spec.x.label}${spec.x.kind === "category" ? "" : ` (${spec.x.kind})`}`;
	return [`Chart ready: ${spec.title}`, `chartId: ${chartId}`, `kind: ${spec.kind}${spec.stacked ? " (stacked)" : ""}`, `x: ${axisText}`, `series: ${seriesText}`, `rows: ${spec.rows.length}`].join("\n");
}
