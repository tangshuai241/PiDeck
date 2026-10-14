/**
 * 待办页的域 hook：读取状态与列表、订阅推送、提交写操作、维护编辑缓冲与迟到响应守卫。
 *
 * 为什么是 hook 而不是组件里各自调用：列表、详情、草稿、队列状态是同一份事实的多个出口，
 * 读一次写一次必须只有一处实现；组件只呈现（任务规则：副作用在域 hook，组件只呈现）。
 *
 * 边界与不变量：
 * - 所有桌面能力只经 `desktopApi.personalTodo`（契约见 execution/P02/desktop-contract.md）；
 *   这里不直接 fetch、不读凭据、不落第二份持久账。
 * - 迟到响应守卫：每次请求记下序号与当时的账号作用域键；结果回来时两者不一致就丢弃，
 *   旧账号/旧筛选的结果不落进当前视图（任务规则：切事项/账号迟到结果不串）。
 * - 打开页面才读取：本 hook 挂在待办页面组件上，页面未打开时不做启动探测或轮询。
 * - 保存失败/冲突保留编辑缓冲，只有受理成功才清（任务规则：保存失败输入保留、不自动覆盖）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { PersonalTodoErrorInfo, PersonalTodoListSource, PersonalTodoOperation, PersonalTodoQuery, PersonalTodoStatus, PersonalTodoStatusView, PersonalTodoSyncSummary, PersonalTodoView, PersonalTodoWriteStatus } from "../../../shared/types/personalTodo";
import { personalTodoDraftsAtom, personalTodoItemNoticeAtom, personalTodoListAtom, personalTodoPageErrorAtom, personalTodoPendingIdsAtom, personalTodoQueryAtom, personalTodoSelectedIdAtom, personalTodoStatusAtom, personalTodoSummaryAtom, personalTodoWriteAtom } from "../atoms/personal-todo-atoms";
import { clearPersonalTodoFilters, isPersonalTodoResultStale, isPersonalTodoScopeMismatch, mergePersonalTodoListPage, normalizePersonalTodoQuery, personalTodoDraftKey, personalTodoScopeKey } from "../utils/personalTodoQuery";
import { createPersonalTodoDraftForm, createPersonalTodoRequestId, personalTodoDraftIsDirty, personalTodoDraftPatch, personalTodoDraftValidationKey, remapPersonalTodoDrafts, upsertPersonalTodoView, type PersonalTodoDraftFields, type PersonalTodoDraftForm } from "../utils/personalTodoDraft";
import { personalTodoErrorKey, resolvePersonalTodoStatusDecision } from "../utils/personalTodoState";
import type { TranslationKey } from "../i18n";

/** 桌面待办接口（契约成员）：preload 集成前该成员暂缺，由后台交付后的集成任务收口。 */
export type PersonalTodoClient = typeof desktopApi.personalTodo;

/** 注入点：生产用 desktopApi.personalTodo，逻辑测试注入契约替身。 */
export type PersonalTodoOptions = { client?: PersonalTodoClient | null };

/** 运行期兜底：preload 尚未集成时该成员不存在，页面显示「服务版本不支持」而不是白屏崩溃。 */
function resolveClient(options: PersonalTodoOptions): PersonalTodoClient | null {
	if ("client" in options) return options.client ?? null;
	return desktopApi.personalTodo ?? null;
}

/** 提交的返回：受理成功/失败都是契约结构；接口缺失时给出 unsupported。 */
type SubmitOutcome = Awaited<ReturnType<PersonalTodoClient["submit"]>>;

export type PersonalTodoController = {
	/** null = 接口尚未接入（服务版本不支持） */
	clientAvailable: boolean;
	status: PersonalTodoStatusView | null;
	items: PersonalTodoView[];
	/** cloud = 本次来自云端；cache = 云端不可达，读的是本地缓存 */
	source: PersonalTodoListSource | null;
	fetchedAt: string | null;
	summary: PersonalTodoSyncSummary | null;
	write: PersonalTodoWriteStatus | null;
	loading: boolean;
	loadingMore: boolean;
	hasMore: boolean;
	/** 已加载的窗口页数（筛选前），用于「本页无匹配」时说明已看范围 */
	loadedPages: number;
	query: PersonalTodoQuery;
	selected: PersonalTodoView | null;
	draft: PersonalTodoDraftForm | null;
	pendingIds: string[];
	notice: { itemId: string; key: TranslationKey } | null;
	/** 整页级错误（读取失败、冲突处理失败等）；列表为空时也要能说明原因 */
	pageError: PersonalTodoErrorInfo | null;
	refresh: () => void;
	loadMore: () => void;
	setQuery: (patch: Partial<PersonalTodoQuery>) => void;
	clearFilters: () => void;
	select: (itemId: string | null) => void;
	dismissNotice: () => void;
	beginEdit: (view: PersonalTodoView) => void;
	updateDraftField: (field: keyof PersonalTodoDraftFields, value: string) => void;
	discardDraft: () => void;
	saveDraft: () => Promise<void>;
	createItem: (fields: PersonalTodoDraftFields) => Promise<boolean>;
	toggleStatus: (view: PersonalTodoView) => Promise<void>;
	addSubtodo: (view: PersonalTodoView, text: string) => Promise<boolean>;
	updateSubtodo: (view: PersonalTodoView, subtodoId: string, fields: { text?: string; note?: string }) => Promise<boolean>;
	toggleSubtodo: (view: PersonalTodoView, subtodoId: string, status: PersonalTodoStatus) => Promise<void>;
	retryItem: (itemId?: string) => Promise<void>;
	resolveConflict: (itemId: string, choice: "keepMine" | "takeCloud") => Promise<void>;
};

export function usePersonalTodo(options: PersonalTodoOptions = {}): PersonalTodoController {
	const client = useMemo(() => resolveClient(options), [options.client]);
	const [status, setStatus] = useAtom(personalTodoStatusAtom);
	const [list, setList] = useAtom(personalTodoListAtom);
	const [query, setQueryState] = useAtom(personalTodoQueryAtom);
	const [selectedId, setSelectedId] = useAtom(personalTodoSelectedIdAtom);
	const [drafts, setDrafts] = useAtom(personalTodoDraftsAtom);
	const [pendingIds, setPendingIds] = useAtom(personalTodoPendingIdsAtom);
	const [notice, setNotice] = useAtom(personalTodoItemNoticeAtom);
	const [write, setWrite] = useAtom(personalTodoWriteAtom);
	const [summary, setSummary] = useAtom(personalTodoSummaryAtom);
	const setPageError = useSetAtom(personalTodoPageErrorAtom);
	const pageError = useAtomValue(personalTodoPageErrorAtom);

	/** 账号作用域键：请求发出与结果应用时都比对它，旧账号迟到结果直接丢弃。 */
	const scopeKeyRef = useRef("");
	/**
	 * 已退场的老 id（本地占位 → 服务端 id）。
	 *
	 * 确认事件可能早于 submit 的 Promise 返回：后到的结果里仍是旧本地占位（confirmed 为空、
	 * revision 空），若照常 upsert 会重新插回幽灵行、并把已确认版本降回空 revision。
	 * 所以所有「来自响应/事件的单条视图」合并都要先过这里。
	 */
	const retiredIdsRef = useRef<Map<string, string>>(new Map());
	/** 请求序号：同一作用域内后发请求优先，避免慢响应覆盖新响应。 */
	const epochRef = useRef(0);
	/** 组件是否仍然挂载（卸载后不写状态）。 */
	const aliveRef = useRef(true);
	const [reloadToken, setReloadToken] = useState(0);

	const clientRef = useRef(client);
	clientRef.current = client;
	const scopeKey = status ? personalTodoScopeKey(status.scope) : "";
	const draftKey = selectedId ? personalTodoDraftKey(scopeKeyRef.current, selectedId) : "";
	const draft = draftKey && drafts[draftKey] ? drafts[draftKey] : null;

	const setItems = useCallback((updater: (items: PersonalTodoView[]) => PersonalTodoView[]) => setList((current) => ({ ...current, items: updater(current.items) })), [setList]);

	/** 合并单条视图：已被身份替换掉的老 id 直接丢弃（迟到的本地占位不得复活）。 */
	const mergeView = useCallback(
		(view: PersonalTodoView) => {
			if (retiredIdsRef.current.has(view.item.id)) return;
			setItems((items) => upsertPersonalTodoView(items, view));
		},
		[setItems],
	);

	/** 读取状态：只在这一页打开时执行；失败不阻塞列表（列表可能仍能读缓存）。 */
	const loadStatus = useCallback(() => {
		const active = clientRef.current;
		if (!active) return;
		const requestScopeKey = scopeKeyRef.current;
		void (async () => {
			let result: Awaited<ReturnType<PersonalTodoClient["getStatus"]>>;
			try {
				result = await active.getStatus();
			} catch {
				// IPC 层拒绝（preload 未注册、handler 抛错）也要收口成结构化错误，不外抛未处理 promise
				if (aliveRef.current) setPageError({ code: "internalError", message: "待办状态探测失败" });
				return;
			}
			if (!aliveRef.current) return;
			if (!result.ok) {
				setPageError(result.error);
				return;
			}
			setStatus(result.status);
			setSummary(result.status.summary);
			setWrite(result.status.write);
			const nextScopeKey = personalTodoScopeKey(result.status.scope);
			if (!nextScopeKey || nextScopeKey === requestScopeKey) return;
			// 账号已切换：清掉上一个账号的列表、选中与缓冲（缓冲按旧作用域键留存但不可达）
			scopeKeyRef.current = nextScopeKey;
			retiredIdsRef.current.clear();
			if (requestScopeKey) {
				setList({ items: [], nextCursor: null, source: null, fetchedAt: null, loadedPages: 0, loading: false, loadingMore: false, error: null });
				setSelectedId(null);
				setReloadToken((token) => token + 1);
			}
		})();
	}, [setList, setPageError, setSelectedId, setStatus, setSummary, setWrite]);

	/** 读取列表：打开页面、筛选变化、显式刷新走同一条路径。 */
	const load = useCallback(
		(targetQuery: PersonalTodoQuery, mode: "replace" | "append") => {
			const active = clientRef.current;
			if (!active) return;
			const epoch = ++epochRef.current;
			const requestScopeKey = scopeKeyRef.current;
			const isCurrent = () => aliveRef.current && epoch === epochRef.current;

			setList((current) => (mode === "replace" ? { ...current, loading: true, error: null } : { ...current, loadingMore: true }));

			void (async () => {
				let result: Awaited<ReturnType<PersonalTodoClient["list"]>>;
				try {
					result = await active.list(targetQuery);
				} catch {
					if (!isCurrent()) return;
					const error = { code: "internalError" as const, message: "待办列表读取失败" };
					setList((current) => ({ ...current, loading: false, loadingMore: false, error }));
					setPageError(error);
					return;
				}
				if (!isCurrent()) return;
				if (!result.ok) {
					setList((current) => ({ ...current, loading: false, loadingMore: false, error: result.error }));
					setPageError(result.error);
					return;
				}
				// 账号作用域已变化 → 结果属于上一个会话（登录/登出/换账号），整体丢弃
				if (isPersonalTodoResultStale(requestScopeKey, scopeKeyRef.current)) return;
				const resultScopeKey = personalTodoScopeKey(result.scope);
				// 首次加载在 getStatus 之前发出（请求键为空）：按结果自带的作用域与当前作用域比对
				if (isPersonalTodoScopeMismatch(resultScopeKey, scopeKeyRef.current)) return;
				if (resultScopeKey) scopeKeyRef.current = resultScopeKey;
				setList((current) => ({
					items: mode === "append" ? mergePersonalTodoListPage(current.items, result.items) : [...result.items],
					nextCursor: result.nextCursor,
					source: result.source,
					fetchedAt: result.fetchedAt,
					loadedPages: mode === "append" ? current.loadedPages + 1 : 1,
					loading: false,
					loadingMore: false,
					error: null,
				}));
				setSummary(result.summary);
				setWrite(result.write);
				setPageError(null);
			})();
		},
		[setList, setPageError, setSummary, setWrite],
	);

	// 打开页面 / 筛选变化 / 刷新：状态 + 第一页
	const queryKey = useMemo(() => JSON.stringify(query), [query]);
	useEffect(() => {
		if (!client) return;
		loadStatus();
		load(query, "replace");
	}, [client, load, loadStatus, query, queryKey, reloadToken]);

	// 订阅推送：reload 由主进程显式要求（超出上界或身份变化），其余按条目合并
	useEffect(() => {
		if (!client) return;
		aliveRef.current = true;
		const unsubscribe = client.onChanged((event) => {
			if (!aliveRef.current) return;
			const eventScopeKey = personalTodoScopeKey(event.scope);
			// 身份变更事件本身就在宣告新作用域：先采纳再重载，不能被「旧作用域」的守卫挡掉
			if (event.reason === "identity") {
				if (eventScopeKey) scopeKeyRef.current = eventScopeKey;
				// 换账号/换代：老 id 的退场记录不再适用
				retiredIdsRef.current.clear();
				setSummary(event.summary);
				setWrite(event.write);
				setSelectedId(null);
				setReloadToken((token) => token + 1);
				return;
			}
			// 其余推送：作用域不匹配（旧账号的迟到推送）直接丢弃
			if (isPersonalTodoScopeMismatch(eventScopeKey, scopeKeyRef.current)) return;
			setSummary(event.summary);
			setWrite(event.write);
			// 身份替换（未确认 create 确认后 local → server）：先迁走占位/选中/草稿，再合并新视图。
			// 只用主进程已证实的 old→new，不按标题猜测；两条真同名事项不会被去重。
			const remaps = Array.isArray(event.identityRemap) ? event.identityRemap.filter((entry) => entry && typeof entry.from === "string" && typeof entry.to === "string") : [];
			if (remaps.length > 0) {
				const fromIds = new Set(remaps.map((entry) => entry.from));
				for (const entry of remaps) retiredIdsRef.current.set(entry.from, entry.to);
				setItems((items) => items.filter((view) => !fromIds.has(view.item.id)));
				setSelectedId((current) => (current && fromIds.has(current) ? (remaps.find((entry) => entry.from === current)?.to ?? null) : current));
				setDrafts((current) => remapPersonalTodoDrafts(current, scopeKeyRef.current, remaps));
			}
			if (event.reload || event.items.length === 0) {
				if (event.reload) setReloadToken((token) => token + 1);
				return;
			}
			setItems((items) => event.items.reduce((next, view) => upsertPersonalTodoView(next, view), items));
		});
		return () => {
			aliveRef.current = false;
			unsubscribe();
		};
	}, [client, setItems, setSelectedId, setSummary, setWrite]);

	const refresh = useCallback(() => setReloadToken((token) => token + 1), []);
	const loadMore = useCallback(() => {
		if (!list.nextCursor) return;
		load({ ...query, cursor: list.nextCursor }, "append");
	}, [list.nextCursor, load, query]);

	const setQuery = useCallback(
		(patch: Partial<PersonalTodoQuery>) => {
			// 换筛选必须回到第一页：保留旧 cursor 会把上一次筛选的游标带进新查询
			setQueryState(normalizePersonalTodoQuery({ ...query, ...patch, cursor: null }));
		},
		[query, setQueryState],
	);
	const clearFilters = useCallback(() => setQueryState(clearPersonalTodoFilters(query)), [query, setQueryState]);
	const select = useCallback(
		(itemId: string | null) => {
			setSelectedId(itemId);
			setNotice(null);
		},
		[setNotice, setSelectedId],
	);
	const dismissNotice = useCallback(() => setNotice(null), [setNotice]);

	const markPending = useCallback(
		(itemId: string, pending: boolean) => {
			if (!itemId) return;
			setPendingIds((current) => (pending ? (current.includes(itemId) ? current : [...current, itemId]) : current.filter((id) => id !== itemId)));
		},
		[setPendingIds],
	);

	/** 提交一个操作：统一处理作用域守卫、视图合并与错误展示（失败结果也带回视图时一并更新）。 */
	const submit = useCallback(
		async (operation: PersonalTodoOperation, request?: { clientRequestId?: string; itemId?: string }): Promise<SubmitOutcome> => {
			const active = clientRef.current;
			if (!active) return { ok: false, error: { code: "unsupported", message: "personal todo client unavailable" } };
			const itemId = request?.itemId ?? ("id" in operation ? operation.id : "");
			const requestScopeKey = scopeKeyRef.current;
			markPending(itemId, true);
			try {
				let result: SubmitOutcome;
				try {
					result = await active.submit({ operation, clientRequestId: request?.clientRequestId });
				} catch {
					// IPC 拒绝 / handler 异常：结构化为可展示错误，不把 rejected promise 留给组件（输入保留）
					const error = { code: "internalError" as const, message: "待办提交失败" };
					if (aliveRef.current) {
						setPageError(error);
						setNotice({ itemId: itemId || "create", key: personalTodoErrorKey(error.code) });
					}
					return { ok: false, error };
				}
				if (!aliveRef.current) return result;
				if (isPersonalTodoResultStale(requestScopeKey, scopeKeyRef.current)) return result;
				if (result.ok) {
					setSummary(result.summary);
					setWrite(result.write);
					mergeView(result.item);
					return result;
				}
				setNotice({ itemId: itemId || "create", key: personalTodoErrorKey(result.error.code) });
				const failedView = result.item;
				if (failedView) mergeView(failedView);
				return result;
			} finally {
				if (aliveRef.current) markPending(itemId, false);
			}
		},
		[markPending, mergeView, setNotice, setPageError, setSummary, setWrite],
	);

	const updateDraft = useCallback(
		(key: string, updater: (form: PersonalTodoDraftForm) => PersonalTodoDraftForm) => {
			setDrafts((current) => {
				const form = current[key];
				if (!form) return current;
				return { ...current, [key]: updater(form) };
			});
		},
		[setDrafts],
	);

	const beginEdit = useCallback(
		(view: PersonalTodoView) => {
			const key = personalTodoDraftKey(scopeKeyRef.current, view.item.id);
			// 已有同事项缓冲时不覆盖：用户没保存的输入不能因为他点了一次「编辑」就消失
			setDrafts((current) => (current[key] ? current : { ...current, [key]: createPersonalTodoDraftForm({ scopeKey: scopeKeyRef.current, view }) }));
		},
		[setDrafts],
	);

	const updateDraftField = useCallback(
		(field: keyof PersonalTodoDraftFields, value: string) => {
			if (!draftKey) return;
			updateDraft(draftKey, (form) => {
				const fields = { ...form.fields, [field]: value };
				return { ...form, fields, dirty: personalTodoDraftIsDirty(form.base, fields), lastError: null };
			});
		},
		[draftKey, updateDraft],
	);

	const discardDraft = useCallback(() => {
		if (!draftKey) return;
		setDrafts((current) => {
			if (!current[draftKey]) return current;
			const next = { ...current };
			delete next[draftKey];
			return next;
		});
	}, [draftKey, setDrafts]);

	const saveDraft = useCallback(async () => {
		const form = draft;
		if (!form || !draftKey) return;
		const validationKey = personalTodoDraftValidationKey(form.fields);
		if (validationKey) {
			setNotice({ itemId: form.itemId, key: validationKey });
			return;
		}
		const patch = personalTodoDraftPatch(form.base, form.fields);
		if (!patch) {
			discardDraft();
			return;
		}
		// 重试必须复用同一个 requestId：先落进缓冲，再提交（失败保留缓冲，成功才清）
		const requestId = form.requestId ?? createPersonalTodoRequestId();
		updateDraft(draftKey, (current) => ({ ...current, requestId }));
		const result = await submit({ kind: "patch", id: form.itemId, expectedRevision: form.baseRevision, patch }, { clientRequestId: requestId, itemId: form.itemId });
		if (!aliveRef.current) return;
		if (result.ok) {
			discardDraft();
			return;
		}
		updateDraft(draftKey, (current) => ({ ...current, lastError: result.error, requestId }));
	}, [discardDraft, draft, draftKey, setNotice, submit, updateDraft]);

	const createItem = useCallback(
		async (fields: PersonalTodoDraftFields) => {
			const validationKey = personalTodoDraftValidationKey(fields);
			if (validationKey) {
				setNotice({ itemId: "create", key: validationKey });
				return false;
			}
			// 新建同样带稳定 requestId：受理失败后重试不产生第二条记录
			const result = await submit(
				{
					kind: "create",
					title: fields.title.trim(),
					note: fields.note,
					category: fields.category.trim() ? fields.category.trim() : null,
					deadline: fields.deadline.trim() ? fields.deadline.trim() : null,
					urgency: fields.urgency.trim() ? Number(fields.urgency.trim()) : null,
				},
				{ clientRequestId: createPersonalTodoRequestId("new") },
			);
			return result.ok;
		},
		[setNotice, submit],
	);

	const toggleStatus = useCallback(
		async (view: PersonalTodoView) => {
			const target: PersonalTodoStatus = view.item.status === "done" ? "open" : "done";
			const decision = resolvePersonalTodoStatusDecision({ status: target, subtodos: view.item.subtodos });
			if (decision.kind === "blocked") {
				setNotice({ itemId: view.item.id, key: decision.reasonKey });
				return;
			}
			setNotice(null);
			await submit({ kind: "status", id: view.item.id, expectedRevision: view.item.revision, status: target });
		},
		[setNotice, submit],
	);

	const addSubtodo = useCallback(
		async (view: PersonalTodoView, text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return false;
			const result = await submit({ kind: "subtodoAdd", id: view.item.id, expectedRevision: view.item.revision, text: trimmed });
			return result.ok;
		},
		[submit],
	);

	const updateSubtodo = useCallback(
		async (view: PersonalTodoView, subtodoId: string, fields: { text?: string; note?: string }) => {
			const result = await submit({ kind: "subtodoPatch", id: view.item.id, expectedRevision: view.item.revision, subtodoId, ...fields });
			return result.ok;
		},
		[submit],
	);

	const toggleSubtodo = useCallback(
		async (view: PersonalTodoView, subtodoId: string, status: PersonalTodoStatus) => {
			// 子项完成/重开只改子项：父项状态由用户对父项的操作或云端推送决定（契约同规则）
			await submit({ kind: "subtodoStatus", id: view.item.id, expectedRevision: view.item.revision, subtodoId, status });
		},
		[submit],
	);

	const retryItem = useCallback(
		async (itemId?: string) => {
			const active = clientRef.current;
			if (!active) return;
			const requestScopeKey = scopeKeyRef.current;
			let result: Awaited<ReturnType<PersonalTodoClient["retry"]>>;
			try {
				result = await active.retry(itemId ? { id: itemId } : {});
			} catch {
				if (aliveRef.current) setPageError({ code: "internalError", message: "重试失败" });
				return;
			}
			if (!aliveRef.current) return;
			if (isPersonalTodoResultStale(requestScopeKey, scopeKeyRef.current)) return;
			if (!result.ok) {
				setPageError(result.error);
				return;
			}
			setSummary(result.summary);
			setWrite(result.write);
		},
		[setPageError, setSummary, setWrite],
	);

	const resolveConflict = useCallback(
		async (itemId: string, choice: "keepMine" | "takeCloud") => {
			const active = clientRef.current;
			if (!active) return;
			const requestScopeKey = scopeKeyRef.current;
			let result: Awaited<ReturnType<PersonalTodoClient["resolveConflict"]>>;
			try {
				result = await active.resolveConflict({ id: itemId, choice });
			} catch {
				if (aliveRef.current) setPageError({ code: "internalError", message: "冲突处理失败" });
				return;
			}
			if (!aliveRef.current) return;
			if (isPersonalTodoResultStale(requestScopeKey, scopeKeyRef.current)) return;
			if (!result.ok) {
				setPageError(result.error);
				return;
			}
			setSummary(result.summary);
			const resolved = result.item;
			if (resolved) mergeView(resolved);
			// 冲突处理完成后编辑缓冲归主进程队列所有：清掉界面缓冲，避免两份草稿并存
			const key = personalTodoDraftKey(scopeKeyRef.current, itemId);
			setDrafts((current) => {
				if (!current[key]) return current;
				const next = { ...current };
				delete next[key];
				return next;
			});
		},
		[mergeView, setDrafts, setItems, setPageError, setSummary],
	);

	return {
		clientAvailable: client !== null,
		status,
		items: list.items,
		source: list.source,
		fetchedAt: list.fetchedAt,
		summary,
		write,
		loading: list.loading,
		loadingMore: list.loadingMore,
		hasMore: list.nextCursor !== null,
		loadedPages: list.loadedPages,
		query,
		selected: list.items.find((view) => view.item.id === selectedId) ?? null,
		draft,
		pendingIds,
		notice,
		pageError,
		refresh,
		loadMore,
		setQuery,
		clearFilters,
		select,
		dismissNotice,
		beginEdit,
		updateDraftField,
		discardDraft,
		saveDraft,
		createItem,
		toggleStatus,
		addSubtodo,
		updateSubtodo,
		toggleSubtodo,
		retryItem,
		resolveConflict,
	};
}
