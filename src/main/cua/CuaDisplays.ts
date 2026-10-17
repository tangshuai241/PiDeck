/**
 * CUA 显示器信息：Electron 显示（DIP）与 Win32 显示器（物理像素）的合并视图。
 *
 * 截图几何需要**物理像素**矩形，而 Electron 只给 DIP 边界 + scaleFactor。C0 实测：
 * `bounds × scaleFactor` 在 125%/150% 混合缩放下会差 1px（副屏 2561×1601 vs 实际 2560×1600），
 * 所以优先用 `GetMonitorInfoW` 的物理矩形，只有拿不到（非 Windows / 原生绑定降级）时才用
 * DIP 换算并明确标记来源。
 */

import { screen } from "electron";
import { enumerateMonitorRects } from "./CuaWin32";
import { matchMonitorToDisplay, type CuaMonitorRect, type CuaRect } from "./CuaGeometry";

export type CuaDisplayInfo = {
	/** Electron 显示 id（`String(display.id)`），CUA 工具对外使用这个。 */
	displayId: string;
	label: string;
	primary: boolean;
	/** Electron 的 DIP 边界。 */
	dipBounds: CuaRect;
	scaleFactor: number;
	/** Win32 EFFECTIVE_DPI；取不到时 0。 */
	dpi: number;
	/** 屏幕物理像素矩形（虚拟桌面坐标，原点可为负）。 */
	screenRect: CuaRect;
	rotation: number;
	/** 物理矩形来源：`win32-monitor` 为精确值，`dip-scaled` 为 ±1px 的降级值。 */
	rectSource: "win32-monitor" | "dip-scaled";
};

function toRect(rect: { x: number; y: number; width: number; height: number }): CuaRect {
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 列出所有显示器（物理矩形 + DIP 边界 + 缩放）。
 *
 * 每次调用都重新枚举：显示器热插拔、缩放变化后几何必须跟着变，缓存会给出过期矩形。
 * 枚举本身是 µs 级 Win32 调用，不需要缓存。
 */
export function listCuaDisplays(): CuaDisplayInfo[] {
	// 非 Electron 运行时（node --test 直接加载本模块）没有 screen：返回空表，由工具侧标注。
	if (typeof screen?.getAllDisplays !== "function") return [];
	const electronDisplays = screen.getAllDisplays();
	const primaryId = String(screen.getPrimaryDisplay().id);
	const monitors: CuaMonitorRect[] = enumerateMonitorRects().map((monitor) => ({ rect: monitor.rect, work: monitor.work, primary: monitor.primary, dpiX: monitor.dpiX, dpiY: monitor.dpiY }));

	return electronDisplays.map((display) => {
		const dipBounds = toRect(display.bounds);
		const matched = matchMonitorToDisplay(dipBounds, display.scaleFactor, monitors);
		if (matched) {
			return {
				displayId: String(display.id),
				label: display.label,
				primary: String(display.id) === primaryId,
				dipBounds,
				scaleFactor: display.scaleFactor,
				dpi: matched.monitor.dpiX,
				screenRect: matched.monitor.rect,
				rotation: display.rotation,
				rectSource: "win32-monitor" as const,
			};
		}
		return {
			displayId: String(display.id),
			label: display.label,
			primary: String(display.id) === primaryId,
			dipBounds,
			scaleFactor: display.scaleFactor,
			dpi: 0,
			// 降级：DIP × scaleFactor，可能差 1px；结果里带 rectSource 让调用方知道精度。
			screenRect: {
				x: Math.round(dipBounds.x * display.scaleFactor),
				y: Math.round(dipBounds.y * display.scaleFactor),
				width: Math.round(dipBounds.width * display.scaleFactor),
				height: Math.round(dipBounds.height * display.scaleFactor),
			},
			rotation: display.rotation,
			rectSource: "dip-scaled" as const,
		};
	});
}

/** 按 Electron 显示 id 取显示器；未指定时返回主屏。 */
export function findCuaDisplay(displays: readonly CuaDisplayInfo[], displayId?: string): CuaDisplayInfo | undefined {
	if (!displayId) return displays.find((display) => display.primary);
	return displays.find((display) => display.displayId === displayId);
}
