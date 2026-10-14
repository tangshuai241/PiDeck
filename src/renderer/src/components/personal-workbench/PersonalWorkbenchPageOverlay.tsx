/**
 * 个人工作台的页面容器：功能页以非模态覆盖层铺在工作区会话列上。
 *
 * 关键约定（与页面式插件面板同款，导航需求直接依赖它们）：
 * - 覆盖层只是「盖在上面」，会话树与会话视图不卸载：草稿、滚动位置、终端等内存态原样保留，
 *   底层 pi 运行时继续工作——切页不停止也不重启 Agent。
 * - 会话/项目身份变化时自动收起（usePersonalWorkbenchScopeGuard）：用户点侧栏另一个会话，
 *   意图是看那个会话，覆盖层不能反着盖住新会话。
 * - 只与「页面式」插件面板互斥（resolveOverlayPageMutex + useHostPluginPageTab）：两个
 *   absolute inset-0 页面同时呈现会互相遮盖，用户会以为入口「点了没反应」。modal / popover
 *   插件面板是独立 Dialog 层，允许盖在功能页之上，关闭后回到原功能页。
 * - 焦点隔离：开页时焦点移到「返回会话」，被遮会话列由 Stage 置 inert（Tab 进不去、
 *   也点不到）；关闭时把焦点还给可见会话（详见下方焦点交接 effect）。
 */
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { personalWorkbenchPageAtom } from "../../atoms/personal-workbench-atoms";
import { usePersonalWorkbenchNavigation, usePersonalWorkbenchScopeGuard } from "../../hooks/usePersonalWorkbench";
import { useHostPluginPageTab } from "../../hooks/useHostPluginPageTab";
import { resolveOverlayPageMutex } from "../../utils/personalWorkbenchNav";
import { PersonalWorkbenchPageBody } from "./PersonalWorkbenchPageBody";
import { personalWorkbenchBadgeKey, personalWorkbenchPageById } from "./personalWorkbenchPages";

export function PersonalWorkbenchPageOverlay(props: {
	projectId?: string;
	sessionId?: string;
	/** 返回原会话用的会话打开动作（App 装配，等同在侧栏点那个会话） */
	onRestoreSession?: (projectId: string, sessionId: string) => void | Promise<void>;
	/** 被覆盖层盖住的会话列焦点兜底（Stage 持有）：关闭时由它决定焦点回到会话内的哪个落点 */
	resolveSessionFocusTarget?: (remembered: HTMLElement | null) => HTMLElement | null;
}) {
	const { projectId, sessionId } = props;
	usePersonalWorkbenchScopeGuard({ projectId, sessionId });
	const { pageId, returnToSession } = usePersonalWorkbenchNavigation({ openSession: props.onRestoreSession });
	const setPageId = useSetAtom(personalWorkbenchPageAtom);

	// 互斥只看「页面式」插件面板：useHostPluginPageTab 已把 presentation==="page" 之外的
	// modal/popover 过滤掉，它们允许盖在功能页上，不得被这里收掉。
	const hostPluginPageTab = useHostPluginPageTab();
	const hostPluginPageOpen = hostPluginPageTab !== null;
	const setHostPluginPanel = useSetAtom(hostPluginPanelAtom);
	const overlayPageOpenRef = useRef({ pageOpen: false, hostPluginPageOpen: false });
	useEffect(() => {
		const pageOpen = pageId !== null;
		const previous = overlayPageOpenRef.current;
		overlayPageOpenRef.current = { pageOpen, hostPluginPageOpen };
		const decision = resolveOverlayPageMutex({ pageOpen, hostPluginPageOpen, previousPageOpen: previous.pageOpen, previousHostPluginPageOpen: previous.hostPluginPageOpen });
		if (decision === "close-personal-workbench") setPageId(null);
		else if (decision === "close-host-plugin-page") setHostPluginPanel(null);
	}, [pageId, hostPluginPageOpen, setPageId, setHostPluginPanel]);

	// 焦点交接：开页时先记下当前焦点（通常是触发它的侧栏入口或 composer），再把焦点抢到
	// 「返回会话」；切页（阅读↔待办）同样重新聚焦当前页的返回按钮；关页时交给 Stage 解析出的
	// 会话内落点（原本在会话里的元素优先，否则会话列本身），保证焦点留在用户刚回到的可见会话。
	// 两个边界：切页不重记返回目标（那时焦点在旧返回按钮上，记下来只会指向已卸载节点）；
	// 因后开的页面式插件而收起时不抢焦点，由插件接管。
	const backButtonRef = useRef<HTMLButtonElement | null>(null);
	const focusReturnRef = useRef<HTMLElement | null>(null);
	const pageWasOpenRef = useRef(false);
	useEffect(() => {
		const pageOpen = pageId !== null;
		const wasOpen = pageWasOpenRef.current;
		pageWasOpenRef.current = pageOpen;
		// 页面式插件面板已接管会话列（本页正在被互斥收起）：两侧都不抢焦点，交给插件；
		// 同时清掉记忆，避免插件关闭后又把焦点塞回已经不属于本页的会话列。
		if (hostPluginPageOpen) {
			focusReturnRef.current = null;
			return;
		}
		if (pageOpen) {
			if (!wasOpen) {
				const active = document.activeElement;
				focusReturnRef.current = active instanceof HTMLElement && active !== document.body && active !== backButtonRef.current ? active : null;
			}
			// 切页时当前页的返回按钮不一定还持有焦点（页头被重建或焦点落在被替换的正文节点），
			// 不重新聚焦就会丢到 body。
			backButtonRef.current?.focus({ preventScroll: true });
			return;
		}
		if (!wasOpen) return;
		const remembered = focusReturnRef.current;
		focusReturnRef.current = null;
		props.resolveSessionFocusTarget?.(remembered)?.focus({ preventScroll: true });
	}, [pageId, hostPluginPageOpen, props.resolveSessionFocusTarget]);

	if (!pageId) return null;
	const page = personalWorkbenchPageById(pageId);
	const badgeKey = personalWorkbenchBadgeKey(page.availability);
	const Icon = page.icon;

	return (
		// inset-0 只覆盖工作区会话列：侧栏、右侧抽屉、底部停靠栏保持可交互（非模态）
		<div className="absolute inset-0 z-20 flex flex-col bg-background" role="region" aria-label={t(page.titleKey)}>
			<header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background/95 px-4 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="min-w-0 truncate text-body font-medium text-foreground">{t(page.titleKey)}</span>
					{badgeKey && <span className="shrink-0 rounded-sm border border-border/60 px-1 text-micro text-muted-foreground">{t(badgeKey)}</span>}
				</div>
				{/* 返回聊天：会话视图一直在下面，收起覆盖层即回到原会话；目标会话已变时才重新打开一次 */}
				<Button ref={backButtonRef} variant="ghost" size="sm" className="shrink-0" onClick={() => returnToSession({ projectId, sessionId })}>
					<ArrowLeft className="size-3.5" aria-hidden="true" />
					{t("personalWorkbench.backToSession")}
				</Button>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
				<PersonalWorkbenchPageBody page={page} projectId={projectId} onOpenSession={props.onRestoreSession} />
			</div>
		</div>
	);
}
