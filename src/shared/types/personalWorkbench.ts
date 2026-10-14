/**
 * 个人工作台（左侧功能区 + 中间原生页面容器）的导航契约。
 *
 * P01 只落地导航：页面身份、可用性状态与「返回原会话」的目标快照。
 * 待办 / 阅读的数据身份（事项、书籍、阅读位置、笔记）属于后续阶段，不在本文件预置——
 * 导航层提前固化未确认的数据结构，会让后续接数据源时被迫跟着改导航契约。
 *
 * 与宿主插件 page 面板的区别：那是插件声明的页面，身份在插件清单里；这里是 TPA 自有的
 * 固定功能页，身份由此处的联合类型给出，渲染层不认组件名或路由字符串。
 */

/**
 * 固定功能页身份。数组顺序即左侧菜单的展示顺序（阅读、待办），
 * 新增功能页只在此处加一项，侧栏与页面容器同时生效。
 */
export const PERSONAL_WORKBENCH_PAGE_IDS = ["reading", "todo"] as const;

export type PersonalWorkbenchPageId = (typeof PERSONAL_WORKBENCH_PAGE_IDS)[number];

/**
 * 页面数据可用性。
 *
 * - `not-connected`：数据源尚未接入（P01 两个页面都是这个状态）。界面必须显式说明未接入，
 *   不得展示示例/伪造记录，也不得让用户输入账号来「接通」。
 * - `ready`：数据源可用，页面可以读写真实记录。
 * - `unavailable`：数据源存在但当前不可用（服务不可达等）。与 `not-connected` 分开，
 *   因为文案与恢复动作不同：前者等开发接入，后者等用户/服务恢复。
 */
export type PersonalWorkbenchAvailability = "not-connected" | "ready" | "unavailable";

/**
 * 打开功能页时记下的返回目标：返回聊天时用来恢复原会话。
 * 只有会话身份齐备时才记录——没有当前会话时返回目标为空，返回动作退化为「直接收起」，
 * 底下的空态/引导页本来就没被卸载。
 */
export type PersonalWorkbenchReturnTarget = {
	projectId: string;
	sessionId: string;
};

export function isPersonalWorkbenchPageId(value: unknown): value is PersonalWorkbenchPageId {
	return typeof value === "string" && (PERSONAL_WORKBENCH_PAGE_IDS as readonly string[]).includes(value);
}

/** 解析磁盘/localStorage 里的页面 id；未知值与非法类型一律返回 null（调用方按「未打开」处理）。 */
export function parsePersonalWorkbenchPageId(value: unknown): PersonalWorkbenchPageId | null {
	return isPersonalWorkbenchPageId(value) ? value : null;
}
