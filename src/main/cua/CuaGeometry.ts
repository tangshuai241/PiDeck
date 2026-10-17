/**
 * CUA 截图几何与坐标映射（纯函数，不依赖 Electron / Win32）。
 *
 * 单位约定（C0 实测，见 `C:\Users\32379\orca\AppData` 之外的实测文档
 * `E:\A PI\cache\TPA-charts-20261017\C0-截图与坐标实测.md`）：
 * - `screenRect`、`CuaPoint.screen`：屏幕**物理像素**，原点为虚拟桌面原点，可为负。
 * - `imageWidth/imageHeight`：交付给模型的 JPEG 的像素尺寸。
 * - `sourceWidth/sourceHeight`：该帧原生捕获图的像素尺寸（请求框等于显示器物理尺寸时与屏幕 1:1）。
 * - 裁剪帧的 `screenRect` 已经是裁剪区域对应的物理矩形，所以「图像 → 屏幕」对所有帧同一条公式。
 *
 * 换算：
 *   screenX = screenRect.x + imageX / imageWidth  * screenRect.width
 *   screenY = screenRect.y + imageY / imageHeight * screenRect.height
 * 取整只发生在调用 Win32 输入之前的 `resolveScreenPoint`，中间保持浮点。
 */

export type CuaPoint = { x: number; y: number };

export type CuaRect = { x: number; y: number; width: number; height: number };

/**
 * 一帧截图的完整几何描述。
 *
 * `frameId` 只是宿主内存里的短期身份；需要跨重启回看时用图像引用（`screenshotRef`），
 * 不要把帧描述当成长期账本。
 */
export type CuaFrameGeometry = {
	frameId: string;
	/** Electron 显示 id（`screen.getAllDisplays()[].id`），用于和显示器信息对应。 */
	displayId: string;
	/** desktopCapturer source id（`screen:1:0`），仅作追溯。 */
	sourceId: string;
	/** 该帧覆盖的屏幕物理矩形（裁剪帧即裁剪区域）。 */
	screenRect: CuaRect;
	/** 原生捕获图像素尺寸。 */
	sourceWidth: number;
	sourceHeight: number;
	/** 交付图像素尺寸。 */
	imageWidth: number;
	imageHeight: number;
	capturedAtMs: number;
	/** 显示器旋转角；非 0 时本模块不做图像坐标映射（未实测组合）。 */
	rotation: number;
	/** 裁剪帧：父帧 id。 */
	parentFrameId?: string;
	/** 裁剪帧：区域在父帧图像坐标里的位置。 */
	crop?: CuaRect;
};

export type CuaGeometryFailure = "invalid-geometry" | "rotation-unsupported" | "point-out-of-bounds" | "empty-region";

export type CuaGeometryResult<T> = { ok: true; value: T } | { ok: false; reason: CuaGeometryFailure };

/** 图像像素可能比屏幕物理像素小（默认 1280 交付），因此裁剪区域允许小数。 */
export type CuaImageRect = { x: number; y: number; width: number; height: number };

export function isValidGeometry(geometry: CuaFrameGeometry): boolean {
	const rect = geometry.screenRect;
	return Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0 && geometry.imageWidth > 0 && geometry.imageHeight > 0 && geometry.sourceWidth > 0 && geometry.sourceHeight > 0 && Number.isFinite(geometry.rotation);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * 图像坐标 → 屏幕物理坐标（浮点）。
 *
 * 边界：点必须落在 `[0, imageWidth] × [0, imageHeight]` 内（含右/下边，便于「最右一列 / 最后一行」
 * 的定位）；旋转屏不做映射，返回稳定原因码。
 */
export function imagePointToScreen(geometry: CuaFrameGeometry, point: CuaPoint): CuaGeometryResult<CuaPoint> {
	if (!isValidGeometry(geometry)) return { ok: false, reason: "invalid-geometry" };
	if (geometry.rotation !== 0) return { ok: false, reason: "rotation-unsupported" };
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, reason: "point-out-of-bounds" };
	if (point.x < 0 || point.y < 0 || point.x > geometry.imageWidth || point.y > geometry.imageHeight) return { ok: false, reason: "point-out-of-bounds" };
	const rect = geometry.screenRect;
	return {
		ok: true,
		value: {
			x: rect.x + (point.x / geometry.imageWidth) * rect.width,
			y: rect.y + (point.y / geometry.imageHeight) * rect.height,
		},
	};
}

/** 屏幕物理坐标 → 图像坐标（浮点）。用于把已有屏幕坐标回填到截图里定位。 */
export function screenPointToImage(geometry: CuaFrameGeometry, point: CuaPoint): CuaGeometryResult<CuaPoint> {
	if (!isValidGeometry(geometry)) return { ok: false, reason: "invalid-geometry" };
	if (geometry.rotation !== 0) return { ok: false, reason: "rotation-unsupported" };
	const rect = geometry.screenRect;
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, reason: "point-out-of-bounds" };
	if (point.x < rect.x || point.y < rect.y || point.x > rect.x + rect.width || point.y > rect.y + rect.height) return { ok: false, reason: "point-out-of-bounds" };
	return {
		ok: true,
		value: {
			x: ((point.x - rect.x) / rect.width) * geometry.imageWidth,
			y: ((point.y - rect.y) / rect.height) * geometry.imageHeight,
		},
	};
}

/** 图像矩形 → 屏幕物理矩形（浮点）。 */
export function imageRectToScreenRect(geometry: CuaFrameGeometry, rect: CuaImageRect): CuaGeometryResult<CuaRect> {
	if (!isValidGeometry(geometry)) return { ok: false, reason: "invalid-geometry" };
	if (geometry.rotation !== 0) return { ok: false, reason: "rotation-unsupported" };
	const scaleX = geometry.screenRect.width / geometry.imageWidth;
	const scaleY = geometry.screenRect.height / geometry.imageHeight;
	return {
		ok: true,
		value: {
			x: geometry.screenRect.x + rect.x * scaleX,
			y: geometry.screenRect.y + rect.y * scaleY,
			width: rect.width * scaleX,
			height: rect.height * scaleY,
		},
	};
}

/**
 * 实际输入边界：把浮点屏幕坐标取整，并夹到该帧覆盖的屏幕像素内。
 * 只在调用 Win32 之前调用一次，避免中途多次取整带来的累计偏移。
 */
export function resolveScreenPoint(geometry: CuaFrameGeometry, point: CuaPoint): CuaPoint {
	const rect = geometry.screenRect;
	const maxX = rect.x + Math.max(0, rect.width - 1);
	const maxY = rect.y + Math.max(0, rect.height - 1);
	if (geometry.rotation !== 0) {
		// 旋转屏没有实测映射：至少保证坐标落在屏幕矩形内，不做轴向变换。
		return { x: clamp(Math.round(point.x), rect.x, maxX), y: clamp(Math.round(point.y), rect.y, maxY) };
	}
	return { x: clamp(Math.round(point.x), rect.x, maxX), y: clamp(Math.round(point.y), rect.y, maxY) };
}

/** 把裁剪区域夹到图像边界内；退化为空区域时返回 null。 */
export function clampImageRect(rect: CuaImageRect, imageWidth: number, imageHeight: number): CuaImageRect | null {
	if (![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value))) return null;
	const x = clamp(rect.x, 0, imageWidth);
	const y = clamp(rect.y, 0, imageHeight);
	const right = clamp(rect.x + rect.width, 0, imageWidth);
	const bottom = clamp(rect.y + rect.height, 0, imageHeight);
	const width = right - x;
	const height = bottom - y;
	if (width <= 0 || height <= 0) return null;
	return { x, y, width, height };
}

/** 图像矩形 → 原生图像素矩形（裁剪时用：原生图才是细节来源）。 */
export function imageRectToNativeRect(geometry: CuaFrameGeometry, rect: CuaImageRect): CuaImageRect {
	const scaleX = geometry.sourceWidth / geometry.imageWidth;
	const scaleY = geometry.sourceHeight / geometry.imageHeight;
	return { x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY };
}

/**
 * 由父帧裁剪出子帧几何：子帧 `screenRect` 是裁剪区域的物理矩形，
 * 因此「子帧图像坐标 → 屏幕」仍走同一条公式。
 *
 * `imageSize` 是**交给模型**的图（可能被缩小），`nativeSize` 是同一裁剪区域的原生像素尺寸。
 * 两者必须分开记录：后续 `cua_zoom` 以 `source*`（原生尺寸）为裁剪坐标系，
 * 若把缩小后的交付尺寸当成原生尺寸，连续裁剪会一路丢细节。
 */
export function cropFrameGeometry(parent: CuaFrameGeometry, crop: CuaImageRect, imageSize: { width: number; height: number }, frameId: string, capturedAtMs: number, nativeSize: { width: number; height: number } = imageSize): CuaFrameGeometry {
	const screenRect = imageRectToScreenRect(parent, crop);
	if (!screenRect.ok) {
		// 父帧非法时保留父帧矩形，避免产生看似正常的错误几何；调用方会先校验父帧。
		return { ...parent, frameId, imageWidth: imageSize.width, imageHeight: imageSize.height, sourceWidth: nativeSize.width, sourceHeight: nativeSize.height, parentFrameId: parent.frameId, crop, capturedAtMs };
	}
	return {
		frameId,
		displayId: parent.displayId,
		sourceId: parent.sourceId,
		screenRect: screenRect.value,
		sourceWidth: nativeSize.width,
		sourceHeight: nativeSize.height,
		imageWidth: imageSize.width,
		imageHeight: imageSize.height,
		capturedAtMs,
		rotation: parent.rotation,
		parentFrameId: parent.frameId,
		crop,
	};
}

/** Win32 显示器物理矩形（`GetMonitorInfoW` 的结果）。 */
export type CuaMonitorRect = {
	rect: CuaRect;
	work: CuaRect;
	primary: boolean;
	dpiX: number;
	dpiY: number;
};

/**
 * 把 Electron 显示（DIP 边界 + scaleFactor）匹配到 Win32 显示器物理矩形。
 *
 * 为什么不用 `bounds × scaleFactor`：DIP 由物理值除以 DPI 再取整得到，反乘会带 ±1px
 * 误差（实测副屏 1707×1067 × 1.5 = 2561×1601，实际 2560×1600）。
 * 匹配方式：monitor.rect / (dpi/96) 与 display.bounds 比较，取最大分量误差最小者；
 * 超过阈值返回 null，由调用方决定降级（不静默编造矩形）。
 */
export function matchMonitorToDisplay(dipBounds: CuaRect, scaleFactor: number, monitors: readonly CuaMonitorRect[], tolerancePx = 2): { monitor: CuaMonitorRect; errorPx: number } | null {
	let best: { monitor: CuaMonitorRect; errorPx: number } | null = null;
	for (const monitor of monitors) {
		const scale = monitor.dpiX > 0 ? monitor.dpiX / 96 : scaleFactor;
		if (!(scale > 0)) continue;
		const dip = { x: monitor.rect.x / scale, y: monitor.rect.y / scale, width: monitor.rect.width / scale, height: monitor.rect.height / scale };
		const errorPx = Math.max(Math.abs(dip.x - dipBounds.x), Math.abs(dip.y - dipBounds.y), Math.abs(dip.width - dipBounds.width), Math.abs(dip.height - dipBounds.height));
		if (!best || errorPx < best.errorPx) best = { monitor, errorPx };
	}
	if (!best || best.errorPx > tolerancePx) return null;
	return best;
}

/** 工具输出里的几何摘要（不暴露内部缓存字段）。 */
export function describeFrameGeometry(geometry: CuaFrameGeometry): Record<string, unknown> {
	return {
		frameId: geometry.frameId,
		displayId: geometry.displayId,
		sourceId: geometry.sourceId,
		screenRect: geometry.screenRect,
		imageWidth: geometry.imageWidth,
		imageHeight: geometry.imageHeight,
		sourceWidth: geometry.sourceWidth,
		sourceHeight: geometry.sourceHeight,
		coordinateSpace: "image",
		rotation: geometry.rotation,
		capturedAtMs: geometry.capturedAtMs,
		...(geometry.parentFrameId ? { parentFrameId: geometry.parentFrameId } : {}),
		...(geometry.crop ? { crop: geometry.crop } : {}),
	};
}
