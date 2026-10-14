/**
 * 待办列表的取数与合并规则（纯函数，可离开 React 单测）。
 *
 * 为什么单独一层：查询规范化、分页拼接、变更事件合并、账号作用域键这四件事同时被 hook、
 * 列表组件和测试使用；写进组件里就变成三份实现，迟到响应与账号切换的归属判断也会跟着散开。
 *
 * 边界（按 `shared/types/personalTodo.ts` 的契约）：
 * - 分类/状态/日期的过滤都在主进程完成；这里只把界面输入规范化成 `PersonalTodoQuery`，
 *   不另写一套客户端过滤，避免两套规则各自演化。
 * - `deadline` 是云端原字符串：这里只做空值归一，不解析日期、不换算时区。
 * - `revision` 是不透明 CAS 键：原样携带，不解析、不比较大小、不本地重算。
 */
import { PERSONAL_TODO_STATUSES, type PersonalTodoAccountScope, type PersonalTodoChangedEvent, type PersonalTodoListResult, type PersonalTodoQuery, type PersonalTodoStatus, type PersonalTodoView } from "../../../shared/types/personalTodo";
/** 与桌面接口回执一致：默认每页 50 条（wire 默认），上限 200。 */
export const PERSONAL_TODO_DEFAULT_LIMIT = 50;
export const PERSONAL_TODO_MAX_LIMIT = 200;

/** 空串在契约里表示「不限/第一页」，统一归一成 null，避免下游两种空值并存的判断。 */
function emptyToNull(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** 去重并剔除非法状态值；空数组与 null 同义（契约里 `null/缺省 = 全部`）。 */
function normalizeStatuses(status: PersonalTodoQuery["status"]): PersonalTodoStatus[] | null {
	if (!Array.isArray(status) || status.length === 0) return null;
	const allowed = new Set<string>(PERSONAL_TODO_STATUSES);
	const unique: PersonalTodoStatus[] = [];
	for (const value of status) {
		if (typeof value !== "string" || !allowed.has(value)) continue;
		if (unique.includes(value as PersonalTodoStatus)) continue;
		unique.push(value as PersonalTodoStatus);
	}
	return unique.length > 0 ? unique : null;
}

/**
 * 规范化查询：limit 夹到 1..200（非法值回落默认），空串归一为 null，search 去首尾空白。
 * 这些值会直接进入 IPC，渲染层的脏输入不能原样传下去。
 */
export function normalizePersonalTodoQuery(query: PersonalTodoQuery = {}): PersonalTodoQuery {
	const rawLimit = query.limit ?? PERSONAL_TODO_DEFAULT_LIMIT;
	const clampedLimit = Number.isFinite(rawLimit) ? Math.min(PERSONAL_TODO_MAX_LIMIT, Math.max(1, Math.trunc(rawLimit))) : PERSONAL_TODO_DEFAULT_LIMIT;
	return {
		category: emptyToNull(query.category),
		status: normalizeStatuses(query.status),
		deadlineFrom: emptyToNull(query.deadlineFrom),
		deadlineTo: emptyToNull(query.deadlineTo),
		search: emptyToNull(query.search),
		updatedSince: emptyToNull(query.updatedSince),
		order: query.order ?? null,
		cursor: emptyToNull(query.cursor),
		limit: clampedLimit,
	};
}

/** 清空筛选但保留排序与每页条数（「清空筛选」按钮只该清筛选）。 */
export function clearPersonalTodoFilters(query: PersonalTodoQuery): PersonalTodoQuery {
	return normalizePersonalTodoQuery({ order: query.order ?? null, limit: query.limit ?? PERSONAL_TODO_DEFAULT_LIMIT });
}

/** 是否存在生效中的筛选（用于界面提示「筛选后无结果」与清空按钮的可用态）。 */
export function hasPersonalTodoFilters(query: PersonalTodoQuery): boolean {
	const normalized = normalizePersonalTodoQuery(query);
	return normalized.category !== null || normalized.status !== null || normalized.deadlineFrom !== null || normalized.deadlineTo !== null || normalized.search !== null;
}

/**
 * 事项身份：视图没有顶层 id，身份在 `item.id`（契约里视图 = item + confirmed + draft + sync）。
 * 合并、选中、草稿键都走这里，避免各处各自拼一个 id 字段。
 */
export function personalTodoViewId(view: PersonalTodoView): string {
	return view.item.id;
}

/**
 * 合并一页结果到当前列表：按 id 去重，新版本覆盖旧版本，新增项追加在后面。
 * 服务端按创建时间排序返回，拼接时保留既有项的顺序，避免「加载更多」把已有行挪位。
 */
export function mergePersonalTodoListPage(current: readonly PersonalTodoView[], incoming: readonly PersonalTodoView[]): PersonalTodoView[] {
	const incomingById = new Map(incoming.map((view) => [personalTodoViewId(view), view]));
	const merged = current.map((view) => incomingById.get(personalTodoViewId(view)) ?? view);
	const seen = new Set(current.map((view) => personalTodoViewId(view)));
	for (const view of incoming) {
		const id = personalTodoViewId(view);
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(view);
	}
	return merged;
}

export type PersonalTodoListMerge = {
	items: PersonalTodoView[];
	/** 事件明确要求整表重取（推送条目超出上界）时为 true，调用方据此重拉 list。 */
	reload: boolean;
};

/**
 * 应用 `onChanged` 推送：`reload=true` 时列表内容不可信，只回传标记；否则按 id 覆盖/追加。
 * 推送条目可能已经不在当前筛选结果里（例如筛选 status=open 时某条被改成 done），这里不据此删除行：
 * 删除的唯一依据是重新取列表，避免界面凭一条推送就丢掉用户正在看的行。
 */
export function applyPersonalTodoChangedEvent(current: readonly PersonalTodoView[], event: Pick<PersonalTodoChangedEvent, "items" | "reload">): PersonalTodoListMerge {
	if (event.reload) return { items: [...current], reload: true };
	return { items: mergePersonalTodoListPage(current, event.items), reload: false };
}

/**
 * 账号作用域键：origin + cloudInstanceId + account（与契约的隔离键同源，accountKey 亦纳入）。
 * 切换账号/重新连接后键必然变化；迟到响应与推送都按这个键比对，旧账号的结果不得落进当前视图。
 */
export function personalTodoScopeKey(scope: PersonalTodoAccountScope | null | undefined): string {
	if (!scope) return "";
	return `${scope.origin}|${scope.cloudInstanceId}|${scope.account}|${scope.accountKey}`;
}

/**
 * 迟到结果判定：请求发出时的作用域键与当前不一致 → 结果是上一个账号的，必须丢弃。
 *
 * 空键不算迟到：首次加载本来就在 `getStatus` 之前发出（那时还不知道作用域），
 * 这种请求的结果要按「结果自带的作用域」与当前作用域比对，而不是直接当成迟到。
 */
export function isPersonalTodoResultStale(requestScopeKey: string, currentScopeKey: string): boolean {
	if (!requestScopeKey || !currentScopeKey) return false;
	return requestScopeKey !== currentScopeKey;
}

/** 作用域不匹配（两边都已知且不同）：用于比对结果自带的作用域与当前作用域。 */
export function isPersonalTodoScopeMismatch(left: string, right: string): boolean {
	return left.length > 0 && right.length > 0 && left !== right;
}

/** 草稿身份键：账号作用域 + 事项 id（切账号后旧草稿不可达，天然按账号隔离）。 */
export function personalTodoDraftKey(scopeKey: string, itemId: string): string {
	return `${scopeKey}::${itemId}`;
}

/** 列表结果里的作用域键；成功结果可能不带 scope（未连接），此时返回空键，调用方按「当前作用域」处理。 */
export function personalTodoResultScopeKey(result: PersonalTodoListResult): string {
	return result.ok ? personalTodoScopeKey(result.scope) : "";
}
