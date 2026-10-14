import t3Palettes from "./themes/t3-palettes.json";
import type { AppAccentMode, AppSkinId } from "../../shared/types/settings";
import type { TranslationKey } from "./i18n";

/**
 * 主题色预设（UI 主题扩展点）。
 *
 * 扩展自制主题的方式：
 * 1. 在 foundation.css 新增 `:root[data-accent="<id>"]`（及 dark 变体）覆盖
 *    --color-accent/-strong/-soft 与 --color-logo-green* 系列；
 * 2. 在这里的 ACCENT_PRESETS 追加一条（id/label/色值预览）。
 * 两处同步后，设置页「主题色」下拉即自动出现新选项，无需改业务代码。
 *
 * 注：外观主题（SKIN_PRESETS）上线后，accent 不再作为独立下拉暴露在设置页，
 * 仅保留为自定义主题（themeSkin="custom"）与旧版数据的兼容字段。
 */
export type AccentPreset = {
	id: AppAccentMode;
	labelKey: TranslationKey;
	/** 预览色（设置页色块展示） */
	preview: string;
};

export const ACCENT_PRESETS: readonly AccentPreset[] = [
	// 出厂默认使用黑白灰；绿色保留为显式可选主题，避免默认界面被高饱和色占据。
	// preview 与 foundation.css 的默认 --color-accent 保持一致（浅色 zinc-900 近黑）。
	{ id: "default", labelKey: "settings.accent.default", preview: "#18181b" },
	// 绿色预览与 foundation.css 的森系绿主色保持一致（#4a7854，参考 Proma 森息配色）。
	{ id: "green", labelKey: "settings.accent.green", preview: "#4a7854" },
	{ id: "blue", labelKey: "settings.accent.blue", preview: "#2563eb" },
	{ id: "purple", labelKey: "settings.accent.purple", preview: "#7c3aed" },
	{ id: "amber", labelKey: "settings.accent.amber", preview: "#b45309" },
	{ id: "rose", labelKey: "settings.accent.rose", preview: "#e11d48" },
];

export const DEFAULT_ACCENT: AppAccentMode = "default";

/**
 * 外观主题（皮肤）预设：每套主题 = 一套协调的完整外观，
 * 覆盖表面/边框/文字/会话面板色板 + 自带推荐主色（accent），并自动适配浅色/暗色。
 *
 * 扩展方式：
 * 1. 在 foundation.css 新增 `:root[data-appearance="<id>"]`（及
 *    `:root[data-theme="dark"][data-appearance="<id>"]`）表面/文字/边框/会话面板色板块；
 * 2. 在这里的 SKIN_PRESETS 追加一条（id/labelKey/descKey/accent/preview/previewSurfaces）。
 * 两处同步后，设置页「外观主题」选择器自动出现新项。
 *
 * 渲染分工（保持单一事实源）：
 * - 表面/边框/文字/会话面板色板：CSS `[data-appearance="<id>"]` 块（foundation.css），
 *   本文件不再重复存一份色值（避免两份色板漂移）；
 * - 主色：经 `data-accent` 联动——选择外观主题时设置页同时写入本次的 accent 字段，
 *   复用既有 `:root[data-accent="…"]` 各主色块；
 * - classic-green 为出厂默认：无表面覆盖块（= :root 当前中性浅色观感），
 *   主色 = data-accent="default"（黑白灰），保持旧版出厂观感不变；
 * - fresh-green 为全屏森系绿主题：纸感浅绿表面 + 鼠尾草绿主色（CSS 覆盖块），
 *   主色 = data-accent="green"（#4a7854）。
 *
 * 自定义主题：themeSkin="custom" 时，App.tsx 将 customThemeOverrides 叠加应用；
 * 背景图走 backgroundImage / backgroundImageOpacity 设置项。
 */
export type SkinPreset = {
	id: AppSkinId;
	labelKey: TranslationKey;
	/** 主题一句话描述（设置页卡片悬浮提示） */
	descKey: TranslationKey;
	/** 外观主题推荐主色（AppAccentMode），选择该主题时 UI 联动写入 settings.accent */
	accent: AppAccentMode;
	/** 预览主色（设置页主题卡片主色块） */
	preview: string;
	/** 设置页主题卡片预览用的表面色块（浅色观感） */
	previewSurfaces: {
		background: string;
		sidebar: string;
		panel: string;
		accent: string;
		border: string;
	};
};

export const LEGACY_SKIN_PRESETS: readonly SkinPreset[] = [
	{
		id: "classic-green",
		labelKey: "settings.skin.classicGreen",
		descKey: "settings.skin.classicGreenDesc",
		// 出厂默认：中性黑白灰（表面 = :root 默认中性白灰，无 CSS 覆盖块；
		// 主色 = data-accent="default" 的近黑/近白），与旧版出厂观感一致。
		accent: "default",
		preview: "#ffffff",
		previewSurfaces: {
			background: "#ffffff",
			sidebar: "#ffffff",
			panel: "#fafafa",
			accent: "#18181b",
			border: "#dfdfdf",
		},
	},
	{
		id: "fresh-green",
		labelKey: "settings.skin.freshGreen",
		descKey: "settings.skin.freshGreenDesc",
		// 全屏森系绿：纸感浅绿表面 + 鼠尾草绿主色（参考 Proma theme-forest-light），
		// 主色 = data-accent="green"（#4a7854）。
		accent: "green",
		preview: "#f6f7f2",
		previewSurfaces: {
			background: "#f6f7f2",
			sidebar: "#ecefe6",
			panel: "#f6f7f2",
			accent: "#4a7854",
			border: "#c8cfbf",
		},
	},
	{
		id: "graphite",
		labelKey: "settings.skin.graphite",
		descKey: "settings.skin.graphiteDesc",
		accent: "default",
		preview: "#e2e2e2",
		previewSurfaces: {
			background: "#ececec",
			sidebar: "#e3e3e3",
			panel: "#f8f8f8",
			accent: "#18181b",
			border: "#d0d0d0",
		},
	},
	{
		id: "sea-blue",
		labelKey: "settings.skin.seaBlue",
		descKey: "settings.skin.seaBlueDesc",
		accent: "blue",
		preview: "#eaf3fb",
		previewSurfaces: {
			background: "#eef5fb",
			sidebar: "#e4eef7",
			panel: "#ffffff",
			accent: "#2563eb",
			border: "#d3e1ec",
		},
	},
	{
		id: "warm-beige",
		labelKey: "settings.skin.warmBeige",
		descKey: "settings.skin.warmBeigeDesc",
		accent: "amber",
		preview: "#f6f1e8",
		previewSurfaces: {
			background: "#f7f2ea",
			sidebar: "#f0e9dd",
			panel: "#fffdf8",
			accent: "#b45309",
			border: "#ded2bf",
		},
	},
];

/** 出厂外观主题：classic-green（中性黑白灰，与旧版出厂观感一致） */
export const DEFAULT_SKIN: AppSkinId = "classic-green";

/** T3 palettes retain source names and exact color values; legacy IDs remain readable. */
const T3_PRESET_METADATA: readonly Pick<SkinPreset, "id" | "labelKey">[] = [
	{ id: "t3-code", labelKey: "settings.skin.t3Code" },
	{ id: "t3-chat", labelKey: "settings.skin.t3Chat" },
	{ id: "t3-grove", labelKey: "settings.skin.t3Grove" },
	{ id: "t3-ocean", labelKey: "settings.skin.t3Ocean" },
	{ id: "t3-ember", labelKey: "settings.skin.t3Ember" },
	{ id: "t3-iris", labelKey: "settings.skin.t3Iris" },
];
export const T3_SKIN_PRESETS: readonly SkinPreset[] = T3_PRESET_METADATA.map((preset) => {
	const palette = t3Palettes.find((item) => item.id === preset.id);
	if (!palette) throw new Error(`Missing T3 palette: ${preset.id}`);
	const light = palette.light;
	return { ...preset, descKey: "settings.skin.t3Desc", accent: "default", preview: light.canvas, previewSurfaces: { background: light.canvas, sidebar: light.sidebar, panel: light.surface, accent: light.accent, border: light.border } };
});
export const SKIN_PRESETS: readonly SkinPreset[] = [...LEGACY_SKIN_PRESETS, ...T3_SKIN_PRESETS];
