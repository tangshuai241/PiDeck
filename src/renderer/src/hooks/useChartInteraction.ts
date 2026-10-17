/**
 * 图表交互状态 hook：把 spec 派生的默认值与用户覆盖合并成视图状态，
 * 并给出卡片/放大对话框共用的动作。多个视图（卡片与对话框）用同一个 key，
 * 因此系列开关、图形切换、范围与缩放状态天然同步。
 */
import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import type { ChartArtifact, ChartInteractionState, ChartKind, ChartLayout } from "../../../shared/types/chart";
import { chartInteractionOverrideAtomFamily } from "../atoms/chart-atoms";
import { chartInteractionKey, initialChartInteraction } from "../components/session/chart/chartView";

export type ChartInteractionApi = {
	state: ChartInteractionState;
	toggleSeries: (key: string) => void;
	setKind: (kind: ChartKind) => void;
	setLayout: (layout: ChartLayout) => void;
	toggleStacked: () => void;
	setRange: (range: ChartInteractionState["range"]) => void;
	openZoom: () => void;
	closeZoom: () => void;
	/** 只清用户改动，回到源图形/源范围（卡片上的「恢复默认视图」）。 */
	resetAll: () => void;
};

export function useChartInteraction(sessionId: string | undefined, artifact: ChartArtifact): ChartInteractionApi {
	const key = chartInteractionKey(sessionId, artifact.chartId);
	const [override, setOverride] = useAtom(chartInteractionOverrideAtomFamily(key));
	const base = useMemo(() => initialChartInteraction(artifact.spec), [artifact.spec]);
	const state = useMemo(() => ({ ...base, ...override }), [base, override]);

	const patch = useCallback(
		(next: Partial<ChartInteractionState>) => {
			setOverride((prev) => ({ ...prev, ...next }));
		},
		[setOverride],
	);

	const toggleSeries = useCallback(
		(seriesKey: string) => {
			setOverride((prev) => {
				const current = new Set(prev?.hiddenSeries ?? base.hiddenSeries);
				if (current.has(seriesKey)) current.delete(seriesKey);
				else current.add(seriesKey);
				return { ...prev, hiddenSeries: [...current] };
			});
		},
		[setOverride, base.hiddenSeries],
	);

	return {
		state,
		toggleSeries,
		setKind: useCallback(
			(kind: ChartKind) =>
				// 切到饼图时清掉系列隐藏：饼图只有单一系列，“隐藏”没有意义，留着会让饼面全空。
				patch(kind === "pie" ? { kind, hiddenSeries: [] } : { kind }),
			[patch],
		),
		setLayout: useCallback((layout: ChartLayout) => patch({ layout }), [patch]),
		toggleStacked: useCallback(() => patch({ stacked: !state.stacked }), [patch, state.stacked]),
		setRange: useCallback((range: ChartInteractionState["range"]) => patch({ range }), [patch]),
		openZoom: useCallback(() => patch({ zoomed: true }), [patch]),
		closeZoom: useCallback(() => patch({ zoomed: false }), [patch]),
		resetAll: useCallback(() => setOverride(null), [setOverride]),
	};
}
