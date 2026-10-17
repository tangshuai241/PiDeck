/**
 * 图形体：按当前图形画出图表（柱状/分组柱状、折线、面积/堆叠面积、饼图）。
 *
 * 组合来自 Claude Quickstarts 的 `ChartRenderer.tsx`（MIT，见
 * `docs/third-party/claude-quickstarts-chart.md`），按 TPA 要求改写：
 * - 折线/面积用线性连接（来源的 `type="natural"` 会造出源数据没有的形状）；
 * - 配色走本仓库 `--chart-N` token，不照搬 `--chart-N` 语义；
 * - 类别标签只在很长时截断，完整名称由提示框与数据表给出；
 * - 动画跟随系统「减少动态效果」设置，历史图不反复播放入场动画。
 */
import { useReducedMotion } from "motion/react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import type { ChartKind, ChartLayout, ChartSpec } from "../../../../../shared/types/chart";
import { t } from "../../../i18n";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../ui-shadcn/chart";
import { formatChartShare, formatChartValueForTooltip, seriesColorValue, type ChartView } from "./chartView";

export type ChartBodyProps = {
	spec: ChartSpec;
	view: ChartView;
	kind: ChartKind;
	layout: ChartLayout;
	stacked: boolean;
	/** 卡片用固定高度，放大视图用更大高度。 */
	className?: string;
};

/** 类别标签过长才截断；完整名称由提示框与数据表承担。 */
const AXIS_TICK_MAX_CHARS = 24;

function truncateTick(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.length > AXIS_TICK_MAX_CHARS ? `${text.slice(0, AXIS_TICK_MAX_CHARS - 1)}…` : text;
}

type TooltipEntry = { dataKey?: string | number; name?: string | number; value?: unknown; payload?: unknown };

/** 饼图扇区的类别名：Recharts 在 label / entry.name / entry.payload.name 三处都可能给出。 */
function readPieCategory(entry: TooltipEntry | undefined, label: unknown): string {
	const payloadName = (entry?.payload as { name?: unknown } | undefined)?.name;
	for (const candidate of [label, entry?.name, payloadName]) {
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return "";
}

/**
 * 提示框：柱/线/面按系列逐行；饼图按扇区显示类别、系列名、数值（带单位）与占比。
 * 饼图的数据键是 `value/name`，不能拿它去匹配 `spec.series[].key`，
 * 否则提示框只剩「value：100」，既丢类别也丢单位。
 */
function ChartTooltipBody(props: { spec: ChartSpec; variant: "series" | "pie"; total?: number; active?: boolean; label?: unknown; payload?: TooltipEntry[] }) {
	const entries = props.payload ?? [];
	if (!props.active || entries.length === 0) return null;

	if (props.variant === "pie") {
		const series = props.spec.series[0];
		const entry = entries[0];
		const value = (entry?.value ?? null) as number | string | null;
		const share = formatChartShare(value, props.total);
		return (
			<div className="grid gap-1.5">
				<div className="font-medium">{truncateTick(readPieCategory(entry, props.label))}</div>
				<div className="flex items-center justify-between gap-3">
					<span className="text-muted-foreground">{series?.label ?? ""}</span>
					<span className="font-mono tabular-nums">{formatChartValueForTooltip(value, series?.unit)}</span>
				</div>
				{share ? (
					<div className="flex items-center justify-between gap-3 text-muted-foreground">
						<span>{t("chart.share")}</span>
						<span className="font-mono tabular-nums">{share}</span>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="grid gap-1.5">
			<div className="font-medium">{truncateTick(props.label)}</div>
			{entries.map((entry) => {
				const key = String(entry.dataKey ?? "");
				const series = props.spec.series.find((item) => item.key === key);
				return (
					<div key={key} className="flex items-center justify-between gap-3">
						<span className="text-muted-foreground">{series?.label ?? key}</span>
						<span className="font-mono tabular-nums">{formatChartValueForTooltip((entry.value ?? null) as number | string | null, series?.unit)}</span>
					</div>
				);
			})}
		</div>
	);
}

export function ChartBody(props: ChartBodyProps) {
	const reduceMotion = useReducedMotion() ?? false;
	const animate = !reduceMotion;
	const { spec, view, kind, layout, stacked } = props;
	const className = props.className ?? "h-[240px] w-full";
	const xKey = spec.x.key;

	if (kind === "pie") {
		const series = view.series[0];
		if (!series) return null;
		const data = view.rows.map((row) => ({ name: row[xKey], value: row[series.key] ?? 0 }));
		// 占比提示的分母就是当前视图的合计（同图各扇区的份额，不另算业务口径）。
		const total = data.reduce((sum, entry) => sum + (typeof entry.value === "number" ? entry.value : 0), 0);
		return (
			<ChartContainer config={view.config} className={className}>
				<PieChart>
					<ChartTooltip content={<ChartTooltipBody spec={spec} variant="pie" total={total} />} />
					{/* 半径百分比按 Recharts 的 getMaxRadius（较短边一半）解析，不按对角线，因此不会越出容器 */}
					<Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" strokeWidth={2} isAnimationActive={animate}>
						{data.map((_entry, index) => (
							<Cell key={`slice-${index}`} fill={seriesColorValue(index)} />
						))}
					</Pie>
				</PieChart>
			</ChartContainer>
		);
	}

	const horizontal = layout === "horizontal" && kind === "bar";

	if (kind === "line") {
		return (
			<ChartContainer config={view.config} className={className}>
				<LineChart accessibilityLayer data={view.rows} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={truncateTick} />
					<YAxis width={44} tickLine={false} axisLine={false} tickFormatter={truncateTick} />
					<ChartTooltip cursor={false} content={<ChartTooltipBody spec={spec} variant="series" />} />
					{view.series.map((entry) => (
						<Line
							key={entry.key}
							type="linear"
							dataKey={entry.key}
							stroke={`var(--color-${entry.key})`}
							strokeWidth={2}
							dot={false}
							// 缺失值断线，不把缺口连成一条平滑趋势（方案 4.4 / 5.3）。
							connectNulls={false}
							isAnimationActive={animate}
						/>
					))}
				</LineChart>
			</ChartContainer>
		);
	}

	if (kind === "area") {
		return (
			<ChartContainer config={view.config} className={className}>
				<AreaChart accessibilityLayer data={view.rows} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={truncateTick} />
					<YAxis width={44} tickLine={false} axisLine={false} tickFormatter={truncateTick} />
					<ChartTooltip cursor={false} content={<ChartTooltipBody spec={spec} variant="series" />} />
					{view.series.map((entry) => (
						<Area key={entry.key} type="linear" dataKey={entry.key} fill={`var(--color-${entry.key})`} fillOpacity={0.4} stroke={`var(--color-${entry.key})`} connectNulls={false} stackId={stacked ? "stack" : undefined} isAnimationActive={animate} />
					))}
				</AreaChart>
			</ChartContainer>
		);
	}

	return (
		<ChartContainer config={view.config} className={className}>
			<BarChart accessibilityLayer data={view.rows} layout={horizontal ? "vertical" : "horizontal"} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
				<CartesianGrid vertical={horizontal} horizontal={!horizontal} />
				{horizontal ? (
					<>
						<XAxis type="number" tickLine={false} axisLine={false} tickFormatter={truncateTick} />
						<YAxis type="category" dataKey={xKey} width={110} tickLine={false} axisLine={false} tickFormatter={truncateTick} />
					</>
				) : (
					<>
						<XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} tickFormatter={truncateTick} />
						<YAxis width={44} tickLine={false} axisLine={false} tickFormatter={truncateTick} />
					</>
				)}
				<ChartTooltip cursor={false} content={<ChartTooltipBody spec={spec} variant="series" />} />
				{view.series.map((entry) => (
					<Bar key={entry.key} dataKey={entry.key} fill={`var(--color-${entry.key})`} radius={4} stackId={stacked ? "stack" : undefined} isAnimationActive={animate} />
				))}
			</BarChart>
		</ChartContainer>
	);
}
