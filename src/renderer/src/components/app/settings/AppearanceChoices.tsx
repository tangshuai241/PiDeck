import { memo } from "react";
import { RadioGroup } from "radix-ui";
import { Check, Clock3, Monitor, Moon, Sun } from "lucide-react";
import type { AppSkinId, AppThemeMode } from "../../../../../shared/types/settings";
import { t } from "../../../i18n";
import { T3_SKIN_PRESETS, LEGACY_SKIN_PRESETS } from "../../../themePresets";
import { Button } from "../../ui-shadcn/button";
import { ThemeOrb } from "./ThemeOrb";
import { getT3OrbColors } from "../../../themes/t3Themes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { cn } from "../../../lib/utils";

const MODES = [
	{ id: "system", label: "settings.themeSystem", icon: Monitor },
	{ id: "light", label: "settings.themeLight", icon: Sun },
	{ id: "dark", label: "settings.themeDark", icon: Moon },
	{ id: "schedule", label: "settings.themeSchedule", icon: Clock3 },
] as const;

const cardClass =
	"group relative h-auto min-w-0 flex-col whitespace-normal rounded-xl border border-transparent bg-settings-control/40 p-3 text-foreground shadow-none hover:bg-bg-muted/50 data-[state=checked]:border-primary data-[state=checked]:bg-settings-control motion-reduce:transition-none motion-reduce:active:scale-100";

/** 静态布局缩略图只表达明暗关系；不播放背景动画，也不启动实际工作区。 */
function ModePreview({ mode }: { mode: AppThemeMode }) {
	const split = mode === "system" || mode === "schedule";
	return (
		<span aria-hidden="true" className="relative flex h-20 w-full overflow-hidden rounded-lg border border-black/10" style={{ background: mode === "dark" ? "#202126" : split ? "linear-gradient(90deg, #f7f7fa 50%, #202126 50%)" : "#f7f7fa" }}>
			<span className="flex w-[27%] flex-col gap-1.5 border-r border-black/10 bg-black/5 p-2">
				<span className="mb-1 h-2 w-3/4 rounded-full bg-[#7c879b]/45" />
				<span className="h-1.5 rounded-full bg-[#7c879b]/25" />
				<span className="h-1.5 rounded-full bg-[#7c879b]/20" />
				<span className="h-1.5 w-3/4 rounded-full bg-[#7c879b]/20" />
			</span>
			<span className="flex flex-1 flex-col gap-2 p-2.5">
				<span className="h-2 w-1/2 self-end rounded-full bg-[#7c879b]/45" />
				<span className="h-1.5 w-3/4 rounded-full bg-[#92939b]/30" />
				<span className="h-1.5 w-1/2 rounded-full bg-[#92939b]/20" />
				<span className="mt-auto flex h-4 items-center justify-end rounded-md border border-[#92939b]/30 px-1">
					<span className="size-1.5 rounded-full bg-[#7c879b]/80" />
				</span>
			</span>
		</span>
	);
}

/** 使用 Radix 的 roving focus 保留方向键、空格及读屏的单选语义。 */
export const AppearanceModePicker = memo(function AppearanceModePicker({ value, onPick }: { value: AppThemeMode; onPick: (mode: AppThemeMode) => void }) {
	return (
		<RadioGroup.Root
			value={value}
			onValueChange={(next) => {
				const mode = MODES.find((item) => item.id === next);
				if (mode) onPick(mode.id);
			}}
			aria-label={t("settings.theme")}
			className="grid grid-cols-2 gap-3 @2xl:grid-cols-4"
		>
			{MODES.map(({ id, label, icon: Icon }) => (
				<RadioGroup.Item key={id} value={id} asChild>
					<Button variant="outline" className={cn(cardClass, "gap-2.5 p-2.5")}>
						<ModePreview mode={id} />
						<span className="flex items-center gap-1.5 text-control">
							<Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
							{t(label)}
						</span>
					</Button>
				</RadioGroup.Item>
			))}
		</RadioGroup.Root>
	);
});

/** 色球是主题色彩意象，一张卡片选择整套主题；明暗模式由上方独立控制。 */
export const AppearanceThemePicker = memo(function AppearanceThemePicker({ value, onPick }: { value: AppSkinId; onPick: (id: AppSkinId) => void }) {
	return (
		<div className="w-full">
			<RadioGroup.Root
				value={value}
				onValueChange={(next) => {
					const preset = T3_SKIN_PRESETS.find((item) => item.id === next);
					if (preset) onPick(preset.id);
				}}
				aria-label={t("settings.accent")}
				className="grid w-full grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-6"
			>
				{T3_SKIN_PRESETS.map((preset, index) => {
					const light = getT3OrbColors(preset.id, "light");
					const dark = getT3OrbColors(preset.id, "dark");
					if (!light || !dark) return null;
					return (
						<RadioGroup.Item key={preset.id} value={preset.id} asChild>
							<Button variant="ghost" title={t(preset.descKey)} className={cn(cardClass, "gap-4 px-2 pb-4 pt-5 data-[state=checked]:border-transparent")}>
								<span aria-hidden="true" className="flex w-full items-center justify-center py-1">
									<ThemeOrb colors={light} mode="light" phase={index * 1.7} />
									<ThemeOrb colors={dark} mode="dark" phase={index * 1.7 + 2} />
								</span>
								<span className="flex items-center justify-center gap-1.5 text-control">
									<span>{t(preset.labelKey)}</span>
									{value === preset.id && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
								</span>
							</Button>
						</RadioGroup.Item>
					);
				})}
			</RadioGroup.Root>
			<div className="mt-4 flex items-center justify-between gap-4 border-t border-border-subtle/50 pt-3">
				<span className="text-caption text-muted-foreground">{t("settings.skin.legacy")}</span>
				<Select
					value={LEGACY_SKIN_PRESETS.some((preset) => preset.id === value) ? value : ""}
					onValueChange={(next) => {
						const preset = LEGACY_SKIN_PRESETS.find((item) => item.id === next);
						if (preset) onPick(preset.id);
					}}
				>
					<SelectTrigger aria-label={t("settings.skin.legacy")} className="w-[180px]">
						<SelectValue placeholder={t("settings.skin.legacy")} />
					</SelectTrigger>
					<SelectContent>
						{LEGACY_SKIN_PRESETS.map((preset) => (
							<SelectItem key={preset.id} value={preset.id}>
								{t(preset.labelKey)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{value === "custom" && <p className="mt-3 text-caption text-muted-foreground">{t("settings.skin.custom")}</p>}
		</div>
	);
});
