import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../../../lib/ease";
import { useId, useState } from "react";
import { useSetAtom } from "jotai";
import { Activity, Bell, Brush, ChartColumnBig, Clapperboard, Cloud, DatabaseBackup, Eye, FileCode2, GitBranch, ImageIcon, Keyboard, MessageSquare, Network, PawPrint, Puzzle, Search, Settings2, TerminalSquare, Trash2, Wrench, X, type LucideIcon } from "lucide-react";
import { settingsFocusAtom, type SettingsTabId } from "../../../atoms";
import { t } from "../../../i18n";
import { Input } from "../../ui-shadcn/input";
import { Button } from "../../ui-shadcn/button";
import { TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import type { SettingsTabLayoutEntry } from "./settingsTabLayout";
import { resolveSettingsNavigation } from "./settingsNavigationSearch";

const MotionTabsList = motion.create(TabsList);

const TAB_ICONS: Record<SettingsTabId, LucideIcon> = {
	common: Settings2,
	appearance: Brush,
	shortcuts: Keyboard,
	notification: Bell,
	terminal: TerminalSquare,
	git: GitBranch,
	editors: FileCode2,
	vision: Eye,
	imagegen: ImageIcon,
	videogen: Clapperboard,
	cloudmemory: Cloud,
	proxy: Network,
	im: MessageSquare,
	hostplugins: Puzzle,
	pet: PawPrint,
	usage: ChartColumnBig,
	process: Activity,
	storage: Trash2,
	backup: DatabaseBackup,
	dev: Wrench,
};

/** Radix handles Escape in document capture before the input can clear its query. */
export function preventSettingsSearchDismiss(event: KeyboardEvent): void {
	if (event.target instanceof HTMLInputElement && event.target.hasAttribute("data-settings-search") && event.target.value) event.preventDefault();
}

/** Settings-only navigation owns its search state; selection and draft state stay in the modal. */
export function SettingsNavigation({ activeTab, tabs, dirtyTabs, hasPendingUpdate }: { activeTab: SettingsTabId; tabs: readonly SettingsTabLayoutEntry[]; dirtyTabs: ReadonlySet<string>; hasPendingUpdate: boolean }) {
	const highlightId = useId();
	const reduceMotion = useReducedMotion();
	const [query, setQuery] = useState("");
	const setFocus = useSetAtom(settingsFocusAtom);
	const groups = resolveSettingsNavigation(tabs, query, t);
	return (
		<aside aria-label={t("settings.navigationLabel")} className="flex min-h-0 w-[216px] shrink-0 flex-col border-r border-border-subtle/60 bg-[radial-gradient(ellipse_at_top_left,var(--color-accent-soft),transparent_70%)] max-[820px]:w-[176px] [[data-bg-image=on]_&]:bg-none">
			<div className="relative mx-3 my-3 shrink-0">
				<Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
				<Input
					data-settings-search=""
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" && query) {
							event.preventDefault();
							event.stopPropagation();
							setQuery("");
						}
					}}
					placeholder={t("settings.searchPlaceholder")}
					aria-label={t("settings.searchPlaceholder")}
					className="h-9 rounded-lg pl-8 pr-8 text-control"
				/>
				{query && (
					<Button variant="ghost" size="icon-xs" className="absolute right-1.5 top-1.5" onClick={() => setQuery("")} aria-label={t("common.clear")}>
						<X className="size-3" />
					</Button>
				)}
			</div>
			<MotionTabsList layoutScroll aria-label={t("settings.navigationLabel")} className="settings-tabs min-h-0 flex-1 flex-col items-stretch justify-start gap-5 overflow-y-auto rounded-none border-0 bg-transparent px-3 pb-5 pt-1">
				{groups.map((group) => (
					<div key={group.id} className="flex shrink-0 flex-col gap-0.5">
						<h3 className="mb-1 px-2.5 py-1.5 text-caption font-medium text-muted-foreground">{t(group.labelKey)}</h3>
						{group.items.map((tab) => {
							const Icon = TAB_ICONS[tab.id];
							return (
								<div key={tab.id} className="flex shrink-0 flex-col">
									<TabsTrigger value={tab.id} className="group relative isolate h-9 w-full shrink-0 justify-start gap-2 rounded-lg px-2.5 text-control font-medium hover:bg-bg-hover data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none">
										{activeTab === tab.id && <motion.span aria-hidden="true" data-settings-highlight="" layoutId={reduceMotion ? undefined : highlightId} initial={false} transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE_OUT }} className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-bg-active" />}
										<Icon className="size-4 shrink-0 text-muted-foreground group-data-[state=active]:text-primary" aria-hidden="true" />
										<span className="truncate">{tab.label}</span>
										<span className="ml-auto flex items-center gap-1">
											{tab.id === "dev" && hasPendingUpdate && <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />}
											{dirtyTabs.has(tab.id) && <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
										</span>
									</TabsTrigger>
									{tab.fields.map((field) => (
										<Button key={field.slug} variant="ghost" className="h-auto min-h-8 justify-start whitespace-normal rounded-md py-1.5 pl-9 pr-2 text-left text-caption font-normal text-muted-foreground" onClick={() => setFocus({ tab: field.tab, section: field.slug })}>
											{t(field.labelKey)}
										</Button>
									))}
								</div>
							);
						})}
					</div>
				))}
				{groups.length === 0 && (
					<p role="status" className="px-2.5 py-4 text-caption text-muted-foreground">
						{t("settings.searchEmpty")}
					</p>
				)}
			</MotionTabsList>
		</aside>
	);
}
