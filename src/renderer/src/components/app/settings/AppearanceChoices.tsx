import { memo } from "react";
import { RadioGroup } from "radix-ui";
import { Check, Clock3, Monitor, Moon, Sun } from "lucide-react";
import type { AppSkinId, AppThemeMode } from "../../../../../shared/types/settings";
import { t } from "../../../i18n";
import { SKIN_PRESETS } from "../../../themePresets";
import { Button } from "../../ui-shadcn/button";
import { cn } from "../../../lib/utils";

const MODES = [
	{ id: "system", label: "settings.themeSystem", icon: Monitor },
	{ id: "light", label: "settings.themeLight", icon: Sun },
	{ id: "dark", label: "settings.themeDark", icon: Moon },
	{ id: "schedule", label: "settings.themeSchedule", icon: Clock3 },
] as const;

const cardClass =
	"group relative h-auto min-w-0 flex-col whitespace-normal rounded-xl border p-3 text-foreground shadow-none hover:bg-bg-muted/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 data-[state=checked]:ring-1 data-[state=checked]:ring-primary/20 motion-reduce:transition-none motion-reduce:active:scale-100";

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
		<RadioGroup.Root
			value={value}
			onValueChange={(next) => {
				const preset = SKIN_PRESETS.find((item) => item.id === next);
				if (preset) onPick(preset.id);
			}}
			aria-label={t("settings.accent")}
			className="grid w-full grid-cols-2 gap-3 @2xl:grid-cols-3"
		>
			{SKIN_PRESETS.map((preset) => {
				const surface = preset.previewSurfaces;
				return (
					<RadioGroup.Item key={preset.id} value={preset.id} asChild>
						<Button variant="outline" title={t(preset.descKey)} className={cn(cardClass, "gap-3 px-4 pb-3 pt-4")}>
							<span aria-hidden="true" className="flex w-full items-center justify-center gap-4 py-1">
								<span className="size-12 rounded-full border border-white/60 shadow-sm @2xl:size-14" style={{ background: `radial-gradient(circle at 70% 25%, ${surface.accent} 0%, transparent 65%), radial-gradient(circle at 25% 80%, ${surface.border}, ${surface.panel} 70%)` }} />
								<span className="size-12 rounded-full border border-white/15 shadow-sm @2xl:size-14" style={{ background: `radial-gradient(circle at 30% 75%, ${surface.accent} 0%, transparent 70%), radial-gradient(circle at 75% 20%, ${surface.border} 0%, #18191f 65%)` }} />
							</span>
							<span className="flex w-full items-center justify-between gap-2 text-control">
								<span>{t(preset.labelKey)}</span>
								<Check aria-hidden="true" className={cn("size-4 shrink-0 text-primary", value !== preset.id && "invisible")} />
							</span>
						</Button>
					</RadioGroup.Item>
				);
			})}
			{value === "custom" && (
				<RadioGroup.Item value="custom" asChild>
					<Button variant="outline" className={cn(cardClass, "border-dashed")}>
						{t("settings.skin.custom")}
						<Check className="size-4 text-primary" aria-hidden="true" />
					</Button>
				</RadioGroup.Item>
			)}
		</RadioGroup.Root>
	);
});
