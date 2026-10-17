/**
 * 数据表：图形之外的读取方式（键盘可达、可选中复制）。
 * 展示的是当前视图（可见范围与可见系列），不是被改写过的数据。
 */
import { t } from "../../../i18n";
import type { ChartSpec } from "../../../../../shared/types/chart";
import { chartRowCells, chartTableHeader, formatChartValue, type ChartView } from "./chartView";

export function ChartDataTable(props: { spec: ChartSpec; view: ChartView; className?: string }) {
	const header = chartTableHeader(props.spec, props.view.series);
	return (
		<div className={props.className}>
			<div className="max-h-[240px] overflow-auto rounded-[var(--radius-md)] border border-border-subtle">
				<table className="w-full border-collapse text-chat-detail">
					<caption className="sr-only">{t("chart.dataTableCaption", { title: props.spec.title })}</caption>
					<thead className="sticky top-0 bg-[var(--color-chat-table-bg)]">
						<tr>
							{header.map((label, index) => (
								<th key={`${label}-${index}`} scope="col" className="whitespace-nowrap border-b border-border-subtle px-2 py-1.5 text-left font-medium text-text-secondary">
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{props.view.rows.map((row, rowIndex) => (
							<tr key={rowIndex} className="odd:bg-[var(--color-chat-table-bg)]/40">
								{chartRowCells(props.spec, row, props.view.series).map((cell, cellIndex) => (
									<td key={cellIndex} className={cellIndex === 0 ? "whitespace-nowrap px-2 py-1.5 text-text-primary" : "whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-text-primary"}>
										{formatChartValue(cell, cellIndex === 0 ? undefined : props.view.series[cellIndex - 1]?.unit)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
