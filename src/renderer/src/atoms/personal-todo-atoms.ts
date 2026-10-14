/**
 * 待办页的渲染层状态（单一 owner）：账号作用域、列表快照、筛选、选中项与编辑缓冲。
 *
 * 归属规则（任务规则：状态按账号和事项身份归属）：
 * - 列表与状态是「当前打开页面的快照」，切账号时由 hook 整体重置；
 * - 编辑缓冲按 `账号作用域键::事项 id` 存（`personalTodoDraftKey`），切账号后旧草稿不可达，
 *   仍然留在内存里但不会被发送，也不会显示到新账号的视图上；
 * - 这里不存放任何凭据：账号身份只有 scope（origin/account/cloudInstanceId/accountKey）。
 *
 * 刻意不持久化：草稿与列表都是页面会话内状态；真正需要跨重启保留的待确认内容由主进程
 * 队列与缓存负责（任务规则：页面只呈现，不另立第二份持久账）。
 */
import { atom } from "jotai";
import type { PersonalTodoErrorInfo, PersonalTodoListSource, PersonalTodoQuery, PersonalTodoStatusView, PersonalTodoSyncSummary, PersonalTodoView, PersonalTodoWriteStatus } from "../../../shared/types/personalTodo";
import type { TranslationKey } from "../i18n";
import { normalizePersonalTodoQuery } from "../utils/personalTodoQuery";
import type { PersonalTodoDraftForm } from "../utils/personalTodoDraft";

/** 云端接入状态；null = 还没取到（首次加载或读取失败）。 */
export const personalTodoStatusAtom = atom<PersonalTodoStatusView | null>(null);

export type PersonalTodoListState = {
	items: PersonalTodoView[];
	/** 下一页游标；null = 没有更多（界面据此隐藏「加载更多」）。 */
	nextCursor: string | null;
	/** cloud = 本次来自云端；cache = 云端不可达，读的是本地缓存。 */
	source: PersonalTodoListSource | null;
	fetchedAt: string | null;
	/**
	 * 已加载的窗口页数（筛选前的取回页码，首页替换时重置为 1，加载更多时 +1）。
	 * 筛选在主进程对已取回窗口做，因此「本页无匹配」时必须能说清已看了多少，
	 * 不能把未加载的页当成不存在。
	 */
	loadedPages: number;
	/** 首屏/整表加载中（load more 走 loadingMore，不遮挡整页） */
	loading: boolean;
	loadingMore: boolean;
	error: PersonalTodoErrorInfo | null;
};

export const personalTodoListAtom = atom<PersonalTodoListState>({ items: [], nextCursor: null, source: null, fetchedAt: null, loadedPages: 0, loading: false, loadingMore: false, error: null });

/** 云端写入可用性（来自任意一次返回；未知时为 null，界面按「可尝试」处理，失败再降级）。 */
export const personalTodoWriteAtom = atom<PersonalTodoWriteStatus | null>(null);

/** 队列摘要（待同步/发送中/冲突/未知/失败），页面顶部与列表行都用它。 */
export const personalTodoSummaryAtom = atom<PersonalTodoSyncSummary | null>(null);

/** 当前筛选（已规范化）；cursor 属于一次加载过程，不进这个 atom，避免「加载更多」污染筛选。 */
export const personalTodoQueryAtom = atom<PersonalTodoQuery>(normalizePersonalTodoQuery());

/** 列表中选中的事项 id；null = 未选中（右侧显示提示）。 */
export const personalTodoSelectedIdAtom = atom<string | null>(null);

/** 编辑缓冲：key = personalTodoDraftKey(scopeKey, itemId)，按账号与事项身份隔离。 */
export const personalTodoDraftsAtom = atom<Record<string, PersonalTodoDraftForm>>({});

/** 正在提交的事项 id（按钮禁用与「保存中」状态；不阻塞其它事项）。 */
export const personalTodoPendingIdsAtom = atom<string[]>([]);

/** 单条动作被本地挡住时的原因（例如「有未完成子项不能完成父项」），按事项 id 展示。 */
export const personalTodoItemNoticeAtom = atom<{ itemId: string; key: TranslationKey } | null>(null);

/** 整页级错误（读取失败、写入不可用等），列表为空时也要能说明原因。 */
export const personalTodoPageErrorAtom = atom<PersonalTodoErrorInfo | null>(null);
