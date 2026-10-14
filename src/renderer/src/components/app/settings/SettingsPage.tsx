import type { ComponentProps } from "react";
import type { SettingsTabId } from "../../../atoms";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { TabsContent } from "../../ui-shadcn/tabs";
import { SETTINGS_TAB_LABEL_KEYS } from "./settingsTabLayout";

/** Shared settings canvas keeps navigation, headings and control density consistent. */
export function SettingsPage({ value, children, className, ...props }: Omit<ComponentProps<typeof TabsContent>, "value"> & { value: SettingsTabId }) {
	return (
		<TabsContent
			value={value}
			{...props}
			className={cn(
				"settings-panel min-h-0 min-w-0 overflow-y-auto bg-settings-canvas px-8 py-7 text-foreground max-[820px]:px-4 [&_[data-slot=select-trigger]]:h-[34px] [&_[data-slot=select-trigger]]:border-transparent [&_[data-slot=select-trigger]]:bg-settings-control [&_[data-slot=select-trigger]]:shadow-none",
				className,
			)}
		>
			<div className="motion-safe:animate-[settings-content-enter_220ms_cubic-bezier(0.16,1,0.3,1)]">
				<h2 className="mb-6 text-heading font-semibold tracking-tight">{t(SETTINGS_TAB_LABEL_KEYS[value])}</h2>
				{children}
			</div>
		</TabsContent>
	);
}
