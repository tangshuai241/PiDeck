/**
 * CuaScreen：截图与局部查看的装配层（复用 CuaFrame 的抓图与裁剪，不新增截图库）。
 *
 * 职责：
 * - 把「显示器物理矩形」（CuaDisplays）与「原生 1:1 截图」（CuaFrame）合成一帧几何；
 * - 维护最近帧缓存（CuaFrameRegistry，有上限和过期）；
 * - `cua_zoom` 从该帧的原生 JPEG 裁剪（不是放大交付图），并给出子帧几何，
 *   使局部图里的坐标仍能映射回原屏幕。
 *
 * 不做的：不发输入、不做授权（点击走 CuaEngine/CuaGate），不写轨迹账本。
 */

import { randomUUID } from "node:crypto";
import { captureScreen, cropNativeJpeg, type Frame } from "./CuaFrame";
import { findCuaDisplay, listCuaDisplays, type CuaDisplayInfo } from "./CuaDisplays";
import { clampImageRect, cropFrameGeometry, imageRectToNativeRect, type CuaFrameGeometry, type CuaImageRect } from "./CuaGeometry";
import { CuaFrameRegistry, type CuaRegisteredFrame } from "./CuaFrames";

export type CuaScreenDeps = {
	/** 测试注入：默认 CuaFrame.captureScreen。 */
	capture?: typeof captureScreen;
	/** 测试注入：默认 CuaDisplays.listCuaDisplays。 */
	listDisplays?: typeof listCuaDisplays;
	/**
	 * 旧调用方可能把 desktopCapturer source id（`screen:1:0`）当 displayId 传回来
	 * （C1 之前 cua_capture 的 displayId 就是 source id）。提供解析器时按需映射到 Electron 显示 id；
	 * 未提供时只接受 Electron 显示 id。
	 */
	resolveDisplayIdFromSource?: (sourceId: string) => Promise<string | undefined>;
	now?: () => number;
	maxFrames?: number;
	ttlMs?: number;
	/**
	 * 把交付 JPEG 落盘并返回引用（C2 轨迹回看用）。
	 * 未注入时不落盘，结果里没有 screenshotRef；不影响截图/点击主链路。
	 */
	saveScreenshot?: (base64: string, mimeType: string) => Promise<string | null>;
};

export type CuaCaptureOptions = {
	/** Electron 显示 id；省略为主屏。 */
	displayId?: string;
	maxLongEdge?: number;
	quality?: number;
	/** 发起调用的会话（仅追溯，不参与授权）。 */
	sessionId?: string;
};

export type CuaCaptureOutcome = {
	frame: Frame;
	geometry: CuaFrameGeometry;
	screenshotRef?: string;
};

export type CuaZoomOptions = {
	frameId: string;
	/** 区域，坐标单位是父帧的**图像像素**。 */
	region: CuaImageRect;
	/** 输出长边上限；只缩小不放大。默认 1600。 */
	maxLongEdge?: number;
	quality?: number;
	sessionId?: string;
};

export type CuaZoomOutcome = { ok: true; data: Buffer; width: number; height: number; geometry: CuaFrameGeometry; parentFrameId: string; screenshotRef?: string } | { ok: false; reason: "frame-not-found" | "rotation-unsupported" | "empty-region" | "crop-failed"; message: string };

export class CuaScreen {
	private readonly deps: CuaScreenDeps;
	private readonly frames: CuaFrameRegistry;

	constructor(deps: CuaScreenDeps = {}) {
		this.deps = deps;
		this.frames = new CuaFrameRegistry({ maxFrames: deps.maxFrames, ttlMs: deps.ttlMs, now: deps.now });
	}

	listDisplays(): CuaDisplayInfo[] {
		return (this.deps.listDisplays ?? listCuaDisplays)();
	}

	getFrame(frameId: string): CuaRegisteredFrame | undefined {
		return this.frames.get(frameId);
	}

	/** 抓一屏并登记帧。请求框 = 显示器物理尺寸，得到 1:1 原生图（C0 实测）。 */
	async capture(options: CuaCaptureOptions = {}): Promise<CuaCaptureOutcome> {
		const displays = this.listDisplays();
		let display = findCuaDisplay(displays, options.displayId);
		// 兼容旧 source id：C1 之前 cua_capture 返回的 displayId 是 `screen:1:0`。
		if (!display && options.displayId && this.deps.resolveDisplayIdFromSource) {
			const mapped = await this.deps.resolveDisplayIdFromSource(options.displayId);
			if (mapped) display = displays.find((entry) => entry.displayId === mapped);
		}
		if (!display) {
			const available = displays.map((entry) => entry.displayId).join(", ") || "none";
			throw new Error(`Unknown displayId "${options.displayId}". Available display ids: ${available}`);
		}

		const frame = await (this.deps.capture ?? captureScreen)({
			displayId: display.displayId,
			requestSize: { width: display.screenRect.width, height: display.screenRect.height },
			maxLongEdge: options.maxLongEdge,
			quality: options.quality,
			keepNativeJpeg: true,
		});

		if (frame.displayId !== display.displayId) {
			throw new Error(`Capture returned display ${frame.displayId}, expected ${display.displayId}`);
		}

		const geometry: CuaFrameGeometry = {
			frameId: randomUUID(),
			displayId: display.displayId,
			sourceId: frame.sourceId,
			screenRect: display.screenRect,
			sourceWidth: frame.sourceWidth,
			sourceHeight: frame.sourceHeight,
			imageWidth: frame.width,
			imageHeight: frame.height,
			capturedAtMs: frame.timestampMs,
			rotation: display.rotation,
		};

		// nativeJpeg 一定存在（keepNativeJpeg=true）；缺失时退回交付图，几何仍然自洽，
		// 只是后续裁剪拿不到额外细节。
		const screenshotRef = await this.persist(frame.base64, frame.mimeType);
		this.frames.register({ geometry, nativeJpeg: frame.nativeJpeg ?? frame.data, sessionId: options.sessionId, ...(screenshotRef ? { screenshotRef } : {}) });
		return { frame, geometry, ...(screenshotRef ? { screenshotRef } : {}) };
	}

	/**
	 * 从已有帧的原生图裁剪局部。不重新截图：结果标注父帧与区域，
	 * 与「重新截图后裁剪」在语义上分开（重新截图请先 capture 再 zoom）。
	 */
	async zoom(options: CuaZoomOptions): Promise<CuaZoomOutcome> {
		const entry = this.frames.get(options.frameId);
		if (!entry) {
			return { ok: false, reason: "frame-not-found", message: `Frame ${options.frameId} is not cached (frames expire). Call cua_capture again, then zoom the new frame.` };
		}
		const parent = entry.geometry;
		if (parent.rotation !== 0) {
			return { ok: false, reason: "rotation-unsupported", message: `Display rotation ${parent.rotation} is not supported for image-coordinate mapping (unverified combination).` };
		}

		const region = clampImageRect(options.region, parent.imageWidth, parent.imageHeight);
		if (!region) {
			return { ok: false, reason: "empty-region", message: `Region is outside the frame image (${parent.imageWidth}x${parent.imageHeight}) or has no area.` };
		}

		const nativeRect = imageRectToNativeRect(parent, region);
		const crop = cropNativeJpeg(entry.nativeJpeg, nativeRect, { maxLongEdge: options.maxLongEdge ?? 1600, quality: options.quality ?? 85 });
		if (!crop) {
			return { ok: false, reason: "crop-failed", message: "Native capture could not be decoded for cropping." };
		}

		// 交付图可能是缩小版；子帧的原生裁剪源必须是未缩小的那一份，否则连续 zoom 会逐级丢细节。
		const geometry = cropFrameGeometry(parent, region, { width: crop.width, height: crop.height }, randomUUID(), parent.capturedAtMs, { width: crop.nativeWidth, height: crop.nativeHeight });
		const screenshotRef = await this.persist(crop.data.toString("base64"), "image/jpeg");
		this.frames.register({ geometry, nativeJpeg: crop.nativeData, sessionId: options.sessionId, ...(screenshotRef ? { screenshotRef } : {}) });
		return { ok: true, data: crop.data, width: crop.width, height: crop.height, geometry, parentFrameId: parent.frameId, ...(screenshotRef ? { screenshotRef } : {}) };
	}

	dispose(): void {
		this.frames.dispose();
	}

	private async persist(base64: string, mimeType: string): Promise<string | undefined> {
		if (!this.deps.saveScreenshot) return undefined;
		try {
			const ref = await this.deps.saveScreenshot(base64, mimeType);
			return ref ?? undefined;
		} catch {
			// 落盘失败只影响轨迹回看，不影响截图/点击；工具结果里就不带引用。
			return undefined;
		}
	}
}
