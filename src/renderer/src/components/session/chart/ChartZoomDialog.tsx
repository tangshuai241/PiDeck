/**
 * 放大查看：复用现有 Dialog 原语与同一份图表数据（不重新计算、不另存状态）。
 * 关闭后系列选择、图形与范围都保留在图表域 atom 里，回到卡片原位。
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import type { ChartArtifact, ChartKind, ChartLayout } from "../../../../../shared/types/chart";
import { t } from "../../../i18n";
import { ChartBody } from "./ChartBody";
import { ChartLegend } from "./ChartLegend";
import type { ChartView } from "./chartView";

export function ChartZoomDialog(props: { artifact: ChartArtifact; view: ChartView; kind: ChartKind; layout: ChartLayout; stacked: boolean; open: boolean; onOpenChange: (open: boolean) => void; hiddenSeries: readonly string[]; onToggleSeries: (key: string) => void }) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-[min(1100px,92vw)]">
				<DialogHeader>
					<DialogTitle className="truncate text-body">{props.artifact.spec.title}</DialogTitle>
				</DialogHeader>
				<div className="flex min-w-0 flex-col gap-2">
					<ChartBody spec={props.artifact.spec} view={props.view} kind={props.kind} layout={props.layout} stacked={props.stacked} className="h-[min(62vh,520px)] w-full" />
					{props.kind !== "pie" ? <ChartLegend series={props.artifact.spec.series} hidden={props.hiddenSeries} onToggle={props.onToggleSeries} /> : null}
					<p className="text-chat-detail text-text-faint">{t("chart.zoomHint")}</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}
