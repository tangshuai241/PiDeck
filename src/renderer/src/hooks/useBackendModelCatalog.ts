import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModel, ModelListReport } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";

const EMPTY_MODELS: AvailableModel[] = [];

/** Accepted reports retain their source so a new scope cannot reuse their success flag. */
type CatalogResult = {
	projectId?: string;
	report: ModelListReport;
};

/**
 * 模型目录数据源（C19）：走 projects.listModelsReport
 *（诊断报告：优先 pi --list-models，失败回退本地 models.json，并附带失败原因分类）。
 * enabled=false 时不加载（选择器打开才拉取，避免常驻轮询）；
 * 内部带 sequence 防竞态（快速开关选择器时旧响应不覆盖新响应）。
 *
 * reload(force=true) = 手动刷新：绕过全局缓存重新 fork pi --list-models，
 * 「模型列表加载不出来」的用户可立即重试，不必重启应用。
 *
 * loading = 首次加载（非手动刷新）在途：选择器据此显示加载态，避免首屏空白。
 */
export function useBackendModelCatalog(options: { sessionId: string; projectId?: string; enabled: boolean }): {
	models: AvailableModel[];
	/** 最近一次加载的报告（DSH 目录为构造的成功报告）；加载失败时含原因分类。 */
	report: ModelListReport | null;
	/** 首次加载在途（手动刷新走 refreshing，两者互斥展示） */
	loading: boolean;
	/** 手动刷新进行中（选择器刷新按钮转圈用） */
	refreshing: boolean;
	/** 重新加载；传 true 绕过缓存强制重新 fork（手动刷新） */
	reload: (force?: boolean) => void;
} {
	const [catalog, setCatalog] = useState<CatalogResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const sequenceRef = useRef(0);

	const load = useCallback(
		(force = false) => {
			if (!options.enabled) return;
			const sequence = ++sequenceRef.current;
			setRefreshing(force);
			setLoading(!force);
			const loader = desktopApi.projects.listModelsReport(options.projectId, force);
			void loader
				.then((next) => {
					if (sequence !== sequenceRef.current) return;
					setCatalog({ projectId: options.projectId, report: next });
					setLoading(false);
					setRefreshing(false);
				})
				.catch((error) => {
					if (sequence !== sequenceRef.current) return;
					// IPC 异常兜底：列表置空 + 合成失败报告（选择器据此显示失败引导与重试按钮，
					// 而不是把 report 留成 null 导致面板空白），并 toast 提示错误。
					const rawDetail = error instanceof Error ? error.message : String(error);
					setCatalog({
						projectId: options.projectId,
						report: {
							models: [],
							ok: false,
							reason: "cli-failed",
							version: null,
							detail: rawDetail,
							source: "none",
							at: Date.now(),
						},
					});
					setLoading(false);
					setRefreshing(false);
					showNotice(rawDetail, 4000);
				});
		},
		[options.enabled, options.projectId],
	);

	useEffect(() => {
		if (options.enabled) load();
		else {
			setLoading(false);
			setRefreshing(false);
		}
		return () => {
			// Closing, switching source or unmounting must retire even a manual refresh.
			// The IPC may still finish, but its result and error notice no longer belong here.
			sequenceRef.current++;
		};
	}, [load, options.enabled]);

	// Filter during render, not in an effect: consumers use report.ok to invalidate
	// welcome preferences, so even the first render must reject another source's data.
	const report = catalog?.projectId === options.projectId ? (catalog?.report ?? null) : null;
	return { models: report?.models ?? EMPTY_MODELS, report, loading: options.enabled && loading, refreshing: options.enabled && refreshing, reload: load };
}
