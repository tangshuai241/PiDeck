/**
 * 图表成果卡片：对话时间线里的常显图表（原回合位置，工具过程折叠后仍可见）。
 *
 * 数据来自 `ChatMessage.chart`（Pi 原生 toolResult 的 `details.tpaChart` 解码结果），
 * 组件只派生视图：悬停看数值、点图例隐藏系列、切图形/堆叠、看数据表、复制当前视图、
 * 放大查看。任何交互都不改源数据，也不触发模型请求；改图由用户在对话里提出，
 * 由 Pi 生成带 `parentChartId` 的新结果（旧图保留）。
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { AreaChart as AreaIcon, BarChart3, Check, Copy, Database, Download, FileSpreadsheet, LineChart as LineIcon, Maximize2, PieChart as PieIcon, RotateCcw } from "lucide-react";
import { toBlob } from "html-to-image";
import type { ChartArtifact, ChartKind } from "../../../../../shared/types/chart";
import { t, type TranslationKey } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { cn } from "../../../lib/utils";
import { writeClipboard } from "../../../utils/clipboard";
import { showNotice } from "../../../utils/notice";
import { useChartInteraction } from "../../../hooks/useChartInteraction";
import { Input } from "../../ui-shadcn/input";
import { ChartBody } from "./ChartBody";
import { ChartDataTable } from "./ChartDataTable";
import { ChartLegend } from "./ChartLegend";
import { ChartZoomDialog } from "./ChartZoomDialog";
import { deriveChartView, formatChartValue, seriesColorValue, shouldShowSeriesLegend, supportsStacking, toDelimitedText } from "./chartView";

const KIND_ICONS: Record<ChartKind, typeof BarChart3> = {
	bar: BarChart3,
	line: LineIcon,
	area: AreaIcon,
	pie: PieIcon,
};

const KIND_LABEL_KEYS: Record<ChartKind, TranslationKey> = {
	bar: "chart.kindBar",
	line: "chart.kindLine",
	area: "chart.kindArea",
	pie: "chart.kindPie",
};

/** 饼图全部为零（或全缺失）时不画扇区：给数据表与一句解释，不虚构形状。 */
function isAllZeroPie(kind: ChartKind, rows: Array<Record<string, unknown>>, seriesKey: string | undefined): boolean {
	if (kind !== "pie" || !seriesKey) return false;
	return rows.every((row) => {
		const value = row[seriesKey];
		return value === null || value === undefined || value === 0;
	});
}

export const ChartArtifactCard = memo(function ChartArtifactCard(props: { artifact: ChartArtifact; sessionId?: string }) {
	const { spec, chartId, parentChartId } = props.artifact;
	const { state, toggleSeries, setKind, toggleStacked, setRange, openZoom, closeZoom, resetAll } = useChartInteraction(props.sessionId, props.artifact);
	const view = useMemo(() => deriveChartView(spec, state), [spec, state]);
	const [showTable, setShowTable] = useState(false);
	const [copied, setCopied] = useState(false);
	const [exporting, setExporting] = useState(false);
	const figureRef = useRef<HTMLElement | null>(null);

	const copyCurrentView = useCallback(async () => {
		const text = toDelimitedText(spec, view.rows, view.series, "\t");
		const ok = await writeClipboard(text);
		if (!ok) return;
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	}, [spec, view.rows, view.series]);

	// 范围筛选：只在源数据多于两行时出现（两三行的图不需要筛选控件）。
	// 展示给用户的是 1 基下标，内部状态是 0 基闭区间；越界在这里夹紧，不交给 Recharts 猜。
	const totalRows = spec.rows.length;
	const showRange = totalRows > 2;
	const rangeStart = state.range ? Math.min(state.range.start, totalRows - 1) + 1 : 1;
	const rangeEnd = state.range ? Math.min(state.range.end, totalRows - 1) + 1 : totalRows;
	const applyRange = useCallback(
		(nextStart: number, nextEnd: number) => {
			const start = Math.max(1, Math.min(nextStart, totalRows));
			const end = Math.max(start, Math.min(nextEnd, totalRows));
			setRange(start - 1 === 0 && end === totalRows ? null : { start: start - 1, end: end - 1 });
		},
		[setRange, totalRows],
	);
	const rangeFiltered = state.range !== null;

	const allZeroPie = isAllZeroPie(state.kind, view.rows, view.series[0]?.key);
	// 图例按**全部系列**渲染（不是可见系列）：隐藏到最后一项时图例也必须留着，
	// 否则用户只能重置整张图才能把系列点回来。规则见 shouldShowSeriesLegend。
	const showLegend = shouldShowSeriesLegend(state.kind, spec);
	const sources = spec.sources ?? [];

	/** 导出 CSV：与数据表、复制共用同一份序列化（当前可见系列与范围）。 */
	const saveCsv = useCallback(async () => {
		setExporting(true);
		try {
			const result = await window.piDesktop.chart.exportFile({ format: "csv", suggestedName: spec.title, text: toDelimitedText(spec, view.rows, view.series, ",") });
			if (result.ok) showNotice(t("chart.exported"), 1600);
			else if (!result.canceled) showNotice(t("chart.exportFailed"), 2200, "error");
		} finally {
			setExporting(false);
		}
	}, [spec, view.rows, view.series]);

	/**
	 * 导出 PNG：克隆卡片本体 → html-to-image 浏览器原生栅格化 → 主进程保存。
	 * 克隆保持在原元素旁（复用 .multi-select-image-export 隐藏方式）以保证 CSS 变量可解析；
	 * 工具栏节点带 data-chart-export-skip，不进图片。
	 */
	const saveImage = useCallback(async () => {
		const element = figureRef.current;
		if (!element) return;
		setExporting(true);
		const clone = element.cloneNode(true) as HTMLElement;
		clone.style.padding = "16px";
		clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-chat-card-bg") || "#fff";
		clone.classList.add("multi-select-image-export");
		let dataUrl: string | undefined;
		try {
			if (element.parentElement) {
				clone.style.width = `${element.getBoundingClientRect().width}px`;
				element.parentElement.insertBefore(clone, element.nextSibling);
			}
			const blob = await toBlob(clone, {
				cacheBust: true,
				pixelRatio: 2,
				backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-chat-card-bg") || undefined,
				filter: (node) => !(node instanceof HTMLElement) || !node.hasAttribute("data-chart-export-skip"),
			});
			if (blob) {
				dataUrl = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result));
					reader.onerror = () => reject(new Error("read chart blob failed"));
					reader.readAsDataURL(blob);
				});
			}
		} catch {
			dataUrl = undefined;
		} finally {
			clone.remove();
			setExporting(false);
		}
		if (!dataUrl) {
			showNotice(t("chart.exportFailed"), 2200, "error");
			return;
		}
		const result = await window.piDesktop.chart.exportFile({ format: "png", suggestedName: spec.title, dataUrl });
		if (result.ok) showNotice(t("chart.exported"), 1600);
		else if (!result.canceled) showNotice(t("chart.exportFailed"), 2200, "error");
	}, [spec.title]);

	return (
		<figure ref={figureRef} className="chart-artifact-card my-3 w-full min-w-0 rounded-[var(--radius-lg)] border border-border-subtle bg-[var(--color-chat-card-bg)] p-3" data-chart-id={chartId}>
			<figcaption className="flex min-w-0 flex-col gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<h4 className="min-w-0 truncate text-body font-medium text-text-primary">{spec.title}</h4>
					{parentChartId ? (
						<span className="shrink-0 rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-chat-detail text-text-tertiary" title={parentChartId}>
							{t("chart.revision")}
						</span>
					) : null}
				</div>
				{spec.description ? <p className="text-chat-detail text-text-secondary">{spec.description}</p> : null}
			</figcaption>

			{allZeroPie ? (
				<p className="mt-2 rounded-[var(--radius-md)] border border-border-subtle bg-bg-muted/60 px-2 py-3 text-chat-detail text-text-secondary">{t("chart.allZeroPie")}</p>
			) : (
				<div className="mt-2">
					<ChartBody spec={spec} view={view} kind={state.kind} layout={state.layout} stacked={state.stacked} />
				</div>
			)}

			{showLegend ? (
				<div className="mt-2">
					<ChartLegend series={spec.series} hidden={state.hiddenSeries} onToggle={toggleSeries} />
				</div>
			) : null}

			{state.kind === "pie" ? (
				<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
					{view.rows.map((row, index) => (
						<span key={index} className="inline-flex items-center gap-1.5 text-chat-detail text-text-secondary">
							<span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColorValue(index) }} aria-hidden="true" />
							<span className="truncate">{String(row[spec.x.key] ?? "")}</span>
							<span className="font-mono tabular-nums">{formatChartValue(row[view.series[0]?.key ?? ""] ?? null, view.series[0]?.unit)}</span>
						</span>
					))}
				</div>
			) : null}

			{showTable ? (
				<div className="mt-2">
					<ChartDataTable spec={spec} view={view} />
				</div>
			) : null}

			<div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border-subtle pt-2" data-chart-export-skip="true">
				<div className="flex flex-wrap items-center gap-1">
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-secondary" onClick={() => setShowTable((prev) => !prev)} aria-expanded={showTable}>
						<Database size={13} aria-hidden="true" />
						{showTable ? t("chart.hideData") : t("chart.viewData")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-secondary" onClick={openZoom}>
						<Maximize2 size={13} aria-hidden="true" />
						{t("chart.zoom")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-secondary" onClick={() => void copyCurrentView()}>
						{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
						{copied ? t("common.copied") : t("chart.copyData")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-secondary" disabled={exporting} onClick={() => void saveImage()}>
						<Download size={13} aria-hidden="true" />
						{t("chart.saveImage")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-secondary" disabled={exporting} onClick={() => void saveCsv()}>
						<FileSpreadsheet size={13} aria-hidden="true" />
						{t("chart.saveCsv")}
					</Button>
				</div>

				<div className="flex flex-wrap items-center gap-1">
					{showRange ? (
						<div className="flex items-center gap-1 text-chat-detail text-text-tertiary">
							<span>{t("chart.range")}</span>
							<Input type="number" min={1} max={totalRows} value={rangeStart} aria-label={t("chart.rangeStart")} onChange={(event) => applyRange(Number(event.target.value), rangeEnd)} className="h-6 w-14 px-1 text-chat-detail" />
							<span aria-hidden="true">–</span>
							<Input type="number" min={1} max={totalRows} value={rangeEnd} aria-label={t("chart.rangeEnd")} onChange={(event) => applyRange(rangeStart, Number(event.target.value))} className="h-6 w-14 px-1 text-chat-detail" />
							<span className="tabular-nums">/ {totalRows}</span>
							{rangeFiltered ? (
								<button type="button" className="rounded-[var(--radius-sm)] px-1 text-chat-detail text-text-secondary transition-colors hover:bg-bg-hover" onClick={() => setRange(null)}>
									{t("chart.rangeClear")}
								</button>
							) : null}
						</div>
					) : null}
					{view.compatibleKinds.length > 1 ? (
						<div className="flex items-center gap-0.5 rounded-[var(--radius-md)] border border-border-subtle p-0.5" role="group" aria-label={t("chart.kindGroup")}>
							{view.compatibleKinds.map((kind) => {
								const Icon = KIND_ICONS[kind] ?? BarChart3;
								return (
									<button
										key={kind}
										type="button"
										aria-pressed={state.kind === kind}
										title={t(KIND_LABEL_KEYS[kind])}
										onClick={() => setKind(kind)}
										className={cn("inline-flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-bg-hover", state.kind === kind && "bg-bg-active text-text-primary")}
									>
										<Icon size={13} aria-hidden="true" />
									</button>
								);
							})}
						</div>
					) : null}
					{supportsStacking(state.kind) && view.series.length > 1 ? (
						<button type="button" aria-pressed={state.stacked} onClick={toggleStacked} className={cn("h-6 rounded-[var(--radius-md)] border border-border-subtle px-2 text-chat-detail text-text-secondary transition-colors hover:bg-bg-hover", state.stacked && "bg-bg-active text-text-primary")}>
							{t("chart.stacked")}
						</button>
					) : null}
					<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-chat-detail text-text-tertiary" onClick={resetAll} title={t("chart.resetView")}>
						<RotateCcw size={13} aria-hidden="true" />
					</Button>
				</div>
			</div>

			{sources.length > 0 ? <p className="mt-1.5 text-chat-detail text-text-faint">{t("chart.sources", { list: sources.map((source) => (source.locator ? `${source.label} (${source.locator})` : source.label)).join(" · ") })}</p> : null}

			<ChartZoomDialog artifact={props.artifact} view={view} kind={state.kind} layout={state.layout} stacked={state.stacked} open={state.zoomed} onOpenChange={(open) => (open ? openZoom() : closeZoom())} hiddenSeries={state.hiddenSeries} onToggleSeries={toggleSeries} />
		</figure>
	);
});
