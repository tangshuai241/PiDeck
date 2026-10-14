import palettes from "./t3-palettes.json";
import type { AppSkinId } from "../../../shared/types/settings";

export type T3ThemeId = Extract<AppSkinId, `t3-${string}`>;
export type ThemeOrbColors = { canvas: string; accent: string; messageAction: string };

/** Original T3 Code artwork uses quieter accents than its interactive controls. */
export function getT3OrbColors(id: string, mode: "light" | "dark"): ThemeOrbColors | undefined {
	if (id === "t3-code") return mode === "light" ? { canvas: "#fcfcfc", accent: "#f4f4f5", messageAction: "#4f46e5" } : { canvas: "#0a0a0a", accent: "#1c1c1f", messageAction: "#8b9cff" };
	return palettes.find((palette) => palette.id === id)?.[mode];
}

/** Keep the source's Oklab falloff, geometry and opacity; movement is separate. */
export function themeOrbStyle(colors: ThemeOrbColors, mode: "light" | "dark") {
	const light = mode === "light";
	return {
		backgroundColor: `color-mix(in oklab, ${colors.canvas} 80%, ${light ? "#ffffff" : "#09090b"})`,
		backgroundImage: `radial-gradient(circle at ${light ? "72% 22%" : "28% 78%"} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${light ? 72 : 62}%, transparent) 28%, transparent 58%), radial-gradient(circle at ${light ? "18% 82%" : "82% 18%"} in oklab, color-mix(in oklab, ${colors.messageAction} 45%, transparent) 0%, transparent 55%)`,
		filter: "blur(3px)",
	};
}
