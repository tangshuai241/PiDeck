/**
 * 个人工作台导航：打开/收起功能页、记下返回会话、身份变化时自动收起，以及侧栏分组的折叠态。
 *
 * 为什么是 hook 而不是把逻辑摊在组件里：侧栏入口与中间页面容器是同一份导航状态的两个出口，
 * 规则（点已打开的入口 = 返回聊天、会话身份变化 = 收起、返回时是否需要恢复会话）必须只有一份实现。
 * 状态本身在 `atoms/personal-workbench-atoms.ts`；这里只给动作与生命周期，不新开第二份状态。
 */
import { useCallback, useEffect, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";
import type { PersonalWorkbenchPageId, PersonalWorkbenchReturnTarget } from "../../../shared/types/personalWorkbench";
import { personalWorkbenchPageAtom, personalWorkbenchReturnTargetAtom, personalWorkbenchSectionCollapsedAtom } from "../atoms/personal-workbench-atoms";
import { parsePersonalWorkbenchCollapsed, personalWorkbenchScopeKey, resolvePersonalWorkbenchEntryAction, resolvePersonalWorkbenchReturn, shouldClosePersonalWorkbenchOnScopeChange, writePersonalWorkbenchCollapsed, type PersonalWorkbenchStorage } from "../utils/personalWorkbenchNav";

/** 触发/校验功能页的会话身份（打开时记下、返回时比对）。 */
export type PersonalWorkbenchScope = { projectId?: string; sessionId?: string };

/** 只有会话身份齐备时才记录返回目标：没有会话时「返回」退化为直接收起覆盖层。 */
export function personalWorkbenchReturnTargetOf(scope: PersonalWorkbenchScope): PersonalWorkbenchReturnTarget | null {
	if (!scope.projectId || !scope.sessionId) return null;
	return { projectId: scope.projectId, sessionId: scope.sessionId };
}

export type PersonalWorkbenchNavigation = {
	/** 当前打开的功能页；null = 呈现会话 */
	pageId: PersonalWorkbenchPageId | null;
	/** 打开指定功能页，并记下打开时的会话身份作为返回目标 */
	openPage: (pageId: PersonalWorkbenchPageId, scope: PersonalWorkbenchScope) => void;
	/** 点侧栏入口：已打开的那个 = 返回聊天，另一个 = 切页 */
	selectEntry: (pageId: PersonalWorkbenchPageId, scope: PersonalWorkbenchScope) => void;
	/** 收起功能页并清空返回目标（不触达会话） */
	closePage: () => void;
	/** 返回聊天：必要时先恢复到打开时记下的会话 */
	returnToSession: (scope: PersonalWorkbenchScope) => void;
};

export function usePersonalWorkbenchNavigation(options: { openSession?: (projectId: string, sessionId: string) => void | Promise<void> } = {}): PersonalWorkbenchNavigation {
	const [pageId, setPageId] = useAtom(personalWorkbenchPageAtom);
	const [returnTarget, setReturnTarget] = useAtom(personalWorkbenchReturnTargetAtom);
	// 会话打开动作来自 App（每次渲染都是新引用），存 ref 让三个动作保持稳定引用
	const openSessionRef = useRef(options.openSession);
	openSessionRef.current = options.openSession;

	const openPage = useCallback(
		(nextPageId: PersonalWorkbenchPageId, scope: PersonalWorkbenchScope) => {
			setPageId(nextPageId);
			setReturnTarget(personalWorkbenchReturnTargetOf(scope));
		},
		[setPageId, setReturnTarget],
	);

	const closePage = useCallback(() => {
		setPageId(null);
		setReturnTarget(null);
	}, [setPageId, setReturnTarget]);

	// selectEntry 建在 returnToSession 之后：点当前入口走的就是「返回聊天」这条路径（含必要的会话恢复），
	// 不在调用方再判一次，否则侧栏入口与页面返回键会变成两套行为。
	const returnToSession = useCallback(
		(scope: PersonalWorkbenchScope) => {
			const decision = resolvePersonalWorkbenchReturn({ target: returnTarget, currentProjectId: scope.projectId, currentSessionId: scope.sessionId });
			closePage();
			// 会话视图一直挂在覆盖层下面（覆盖层非模态、不卸载会话树），
			// 所以「返回」对当前会话就是收起覆盖层；只有目标会话已不是当前会话时才需要重新打开一次。
			if (decision.kind === "restore") void openSessionRef.current?.(decision.projectId, decision.sessionId);
		},
		[returnTarget, closePage],
	);

	const selectEntry = useCallback(
		(entryPageId: PersonalWorkbenchPageId, scope: PersonalWorkbenchScope) => {
			if (resolvePersonalWorkbenchEntryAction({ openPageId: pageId, entryPageId }) === "return") {
				returnToSession(scope);
				return;
			}
			openPage(entryPageId, scope);
		},
		[pageId, returnToSession, openPage],
	);

	return { pageId, openPage, selectEntry, closePage, returnToSession };
}

/**
 * 会话/项目身份变化时收起功能页（与页面式插件面板同规则）。
 *
 * 挂载在 App 层常驻的覆盖层上：用户点侧栏另一个会话，意图是看那个会话，
 * 覆盖层不能反着盖住新会话。首次挂载只记录身份，不把初始会话当成切换。
 */
export function usePersonalWorkbenchScopeGuard(scope: PersonalWorkbenchScope): void {
	const setPageId = useSetAtom(personalWorkbenchPageAtom);
	const setReturnTarget = useSetAtom(personalWorkbenchReturnTargetAtom);
	const lastScopeKeyRef = useRef<string | undefined>(undefined);
	const nextScopeKey = personalWorkbenchScopeKey(scope);
	useEffect(() => {
		if (shouldClosePersonalWorkbenchOnScopeChange(lastScopeKeyRef.current, nextScopeKey)) {
			setPageId(null);
			setReturnTarget(null);
		}
		lastScopeKeyRef.current = nextScopeKey;
	}, [nextScopeKey, setPageId, setReturnTarget]);
}

export type PersonalWorkbenchSectionOptions = {
	/** 首次 settings.get 已完成；此前不合并 settings 值，避免迟到的响应覆盖用户首屏刚点的折叠 */
	settingsLoaded: boolean;
	/** settings.json 保存的折叠态（权威来源）；缺省/非法时保留 localStorage 首屏值 */
	settingsCollapsed?: boolean;
	/** 落盘 settings.json；调用方负责串行化（快速连点折叠时避免旧请求最后完成覆盖新值） */
	persistCollapsed: (collapsed: boolean) => void;
	storage?: PersonalWorkbenchStorage;
};

export type PersonalWorkbenchSectionState = { collapsed: boolean; toggleCollapsed: () => void };

/** 侧栏「个人工作台」分组的折叠态：localStorage 首屏缓存 + settings.json 可靠落盘（双写）。 */
export function usePersonalWorkbenchSection(options: PersonalWorkbenchSectionOptions): PersonalWorkbenchSectionState {
	const [collapsed, setCollapsed] = useAtom(personalWorkbenchSectionCollapsedAtom);
	const collapsedRef = useRef(collapsed);
	collapsedRef.current = collapsed;
	/** 已合并过 settings.json 的折叠态：防止迟到的 settings 覆盖用户刚点的选择 */
	const hydratedRef = useRef(false);
	const persistRef = useRef(options.persistCollapsed);
	persistRef.current = options.persistCollapsed;
	const storage = options.storage ?? (typeof window === "undefined" ? undefined : window.localStorage);

	const toggleCollapsed = useCallback(() => {
		const next = !collapsedRef.current;
		// 用户点选即视为权威已应用（与侧栏分段的 navTab 同策略）
		hydratedRef.current = true;
		collapsedRef.current = next;
		setCollapsed(next);
		writePersonalWorkbenchCollapsed(storage, next);
		persistRef.current(next);
	}, [setCollapsed, storage]);

	useEffect(() => {
		if (hydratedRef.current || !options.settingsLoaded) return;
		hydratedRef.current = true;
		const parsed = parsePersonalWorkbenchCollapsed(options.settingsCollapsed);
		if (parsed === null || parsed === collapsedRef.current) return;
		collapsedRef.current = parsed;
		setCollapsed(parsed);
		writePersonalWorkbenchCollapsed(storage, parsed);
	}, [options.settingsLoaded, options.settingsCollapsed, setCollapsed, storage]);

	return { collapsed, toggleCollapsed };
}
