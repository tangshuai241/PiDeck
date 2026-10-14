/**
 * 个人工作台的导航策略与本地缓存（纯函数，可在无 React 环境下单测）。
 *
 * 状态归属：页面身份、返回目标、分组折叠态各自的 owner 在
 * `atoms/personal-workbench-atoms.ts`；本文件只放「给定输入 → 决策」的规则，
 * 以及 localStorage 首屏缓存（settings.json 是权威来源，见侧栏分组的双写）。
 *
 * 刻意不复用 `sidebarNavTab.ts`：会话分段是「看哪类会话」，这里是「看会话还是看功能页」，
 * 两份状态混成一份会让返回原会话被后续会话切换污染。
 */
import type { PersonalWorkbenchPageId, PersonalWorkbenchReturnTarget } from "../../../shared/types/personalWorkbench";

export const PERSONAL_WORKBENCH_COLLAPSED_STORAGE_KEY = "pid:personal-workbench-collapsed";

/** 缺省展开：用户第一次见到侧栏时要知道这里有哪些入口，收起是后续选择。 */
export const DEFAULT_PERSONAL_WORKBENCH_COLLAPSED = false;

/** 只需要读写的存储替身（localStorage 或测试用的内存实现）。 */
export type PersonalWorkbenchStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * 折叠态解析：settings.json 存布尔，localStorage 存字符串，两种来源都要认。
 * 其它值（旧版脏数据、手工改坏）返回 null，由调用方决定回落默认。
 */
export function parsePersonalWorkbenchCollapsed(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return null;
}

export function readPersonalWorkbenchCollapsed(storage?: PersonalWorkbenchStorage): boolean | null {
	if (!storage) return null;
	try {
		return parsePersonalWorkbenchCollapsed(storage.getItem(PERSONAL_WORKBENCH_COLLAPSED_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function writePersonalWorkbenchCollapsed(storage: PersonalWorkbenchStorage | undefined, collapsed: boolean): void {
	if (!storage) return;
	try {
		storage.setItem(PERSONAL_WORKBENCH_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
	} catch {
		// localStorage 不可用时静默忽略；settings.json 仍会落盘
	}
}

/** 会话/项目身份的比较键：功能页收起判定的唯一基准（undefined 与空串同义）。 */
export function personalWorkbenchScopeKey(scope: { projectId?: string; sessionId?: string }): string {
	return `${scope.projectId ?? ""}|${scope.sessionId ?? ""}`;
}

/**
 * 会话/项目身份变化时是否收起功能页。
 *
 * 规则与页面式插件面板一致：用户点侧栏另一个会话，意图是看那个会话，覆盖层不能反着盖住它。
 * `previousScopeKey` 为 undefined 表示「首次挂载记录身份」，不是用户切换，不收起。
 */
export function shouldClosePersonalWorkbenchOnScopeChange(previousScopeKey: string | undefined, nextScopeKey: string): boolean {
	return previousScopeKey !== undefined && previousScopeKey !== nextScopeKey;
}

export type PersonalWorkbenchReturnDecision = { kind: "restore"; projectId: string; sessionId: string } | { kind: "close" };

/**
 * 「返回聊天」的决策。
 *
 * - 没有返回目标（打开时无当前会话）→ 直接收起；
 * - 目标会话就是当前会话 → 直接收起（会话视图一直挂在覆盖层下面，草稿/滚动/终端内存态原样保留，
 *   此时再调一次会话打开只是多余动作，还可能把预览 Tab 晋升成常驻）；
 * - 目标会话已不是当前会话（期间用户切过会话）→ 走一次正常的会话打开，等同在侧栏点它。
 */
export function resolvePersonalWorkbenchReturn(input: { target: PersonalWorkbenchReturnTarget | null; currentProjectId?: string; currentSessionId?: string }): PersonalWorkbenchReturnDecision {
	const { target, currentProjectId, currentSessionId } = input;
	if (!target) return { kind: "close" };
	if (target.projectId === currentProjectId && target.sessionId === currentSessionId) return { kind: "close" };
	return { kind: "restore", projectId: target.projectId, sessionId: target.sessionId };
}

/** 点侧栏入口的语义：点已打开的那个入口 = 返回聊天；点另一个入口 = 切页。 */
export function resolvePersonalWorkbenchEntryAction(input: { openPageId: PersonalWorkbenchPageId | null; entryPageId: PersonalWorkbenchPageId }): "open" | "return" {
	return input.openPageId === input.entryPageId ? "return" : "open";
}

export type OverlayPageMutexDecision = "close-personal-workbench" | "close-host-plugin-page" | "none";

/**
 * 会话区覆盖层互斥：个人工作台功能页与「页面式」宿主插件面板不能同时呈现。
 *
 * 两个页面式覆盖层都是 `absolute inset-0`，同时存在时后开的会被先开的盖住（或相反），
 * 用户点侧栏入口就会「看不到反应」。规则是后打开的一方赢得会话区，
 * 所以这里按「本帧刚刚打开的是哪一方」决定收谁：
 *
 * - 上一帧两方不同时开启（不变量由本函数维持），所以两边都开时必然只有一边是刚打开的；
 * - 功能页刚打开 → 收插件页；插件页刚打开 → 收功能页；
 * - 两边都「没变化」却同时开着（异常状态，不变量被破坏）→ 收插件页，让功能页保持可见；
 * - 任一方未开 → 无需动作。
 *
 * 入参只接受「页面式」信号：modal / popover 插件面板是独立的 Dialog 层（HostPluginPanelHost），
 * 允许盖在功能页之上，关闭后回到原功能页，所以不得被当成页面式面板收掉。
 * 调用方用 `useHostPluginPageTab()`（已是 `presentation === "page"` 的纯查询）提供该信号。
 */
export function resolveOverlayPageMutex(input: { pageOpen: boolean; hostPluginPageOpen: boolean; previousPageOpen: boolean; previousHostPluginPageOpen: boolean }): OverlayPageMutexDecision {
	if (!input.pageOpen || !input.hostPluginPageOpen) return "none";
	const personalWorkbenchJustOpened = !input.previousPageOpen;
	const hostPluginPageJustOpened = !input.previousHostPluginPageOpen;
	// 只有「插件页刚开、功能页原本就开着」才收功能页；其余两边都开的情形一律收插件页——
	// 包括功能页刚开（正常路径）与同帧内两方都新开（异常，不可能来自两次用户操作）。
	if (hostPluginPageJustOpened && !personalWorkbenchJustOpened) return "close-personal-workbench";
	return "close-host-plugin-page";
}
