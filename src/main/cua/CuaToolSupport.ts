/**
 * CUA 工具面的共享小工具：帧记录、目标窗口、坐标解析与结果封装。
 *
 * 拆出来是因为 CuaTools 只该做「注册工具 + 描述契约」；坐标解析和记录拼装属于可单测的纯逻辑。
 */

import type { CuaScreen } from "./CuaScreen";
import type { OcclusionInfo } from "./CuaWindowAnalyzer";
import { imagePointToScreen, resolveScreenPoint, type CuaFrameGeometry, type CuaPoint } from "./CuaGeometry";
import { CUA_ACTION_SCHEMA_VERSION, type CuaActionFrame, type CuaActionRecord, type CuaActionTarget, type CuaRecordPoint, type CuaToolResultPayload } from "../../shared/types/cua";

export function frameRecord(geometry: CuaFrameGeometry, screenshotRef?: string): CuaActionFrame {
	return {
		frameId: geometry.frameId,
		displayId: geometry.displayId,
		sourceId: geometry.sourceId,
		...(geometry.screenRect ? { screenRect: geometry.screenRect } : {}),
		imageWidth: geometry.imageWidth,
		imageHeight: geometry.imageHeight,
		sourceWidth: geometry.sourceWidth,
		sourceHeight: geometry.sourceHeight,
		coordinateSpace: "image",
		rotation: geometry.rotation,
		capturedAtMs: geometry.capturedAtMs,
		...(screenshotRef ? { screenshotRef } : {}),
		...(geometry.parentFrameId ? { parentFrameId: geometry.parentFrameId } : {}),
		...(geometry.crop ? { crop: geometry.crop } : {}),
	};
}

export function targetRecord(target: { title: string; hwnd: number; rect: { x: number; y: number; width: number; height: number } } | undefined): CuaActionTarget | undefined {
	if (!target) return undefined;
	return { title: target.title, hwnd: target.hwnd, rect: target.rect };
}

/** 窗口列表的工具输出形状：isVisible 必须进契约，否则 includeInvisible 形同虚设。 */
export function summarizeWindows(windows: readonly OcclusionInfo[]): Array<Record<string, unknown>> {
	return windows.map((info) => ({
		hwnd: info.window.hwnd,
		title: info.window.title,
		pid: info.window.pid,
		zIndex: info.window.zIndex,
		rect: info.window.rect,
		isVisible: info.window.isVisible,
		isForeground: info.window.isForeground,
		isTopmost: info.window.isTopmost,
		occludedArea: info.occludedArea,
		titleBarPoint: info.titleBarPoint,
	}));
}

export function asPoint(point: CuaPoint): CuaRecordPoint {
	return { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) };
}

/** 统一的结果封装：文本 JSON（含 tpaCua）。 */
export function textResult(payload: CuaToolResultPayload, isError = false): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

export type ResolvedInput = { ok: true; coordinateSpace: "image"; image: CuaPoint; screen: CuaPoint; frame: { geometry: CuaFrameGeometry; screenshotRef?: string } } | { ok: true; coordinateSpace: "screen"; screen: CuaPoint; image?: undefined; frame?: undefined } | { ok: false; error: string };

/**
 * 解析点击/滚动的坐标：
 * - 给了 frameId → 图像坐标，必须能映射（帧过期、旋转屏、越界都明确报错，不猜）；
 * - 没给 frameId → 旧语义：绝对屏幕物理坐标，原样取整，不做任何缩放。
 */
export function resolveInputPoint(screen: CuaScreen, frameId: string | undefined, x: number, y: number): ResolvedInput {
	if (!frameId) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "invalid-coordinate: x/y must be finite numbers" };
		return { ok: true, coordinateSpace: "screen", screen: { x: Math.round(x), y: Math.round(y) } };
	}
	const entry = screen.getFrame(frameId);
	if (!entry) {
		return { ok: false, error: `frame-not-found: ${frameId} is not cached (frames expire). Call cua_capture again to get a new frameId.` };
	}
	const mapped = imagePointToScreen(entry.geometry, { x, y });
	if (!mapped.ok) {
		const detail = mapped.reason === "rotation-unsupported" ? "display rotation is not supported for image coordinates (unverified); use absolute screen coordinates" : `point (${x}, ${y}) is outside the frame image ${entry.geometry.imageWidth}x${entry.geometry.imageHeight}`;
		return { ok: false, error: `${mapped.reason}: ${detail}` };
	}
	return { ok: true, coordinateSpace: "image", image: { x, y }, screen: resolveScreenPoint(entry.geometry, mapped.value), frame: { geometry: entry.geometry, ...(entry.screenshotRef ? { screenshotRef: entry.screenshotRef } : {}) } };
}

export function failureRecord(action: "click" | "scroll", startedAt: number, error: string): CuaActionRecord {
	return {
		schemaVersion: CUA_ACTION_SCHEMA_VERSION,
		action,
		at: Date.now(),
		durationMs: Date.now() - startedAt,
		receipt: { sent: 0, error },
		effect: "unverified",
	};
}
