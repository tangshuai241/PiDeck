/**
 * 个人工作台的渲染层状态（单一 owner）。
 *
 * 三份状态刻意分开、也刻意与会话导航 atom 分开：
 * - 这是「当前呈现哪个功能页」，而 `session-atoms` 的 currentSessionId 是「当前会话是谁」；
 *   合成一份会让功能页开关污染会话身份（返回原会话时就没法区分「用户切了会话」和「页面开着」）。
 * - 返回目标同样是快照而不是引用：打开功能页时的会话身份要固定下来，之后会话切换不能改写它。
 */
import { atom } from "jotai";
import type { PersonalWorkbenchPageId, PersonalWorkbenchReturnTarget } from "../../../shared/types/personalWorkbench";
import { DEFAULT_PERSONAL_WORKBENCH_COLLAPSED, readPersonalWorkbenchCollapsed } from "../utils/personalWorkbenchNav";

/**
 * 当前打开的功能页；null = 呈现会话。
 *
 * 刻意不做持久化：重启后应当回到会话，功能页不是恢复对象（与设置页、插件的弹层同策略）。
 */
export const personalWorkbenchPageAtom = atom<PersonalWorkbenchPageId | null>(null);

/** 打开功能页时记下的返回目标；页面关闭时一并清空（与 personalWorkbenchPageAtom 配对）。 */
export const personalWorkbenchReturnTargetAtom = atom<PersonalWorkbenchReturnTarget | null>(null);

/**
 * 侧栏「个人工作台」分组的折叠态：localStorage 作首屏同步缓存，
 * settings.json 作跨进程可靠落盘（dev 强杀时 localStorage 可能来不及写入），
 * 与 `sidebarNavTabAtom` 同款双写策略。
 */
export const personalWorkbenchSectionCollapsedAtom = atom<boolean>(readPersonalWorkbenchCollapsed(typeof window === "undefined" ? undefined : window.localStorage) ?? DEFAULT_PERSONAL_WORKBENCH_COLLAPSED);
