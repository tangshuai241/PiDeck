/**
 * 侧栏「个人工作台」分组：可折叠标题栏 + 阅读 / 待办两个入口。
 *
 * 位置在会话分段（活动/聊天/项目）之上、独立成一个区，会话列表与底部设置不受影响。
 * 入口是导航开关而不是页面本体：点已打开的那个入口返回聊天，点另一个切换功能页；
 * 已有数据源接入后，页面容器在会话区呈现具体内容。
 *
 * 未接入状态外露在入口角标上（方案要求：入口名称与空状态不得把未接入能力显示成已迁移），
 * 所以这里不隐藏未接入的功能，而是明确标注。
 */
import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { desktopApi } from "../../desktopApi";
import { usePersonalWorkbenchNavigation, usePersonalWorkbenchSection, type PersonalWorkbenchScope } from "../../hooks/usePersonalWorkbench";
import { PERSONAL_WORKBENCH_PAGES, personalWorkbenchBadgeKey } from "./personalWorkbenchPages";

/** 入口行：与会话行同尺寸同圆角（新学旧），选中态用「活动面」而不是描边。 */
const entryRowClass =
	"flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 text-left text-body text-foreground transition-[background-color,border-color] duration-base hover:border-border-subtle hover:bg-muted/60 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

export function PersonalWorkbenchSection(props: {
	currentProjectId?: string;
	currentSessionId?: string;
	/** 首次 settings.get 已完成：此前不合并 settings 里的折叠态，避免迟到响应回盖用户首屏选择 */
	settingsLoaded: boolean;
	/** settings.json 保存的分组折叠态（权威来源） */
	settingsCollapsed?: boolean;
	/** 返回原会话用的会话打开动作（与侧栏点会话同一条路径） */
	openSession?: (projectId: string, sessionId: string) => void | Promise<void>;
}) {
	// 折叠态与页面选择的落盘都串行化：快速连点/连续切换时避免旧请求最后完成覆盖新值
	const sectionSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const { collapsed, toggleCollapsed } = usePersonalWorkbenchSection({
		settingsLoaded: props.settingsLoaded,
		settingsCollapsed: props.settingsCollapsed,
		persistCollapsed: (next) => {
			sectionSaveQueueRef.current = sectionSaveQueueRef.current
				.catch(() => undefined)
				.then(() => desktopApi.settings.update({ personalWorkbenchCollapsed: next }))
				.catch(() => undefined);
		},
	});
	const { pageId, selectEntry } = usePersonalWorkbenchNavigation({ openSession: props.openSession });
	const scope: PersonalWorkbenchScope = { projectId: props.currentProjectId, sessionId: props.currentSessionId };

	return (
		<section className="flex shrink-0 flex-col gap-0.5 pb-2" aria-label={t("personalWorkbench.title")}>
			<button
				type="button"
				className="flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-caption font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
				aria-expanded={!collapsed}
				aria-label={collapsed ? t("personalWorkbench.expand") : t("personalWorkbench.collapse")}
				title={collapsed ? t("personalWorkbench.expand") : t("personalWorkbench.collapse")}
				onClick={toggleCollapsed}
			>
				<ChevronRight size={14} className={cn("shrink-0 transition-transform", !collapsed && "rotate-90")} aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate">{t("personalWorkbench.title")}</span>
			</button>
			{!collapsed && (
				<div className="flex flex-col gap-0.5">
					{PERSONAL_WORKBENCH_PAGES.map((page) => {
						const selected = page.id === pageId;
						const badgeKey = personalWorkbenchBadgeKey(page.availability);
						const Icon = page.icon;
						const label = badgeKey ? `${t(page.titleKey)} · ${t(badgeKey)}` : t(page.titleKey);
						return (
							<button
								key={page.id}
								type="button"
								className={cn(entryRowClass, selected && "bg-bg-active text-foreground")}
								// 选中态用 aria-current：这些入口切的是「当前呈现的页面」而不是开关
								aria-current={selected ? "page" : undefined}
								aria-label={label}
								title={t(page.summaryKey)}
								onClick={() => selectEntry(page.id, scope)}
							>
								<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{t(page.titleKey)}</span>
								{badgeKey && <span className="shrink-0 rounded-sm border border-border/60 px-1 text-micro text-muted-foreground">{t(badgeKey)}</span>}
							</button>
						);
					})}
				</div>
			)}
		</section>
	);
}
