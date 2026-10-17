/**
 * 图表导出 IPC（渲染层 → 主进程）：
 *
 * 为什么需要新通道：仓库现有的保存类 IPC 都是各自领域的（草稿导出、日志打包、主题保存），
 * 没有「渲染层给内容、用户选路径、主进程落盘」的通用能力；图表导出要写 CSV 与 PNG，
 * 用 webview 的下载路径在本应用里没有处理器，因此按域新增一条通道。
 *
 * 边界（渲染层数据不可信）：
 * - 格式只认 csv / png；
 * - 文件名由主进程清洗（去目录、去非法字符、限长），不接受渲染层给路径；
 * - CSV 文本与 PNG 字节都有上限，超限直接拒绝，不写盘；
 * - 写目标由系统保存对话框选定（用户主动选择），不接受调用方指定路径。
 */
import { ipcMain, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { ipcChannels } from "../../shared/ipc";
import { CHART_EXPORT_MAX_IMAGE_BYTES, CHART_EXPORT_MAX_TEXT_BYTES, type ChartExportRequest, type ChartExportResult } from "../../shared/types/chart";
import type { AppLogger } from "../logging/AppLogger";

export type ChartIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
};

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** 文件名清洗：只保留基本名、去掉路径分隔与控制字符、限长，兜底给默认名。 */
export function sanitizeChartExportName(name: unknown, format: string): string {
	const raw = typeof name === "string" ? name : "";
	// 同时去掉 Windows 与 POSIX 路径分隔符：不同平台打包时行为一致。
	const base = raw.split(/[/\\]/).pop() ?? "";
	const cleaned = base
		.replace(/[\u0000-\u001f<>:"|?*]/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	const fallback = format === "png" ? "chart.png" : "chart.csv";
	if (!cleaned) return fallback;
	const trimmed = cleaned.slice(0, 120);
	return trimmed.toLowerCase().endsWith(`.${format}`) ? trimmed : `${trimmed}.${format}`;
}

export function registerChartIpc({ appLogger }: ChartIpcDeps): void {
	ipcMain.handle(ipcChannels.chartExport, async (_event, request: ChartExportRequest): Promise<ChartExportResult> => {
		if (!request || typeof request !== "object") return { ok: false, error: "invalid_request" };
		const format = request.format;
		if (format !== "csv" && format !== "png") return { ok: false, error: "invalid_format" };

		let payload: string | Buffer;
		if (format === "csv") {
			const text = request.text;
			if (typeof text !== "string") return { ok: false, error: "missing_text" };
			if (Buffer.byteLength(text, "utf8") > CHART_EXPORT_MAX_TEXT_BYTES) return { ok: false, error: "text_too_large" };
			payload = text;
		} else {
			const dataUrl = request.dataUrl;
			if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return { ok: false, error: "invalid_image" };
			const buffer = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), "base64");
			if (buffer.length === 0) return { ok: false, error: "invalid_image" };
			if (buffer.length > CHART_EXPORT_MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large" };
			payload = buffer;
		}

		const suggestedName = sanitizeChartExportName(request.suggestedName, format);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: suggestedName,
			filters: format === "png" ? [{ name: "PNG", extensions: ["png"] }] : [{ name: "CSV", extensions: ["csv"] }],
		});
		if (canceled || !filePath) return { ok: false, canceled: true };

		try {
			await writeFile(filePath, payload);
		} catch (error) {
			void appLogger.error("chart-export", "write failed", { format, error: error instanceof Error ? error.message : String(error) });
			return { ok: false, error: "write_failed" };
		}
		void appLogger.info("chart-export", "saved", { format, bytes: typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length });
		return { ok: true, filePath };
	});
}
