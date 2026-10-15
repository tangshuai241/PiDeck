import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Blocks, Cpu, FileCode2, FileText, KeyRound, PlugZap, Puzzle, Search, Settings2, Shield, ShieldCheck, Sparkles, X, type LucideIcon } from "lucide-react";
import { t } from "../i18n";
import { EASE_OUT } from "../lib/ease";
import { Input } from "../components/ui-shadcn/input";
import { Button } from "../components/ui-shadcn/button";
import { TabsList, TabsTrigger } from "../components/ui-shadcn/tabs";

const MotionTabsList = motion.create(TabsList);
type NavigationItem = { value: string; label: string; icon: LucideIcon };

/** Only presentation lives here; ConfigPane keeps selection, scope and unsaved drafts. */
export function ConfigNavigation({ activeValue, resourceOnly, pages, dirtyTabs }: { activeValue: string; resourceOnly: boolean; pages: readonly { value: string; label: string }[]; dirtyTabs: ReadonlySet<string> }) {
	const [query, setQuery] = useState("");
	const highlightId = useId();
	const reduceMotion = useReducedMotion();
	const configItems: NavigationItem[] = [
		{ value: "config:models", label: t("config.nav.models"), icon: Cpu },
		{ value: "config:auth", label: t("config.nav.auth"), icon: KeyRound },
		{ value: "config:settings", label: t("config.nav.settings"), icon: Settings2 },
		{ value: "config:trust", label: t("config.nav.trust"), icon: ShieldCheck },
		{ value: "config:mcp", label: t("config.nav.mcp"), icon: PlugZap },
		{ value: "config:raw", label: t("config.nav.raw"), icon: FileCode2 },
	];
	const agentItems: NavigationItem[] = [
		...(!resourceOnly ? [{ value: "security", label: t("config.nav.security"), icon: Shield }] : []),
		{ value: "extensions", label: t("config.nav.extensions"), icon: Puzzle },
		...(resourceOnly ? [{ value: "mcp", label: t("config.nav.mcp"), icon: PlugZap }] : []),
		{ value: "skills", label: t("config.nav.skills"), icon: Sparkles },
		{ value: "prompts", label: t("config.nav.prompts"), icon: FileText },
		...pages.map((page) => ({ ...page, icon: Blocks })),
	];
	const groups = [...(!resourceOnly ? [{ label: t("config.group.config"), items: configItems }] : []), { label: t("config.group.agent"), items: agentItems }]
		.map((group) => ({ ...group, items: group.items.filter((item) => `${group.label} ${item.label}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) }))
		.filter((group) => group.items.length > 0);
	return (
		<aside className="config-sidebar flex min-h-0 w-[216px] shrink-0 flex-col border-r border-border-subtle/60 bg-[radial-gradient(ellipse_at_top_left,var(--color-accent-soft),transparent_70%)] max-[820px]:w-[176px] [[data-bg-image=on]_&]:bg-none">
			<div className="relative mx-3 my-3 shrink-0">
				<Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
				<Input
					data-settings-search=""
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("settings.searchPlaceholder")}
					aria-label={t("settings.searchPlaceholder")}
					className="h-9 rounded-lg pl-8 pr-8 text-control"
					onKeyDown={(event) => {
						if (event.key === "Escape" && query) {
							event.preventDefault();
							event.stopPropagation();
							setQuery("");
						}
					}}
				/>
				{query && (
					<Button variant="ghost" size="icon-xs" className="absolute right-1.5 top-1.5" onClick={() => setQuery("")} aria-label={t("common.clear")}>
						<X className="size-3" />
					</Button>
				)}
			</div>
			<MotionTabsList layoutScroll aria-label={t("config.title")} className="min-h-0 flex-1 flex-col items-stretch justify-start gap-5 overflow-y-auto rounded-none border-0 bg-transparent px-3 pb-5 pt-1">
				{groups.map((group) => (
					<div key={group.label} className="config-sidebar-group flex shrink-0 flex-col gap-0.5">
						<h3 className="mb-1 px-2.5 py-1.5 text-caption font-medium text-muted-foreground">{group.label}</h3>
						{group.items.map(({ value, label, icon: Icon }) => (
							<TabsTrigger key={value} value={value} className="config-nav-btn group relative isolate h-9 w-full shrink-0 justify-start gap-2 rounded-lg px-2.5 text-control font-medium hover:bg-bg-hover data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none">
								{activeValue === value && <motion.span aria-hidden="true" data-settings-highlight="" layoutId={reduceMotion ? undefined : highlightId} initial={false} transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE_OUT }} className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-bg-active" />}
								<Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-data-[state=active]:text-primary" />
								<span className="truncate">{label}</span>
								{(dirtyTabs.has(value) || dirtyTabs.has(value.replace(/^config:/, ""))) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />}
							</TabsTrigger>
						))}
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
