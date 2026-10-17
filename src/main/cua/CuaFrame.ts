import { desktopCapturer, nativeImage, screen, type NativeImage } from "electron";

/**
 * Frame pipeline for CUA.
 *
 * Design choices validated by probe2/probe5 (2026-10 C0 re-measurement):
 * - Use desktopCapturer with types:['screen'] (full screen), not ['window'].
 * - Use nativeImage.resize + toJPEG instead of sharp to avoid an extra dependency.
 * - `thumbnailSize` is a REQUEST BOX, not a ceiling: Electron resamples the display
 *   into that box and **upscales** when the box is larger than the display. Measured
 *   on a 2560x1440 monitor: request 8192 -> 8192x4608 (3.2x upscale, 476ms, 1.37MB
 *   JPEG@q75); request 2560x1440 -> native 1:1 (359ms). The delivered budget is
 *   enforced by the resize below, so callers that need real detail must pass
 *   `requestSize` = the display's physical size (CuaScreen does this).
 */

export type CaptureOptions = {
	/** Matches either desktopCapturer source id (`screen:1:0`) or Electron display id. Omit for primary. */
	displayId?: string;
	/** Thumbnail request box. Production passes the display's physical size; omit for the legacy 8192 box. */
	requestSize?: { width: number; height: number };
	/** Resize so the longer edge is at most this many pixels. */
	maxLongEdge?: number;
	/** JPEG quality 1-100. */
	quality?: number;
	/** Keep a native-resolution JPEG of the capture (crop source for `cua_zoom`). */
	keepNativeJpeg?: boolean;
	/** Native JPEG quality (default 92). */
	nativeQuality?: number;
};

export type Frame = {
	/** JPEG bytes of the delivered image. */
	data: Buffer;
	/** Base64-encoded JPEG. */
	base64: string;
	/** MIME type (image/jpeg). */
	mimeType: string;
	/** Delivered image size (what the model sees). */
	width: number;
	height: number;
	/** Native capture size (request box), i.e. the crop source resolution. */
	sourceWidth: number;
	sourceHeight: number;
	/** desktopCapturer source id (`screen:1:0`). */
	sourceId: string;
	/** Electron display id (matches `screen.getAllDisplays()[].id`). */
	displayId: string;
	timestampMs: number;
	durationMs: number;
	/** Native-resolution JPEG when `keepNativeJpeg` is set (zoom crop source). */
	nativeJpeg?: Buffer;
};

export const DEFAULT_MAX_LONG_EDGE = 1280;
export const DEFAULT_QUALITY = 75;
export const DEFAULT_NATIVE_QUALITY = 92;

/**
 * Legacy fallback request box. Kept only for callers that do not know the display's
 * physical size; it upscales on large monitors, so `CuaScreen.capture` always passes
 * an exact physical `requestSize` instead.
 */
export const THUMBNAIL_REQUEST_SIZE = 8192;

/**
 * Capture a display and produce a JPEG frame.
 */
export async function captureScreen(options: CaptureOptions = {}): Promise<Frame> {
	const start = Date.now();
	const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
	const quality = options.quality ?? DEFAULT_QUALITY;
	const request = options.requestSize ?? { width: THUMBNAIL_REQUEST_SIZE, height: THUMBNAIL_REQUEST_SIZE };

	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: { width: Math.max(1, Math.round(request.width)), height: Math.max(1, Math.round(request.height)) },
	});

	const source = options.displayId ? sources.find((candidate) => String(candidate.id) === String(options.displayId) || String(candidate.display_id) === String(options.displayId)) : resolvePrimarySource(sources);

	if (!source) {
		throw new Error(`Screen source not found: ${options.displayId ?? "primary"}`);
	}

	let image: NativeImage = source.thumbnail;
	const originalSize = image.getSize();

	// Native JPEG before any resize: this is the only honest crop source for `cua_zoom`
	// (cropping the delivered 1280px JPEG would just upscale blur).
	const nativeJpeg = options.keepNativeJpeg ? image.toJPEG(options.nativeQuality ?? DEFAULT_NATIVE_QUALITY) : undefined;

	const longEdge = Math.max(originalSize.width, originalSize.height);
	if (longEdge > maxLongEdge) {
		const scale = maxLongEdge / longEdge;
		const newWidth = Math.max(1, Math.round(originalSize.width * scale));
		const newHeight = Math.max(1, Math.round(originalSize.height * scale));
		image = image.resize({ width: newWidth, height: newHeight, quality: "good" });
	}

	const size = image.getSize();
	const data = image.toJPEG(quality);
	const base64 = data.toString("base64");

	return {
		data,
		base64,
		mimeType: "image/jpeg",
		width: size.width,
		height: size.height,
		sourceWidth: originalSize.width,
		sourceHeight: originalSize.height,
		sourceId: String(source.id),
		displayId: String(source.display_id),
		timestampMs: Date.now(),
		durationMs: Date.now() - start,
		...(nativeJpeg ? { nativeJpeg } : {}),
	};
}

/**
 * Default source = the primary display, not `sources[0]` (source order is not a
 * documented contract; C0 measured `sources[0]` == primary on this machine only).
 */
function resolvePrimarySource(sources: Electron.DesktopCapturerSource[]): Electron.DesktopCapturerSource | undefined {
	const primaryId = screen?.getPrimaryDisplay?.()?.id;
	if (primaryId !== undefined) {
		const matched = sources.find((candidate) => String(candidate.display_id) === String(primaryId));
		if (matched) return matched;
	}
	return sources[0];
}

export type NativeCrop = {
	/** 交给模型的图片（可能按 maxLongEdge 缩小）。 */
	data: Buffer;
	width: number;
	height: number;
	/** 同一区域的原生像素 JPEG：后续 `cua_zoom` 继续裁剪时用它，不能用缩小后的交付图。 */
	nativeData: Buffer;
	nativeWidth: number;
	nativeHeight: number;
};

/**
 * Crop a native JPEG to a rectangle in native pixels.
 *
 * 返回两份字节：`data` 是给模型看的交付图（按 maxLongEdge 缩小），`nativeData` 是同一区域的
 * 原生像素图。为什么要分开：连续 `cua_zoom` 时若把缩小后的交付图当成下一帧的裁剪源，
 * 第二次裁剪只能得到更小的图，细节在第一次缩小时就丢了（复核复现：同一 400×400 区域，
 * 直接裁剪得 400×400，经一次 640 宽局部帧再裁只剩 100×100）。
 *
 * 返回 null 表示缓冲不可解码或裁剪区域为空。
 */
export function cropNativeJpeg(nativeJpeg: Buffer, rect: { x: number; y: number; width: number; height: number }, options: { maxLongEdge?: number; quality?: number } = {}): NativeCrop | null {
	const image = nativeImage.createFromBuffer(nativeJpeg);
	if (image.isEmpty()) return null;
	const size = image.getSize();
	const left = Math.max(0, Math.min(size.width, Math.floor(rect.x)));
	const top = Math.max(0, Math.min(size.height, Math.floor(rect.y)));
	const right = Math.max(left, Math.min(size.width, Math.ceil(rect.x + rect.width)));
	const bottom = Math.max(top, Math.min(size.height, Math.ceil(rect.y + rect.height)));
	if (right - left <= 0 || bottom - top <= 0) return null;

	const quality = options.quality ?? 85;
	const cropped = image.crop({ x: left, y: top, width: right - left, height: bottom - top });
	const croppedSize = cropped.getSize();
	// 原生裁剪图先编码：后续 zoom 以它为源，与本次交付是否缩小无关。
	const nativeData = cropped.toJPEG(DEFAULT_NATIVE_QUALITY);

	const maxLongEdge = options.maxLongEdge ?? 1600;
	const longEdge = Math.max(croppedSize.width, croppedSize.height);
	if (longEdge <= maxLongEdge) {
		// 未缩小：交付图与原生图同尺寸，但**质量仍按调用方要求**。
		// 只有请求质量恰好等于原生缓存质量时才复用同一份字节，否则低质量请求会被
		// 静默升级成 92（复核复现：quality 1 与 100 返回同样的字节）。
		const data = quality === DEFAULT_NATIVE_QUALITY ? nativeData : cropped.toJPEG(quality);
		return { data, width: croppedSize.width, height: croppedSize.height, nativeData, nativeWidth: croppedSize.width, nativeHeight: croppedSize.height };
	}
	const scale = maxLongEdge / longEdge;
	const resized = cropped.resize({ width: Math.max(1, Math.round(croppedSize.width * scale)), height: Math.max(1, Math.round(croppedSize.height * scale)), quality: "good" });
	const outputSize = resized.getSize();
	return { data: resized.toJPEG(quality), width: outputSize.width, height: outputSize.height, nativeData, nativeWidth: croppedSize.width, nativeHeight: croppedSize.height };
}

/**
 * Build a data URL from a captured frame.
 */
export function frameToDataUrl(frame: Frame): string {
	return `data:${frame.mimeType};base64,${frame.base64}`;
}

/**
 * Estimate base64 byte count for a frame.
 */
export function frameBase64Length(frame: Frame): number {
	return frame.base64.length;
}
