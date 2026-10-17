/**
 * 图例：每个系列一个可聚焦按钮，点击切换显隐（不触发模型请求，也不改源数据）。
 * 隐藏的系列保留在原位置并加删除线，恢复时颜色不变（配色按源系列下标固定）。
 */
import { cn } from "../../../lib/utils";
import type { ChartCell, ChartSeries } from "../../../../../shared/types/chart";
import { formatChartValue, seriesColorValue } from "./chartView";

export function ChartLegend(props: {
	series: readonly ChartSeries[];
	hidden: readonly string[];
	onToggle: (key: string) => void;
	/** 是否显示系列当前可见值的合计（单系列时意义不大，默认关闭）。 */
	showTotals?: boolean;
	totals?: Record<string, ChartCell>;
}) {
	const hidden = new Set(props.hidden);
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
			{props.series.map((entry, index) => {
				const isHidden = hidden.has(entry.key);
				return (
					<button
						key={entry.key}
						type="button"
						aria-pressed={!isHidden}
						onClick={() => props.onToggle(entry.key)}
						className={cn("inline-flex max-w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-chat-detail transition-colors hover:bg-bg-hover", isHidden ? "text-text-faint" : "text-text-secondary")}
						title={isHidden ? entry.label : entry.label}
					>
						<span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColorValue(index) }} aria-hidden="true" />
						<span className={cn("truncate", isHidden && "line-through")}>{entry.label}</span>
						{props.showTotals && props.totals?.[entry.key] !== undefined ? <span className="shrink-0 font-mono tabular-nums">{formatChartValue(props.totals[entry.key], entry.unit)}</span> : null}
					</button>
				);
			})}
		</div>
	);
}
