/**
 * 待办 UI 域纯策略：查询规范化、分页合并、推送合并、账号作用域归属、
 * 父子动作约束、同步徽标与错误码映射、编辑缓冲的 patch 与校验。
 *
 * 全部从公开行为断言（加载真实生产模块，不写源码字符串扫描）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const query = loadTsCommonJs("src/renderer/src/utils/personalTodoQuery.ts");
const state = loadTsCommonJs("src/renderer/src/utils/personalTodoState.ts");
const draft = loadTsCommonJs("src/renderer/src/utils/personalTodoDraft.ts");

/** vm 沙箱里造的对象与宿主不是同一个 realm，断言结构前先过 JSON 往返把它们带回宿主。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const SCOPE = { origin: "https://a.example", account: "alice", cloudInstanceId: "0.1.51", accountKey: "key-a" };

function view(id, overrides = {}) {
	const item = {
		id,
		title: `标题 ${id}`,
		note: "",
		category: null,
		deadline: null,
		urgency: null,
		status: "open",
		revision: `rev-${id}`,
		createdAt: null,
		updatedAt: null,
		linkedTaskIds: [],
		subtodos: [],
		subtodoProgress: { total: 0, done: 0, open: 0, cancelled: 0 },
		source: { kind: "canonical", legacyNamespace: null, legacySourceId: null },
		isRoot: true,
		parentId: null,
		parentSubtaskId: null,
		historyCount: null,
		...overrides.item,
	};
	return { item, confirmed: overrides.confirmed === undefined ? item : overrides.confirmed, draft: overrides.draft ?? null, sync: overrides.sync ?? { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: overrides.linkedTasks ?? [] };
}

function subtodo(id, status) {
	return { id, text: `子 ${id}`, note: "", status, assignee: null, linkedTaskIds: [] };
}

test("查询规范化：limit 夹到 1..200、空串归一为 null、状态去重并剔除非法值", () => {
	assert.deepEqual(plain(query.normalizePersonalTodoQuery({})), { category: null, status: null, deadlineFrom: null, deadlineTo: null, search: null, updatedSince: null, order: null, cursor: null, limit: 50 });
	assert.equal(query.normalizePersonalTodoQuery({ limit: 0 }).limit, 1);
	assert.equal(query.normalizePersonalTodoQuery({ limit: 999 }).limit, 200);
	assert.equal(query.normalizePersonalTodoQuery({ limit: Number.NaN }).limit, 50);
	assert.equal(query.normalizePersonalTodoQuery({ search: "   " }).search, null);
	assert.deepEqual(plain(query.normalizePersonalTodoQuery({ status: ["open", "open", "bogus", "done"] }).status), ["open", "done"]);
	assert.equal(query.normalizePersonalTodoQuery({ status: [] }).status, null);
	// 日期是原字符串，不做任何解析或时区换算
	assert.equal(query.normalizePersonalTodoQuery({ deadlineFrom: "2026-10-14" }).deadlineFrom, "2026-10-14");
	assert.equal(query.normalizePersonalTodoQuery({ deadlineFrom: "2026-10-14T00:00:00Z" }).deadlineFrom, "2026-10-14T00:00:00Z");
	assert.equal(query.hasPersonalTodoFilters({ status: ["open"] }), true);
	assert.equal(query.hasPersonalTodoFilters({}), false);
	assert.deepEqual(plain(query.clearPersonalTodoFilters({ status: ["done"], limit: 20 })), plain(query.normalizePersonalTodoQuery({ limit: 20 })));
});

test("分页合并保留既有顺序并按 id 去重；推送只合并不删行，reload 只回传标记", () => {
	const first = [view("a"), view("b")];
	const merged = query.mergePersonalTodoListPage(first, [view("b", { item: { title: "新标题" } }), view("c")]);
	assert.deepEqual(plain(merged.map((entry) => entry.item.id)), ["a", "b", "c"]);
	assert.equal(merged[1].item.title, "新标题");
	// 重复的游标返回不插入重复行
	assert.deepEqual(plain(query.mergePersonalTodoListPage(merged, [view("b")]).map((entry) => entry.item.id)), ["a", "b", "c"]);
	const afterPush = query.applyPersonalTodoChangedEvent(first, { items: [view("a", { item: { status: "done" } })], reload: false });
	assert.deepEqual(plain(afterPush.items.map((entry) => entry.item.status)), ["done", "open"]);
	assert.equal(afterPush.reload, false);
	const afterReload = query.applyPersonalTodoChangedEvent(first, { items: [], reload: true });
	assert.equal(afterReload.reload, true);
	assert.deepEqual(plain(afterReload.items.map((entry) => entry.item.id)), ["a", "b"], "reload 不猜内容，等重拉列表");
});

test("账号作用域键与迟到结果判定：不同账号/实例的结果一律丢弃", () => {
	const keyA = query.personalTodoScopeKey(SCOPE);
	assert.equal(query.isPersonalTodoResultStale(keyA, keyA), false);
	const keyB = query.personalTodoScopeKey({ ...SCOPE, account: "bob", accountKey: "key-b" });
	assert.equal(query.isPersonalTodoResultStale(keyA, keyB), true);
	// 首次加载在拿到作用域之前发出（请求键为空）：不算迟到，改由「结果自带作用域 vs 当前作用域」比对
	assert.equal(query.isPersonalTodoResultStale("", keyA), false);
	assert.equal(query.isPersonalTodoScopeMismatch(keyA, keyB), true);
	assert.equal(query.isPersonalTodoScopeMismatch("", keyA), false);
	// 草稿键按「作用域 + 事项」隔离：换账号后同一事项 id 不会读到上一账号的草稿
	assert.notEqual(query.personalTodoDraftKey(keyA, "todo_1"), query.personalTodoDraftKey(keyB, "todo_1"));
	assert.equal(query.personalTodoResultScopeKey({ ok: true, scope: SCOPE }), keyA);
	assert.equal(query.personalTodoResultScopeKey({ ok: false, error: { code: "offline", message: "x" } }), "");
});

test("父子动作约束：有未完成子项不能完成父项；子项完成不影响父项；重开父项保留子项", () => {
	const openChild = state.resolvePersonalTodoStatusDecision({ status: "done", subtodos: [subtodo("s1", "open"), subtodo("s2", "done")] });
	assert.equal(openChild.kind, "blocked");
	assert.equal(openChild.reasonKey, "personalTodo.subtodoBlockedComplete");
	assert.equal(state.resolvePersonalTodoStatusDecision({ status: "done", subtodos: [subtodo("s1", "done"), subtodo("s2", "cancelled")] }).kind, "allowed");
	// 子项状态变更不经过父项判定：这里只断言「父项规则不因取消子项而误判」
	assert.equal(state.resolvePersonalTodoStatusDecision({ status: "open", subtodos: [subtodo("s1", "open")] }).kind, "allowed");
	assert.equal(state.personalTodoToggleTarget("open"), "done");
	assert.equal(state.personalTodoToggleTarget("done"), "open");
	assert.equal(state.personalTodoToggleTarget("cancelled"), "done");
});

test("同步徽标：只有 synced 表示已云端确认，其余阶段一律显示未确认", () => {
	assert.equal(state.personalTodoSyncBadge("synced").key, "personalTodo.syncSynced");
	for (const phase of ["pending", "sending", "conflict", "unknown", "error"]) {
		const badge = state.personalTodoSyncBadge(phase);
		assert.notEqual(badge.key, "personalTodo.syncSynced", `${phase} 不得显示为已保存`);
	}
	assert.equal(state.personalTodoSyncBadge("conflict").tone, "warning");
	assert.equal(state.personalTodoSyncBadge("error").tone, "danger");
	// 未来新增阶段按「待确认」处理，不假装已保存
	assert.equal(state.personalTodoSyncBadge("something-new").key, "personalTodo.syncPending");
});

test("错误码映射稳定；写入不可用与关联任务缺失都有明确文案 key", () => {
	assert.equal(state.personalTodoErrorKey("offline"), "personalTodo.errorOffline");
	assert.equal(state.personalTodoErrorKey("conflict"), "personalTodo.errorConflict");
	assert.equal(state.personalTodoErrorKey("unknownOutcome"), "personalTodo.errorUnknownOutcome");
	assert.equal(state.personalTodoErrorKey("writeUnavailable"), "personalTodo.errorWriteUnavailable");
	assert.equal(state.personalTodoErrorKey("bogus-code"), "personalTodo.errorInternalError");
	assert.equal(state.personalTodoErrorInfoKey(null), null);
	assert.equal(state.personalTodoErrorInfoKey({ code: "staleAccount", message: "x" }), "personalTodo.errorStaleAccount");
	assert.equal(state.personalTodoLinkedTaskKey({ id: "t1", available: false }), "personalTodo.linkedTaskMissing");
	assert.equal(state.personalTodoLinkedTaskKey({ id: "t1", available: null }), "personalTodo.linkedTaskUnverified");
	assert.equal(state.personalTodoLinkedTaskKey({ id: "t1", available: true }), "personalTodo.linkedTask");
	assert.equal(state.personalTodoWriteNoticeKey({ available: true, reason: null, verified: true }), null);
	assert.equal(state.personalTodoWriteNoticeKey({ available: false, reason: null, verified: false }), "personalTodo.writeUnavailableGeneric");
	assert.equal(state.personalTodoWriteNoticeKey({ available: false, reason: "barrier", verified: true }), "personalTodo.writeUnavailableReason");
});

test("编辑缓冲：patch 只带变化字段、空串清空为 null、校验覆盖标题与紧急度", () => {
	const base = { title: "标题", note: "备注", category: "", deadline: "", urgency: "" };
	assert.equal(draft.personalTodoDraftPatch(base, { ...base }), null);
	assert.deepEqual(plain(draft.personalTodoDraftPatch(base, { ...base, title: "新标题" })), { title: "新标题" });
	assert.deepEqual(plain(draft.personalTodoDraftPatch(base, { ...base, deadline: "2026-10-20" })), { deadline: "2026-10-20" });
	// 有值 → 清空：落成 null（契约里 null 表示未设置）
	assert.deepEqual(plain(draft.personalTodoDraftPatch({ ...base, category: "工作" }, { ...base, category: "" })), { category: null });
	assert.deepEqual(plain(draft.personalTodoDraftPatch({ ...base, urgency: "2" }, { ...base, urgency: "" })), { urgency: null });
	assert.equal(draft.personalTodoDraftValidationKey({ ...base, title: "   " }), "personalTodo.titleRequired");
	assert.equal(draft.personalTodoDraftValidationKey({ ...base, urgency: "9" }), "personalTodo.urgencyInvalid");
	assert.equal(draft.personalTodoDraftValidationKey({ ...base, urgency: "1.5" }), "personalTodo.urgencyInvalid");
	assert.equal(draft.personalTodoDraftValidationKey({ ...base, urgency: "3" }), null);
	assert.equal(draft.personalTodoDraftIsDirty(base, { ...base, note: "x" }), true);
	assert.equal(draft.personalTodoDraftIsDirty(base, { ...base }), false);
});

test("提交结果决定缓冲去留：受理成功才清，失败保留输入", () => {
	assert.equal(state.personalTodoSubmitDraftDisposition({ ok: true, accepted: true }), "clear");
	assert.equal(state.personalTodoSubmitDraftDisposition({ ok: false, error: { code: "writeFailed", message: "x" } }), "keep");
	assert.equal(state.personalTodoSubmitDraftDisposition({ ok: false, error: { code: "conflict", message: "x" } }), "keep");
});

test("编辑缓冲建立：以主进程 draft 为初值、CAS 基准取云端确认版本", () => {
	const confirmed = { ...view("todo_1").item, revision: "rev-cloud" };
	const pendingDraft = { ...view("todo_1").item, title: "本地草稿", revision: "" };
	const built = draft.createPersonalTodoDraftForm({ scopeKey: query.personalTodoScopeKey(SCOPE), view: view("todo_1", { confirmed, draft: pendingDraft, item: pendingDraft }) });
	assert.equal(built.fields.title, "本地草稿", "有未确认修改时以草稿为初值");
	assert.equal(built.baseRevision, "rev-cloud", "CAS 基准用云端确认版本");
	assert.equal(built.dirty, false, "刚建立的缓冲不算脏");
	assert.equal(built.requestId, null);
});

test("列表窗口状态：未加载不等于不存在（本页无匹配但还有下一页时保留加载入口）", () => {
	assert.equal(state.resolvePersonalTodoWindowState({ itemCount: 3, hasMore: true, loading: false }), "rows");
	assert.equal(state.resolvePersonalTodoWindowState({ itemCount: 0, hasMore: true, loading: true }), "loading");
	assert.equal(state.resolvePersonalTodoWindowState({ itemCount: 0, hasMore: true, loading: false }), "empty-window", "还有下一页时不能当成没有匹配");
	assert.equal(state.resolvePersonalTodoWindowState({ itemCount: 0, hasMore: false, loading: false }), "empty");
});

test("替换合并：未确认本地行不被同一 confirmed 版本的旧快照回滚，新确认版本可覆盖", () => {
	const confirmed = view("a");
	const hasLocalWork = (entry) => entry.sync.phase !== "synced";
	const localPending = { item: { ...confirmed.item, note: "本地未确认" }, confirmed: { ...confirmed.item }, draft: null, sync: { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: [] };
	const staleIncoming = { item: { ...confirmed.item }, confirmed: { ...confirmed.item }, draft: null, sync: { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: [] };
	const merged = query.replacePersonalTodoListPage([localPending], [staleIncoming], hasLocalWork);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].item.note, "本地未确认", "同一 confirmed revision 的旧快照不得回滚未确认行");
	const newerConfirmed = { ...confirmed.item, revision: "rev-a2", note: "云端已改" };
	const newerIncoming = { item: newerConfirmed, confirmed: newerConfirmed, draft: null, sync: staleIncoming.sync, linkedTasks: [] };
	const replaced = query.replacePersonalTodoListPage([localPending], [newerIncoming], hasLocalWork);
	assert.equal(replaced[0].item.note, "云端已改", "带来新确认版本的响应必须覆盖本地");
});

test("刷新合并：不删除已加载行，未确认本地行优先，新行追加在末尾", () => {
	const incomingA = view("a", { item: { title: "云端新标题" } });
	const localB = view("b");
	localB.sync = { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null };
	localB.item = { ...localB.item, note: "本地未确认" };
	const localOnly = view("d");
	const hasLocalWork = (entry) => entry.sync.phase !== "synced";
	const merged = query.mergePersonalTodoRefreshPage([view("a"), localB, localOnly], [incomingA, view("b"), view("c")], hasLocalWork);
	assert.deepEqual(plain(merged.map((entry) => entry.item.id)), ["a", "b", "d", "c"]);
	assert.equal(merged[0].item.title, "云端新标题", "已确认行接受云端新值");
	assert.equal(merged[1].item.note, "本地未确认", "响应里的旧快照不得回滚未确认行");
	assert.equal(merged[2].item.id, "d", "刷新快照没有的行不删除");
	assert.equal(merged[3].item.id, "c", "新行追加在末尾");
});

test("浏览器前台适配器：订阅可见性/焦点/网络恢复，退订注销全部监听", () => {
	const listeners = new Map();
	const fakeWindow = {
		addEventListener: (type, listener) => {
			listeners.set(type, listener);
		},
		removeEventListener: (type, listener) => {
			if (listeners.get(type) === listener) listeners.delete(type);
		},
	};
	const fakeDocument = { hidden: false };
	const foreground = loadTsCommonJs("src/renderer/src/utils/personalTodoForeground.ts", { globals: { window: fakeWindow, document: fakeDocument } });
	const source = foreground.createBrowserPersonalTodoForeground();
	assert.equal(source.isVisible(), true);
	fakeDocument.hidden = true;
	assert.equal(source.isVisible(), false);
	let calls = 0;
	const unsubscribe = source.subscribe(() => {
		calls += 1;
	});
	for (const type of ["visibilitychange", "focus", "online"]) {
		assert.equal(typeof listeners.get(type), "function", `未订阅 ${type}`);
		listeners.get(type)();
	}
	assert.equal(calls, 3);
	unsubscribe();
	assert.equal(listeners.size, 0, "退订必须注销全部监听");
});

test("本地未确认工作判定：提交中/未同步/存在编辑缓冲都算，三者皆无才不算", () => {
	const synced = view("a");
	assert.equal(
		query.personalTodoViewHasLocalWork(
			synced,
			() => false,
			() => false,
		),
		false,
	);
	assert.equal(
		query.personalTodoViewHasLocalWork(
			synced,
			(id) => id === "a",
			() => false,
		),
		true,
		"提交中算未确认",
	);
	assert.equal(
		query.personalTodoViewHasLocalWork(
			synced,
			() => false,
			(id) => id === "a",
		),
		true,
		"有编辑缓冲也算",
	);
	const pending = view("b");
	pending.sync = { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null };
	assert.equal(
		query.personalTodoViewHasLocalWork(
			pending,
			() => false,
			() => false,
		),
		true,
		"未同步阶段算未确认",
	);
});

test("前台刷新生命周期：按间隔触发、在飞跳过、隐藏停表、回前台立即刷新、停止幂等", () => {
	const timers = new Map();
	let timerSeq = 0;
	const foreground = loadTsCommonJs("src/renderer/src/utils/personalTodoForeground.ts", {
		globals: {
			setInterval: (handler, ms) => {
				const id = ++timerSeq;
				timers.set(id, { handler, ms });
				return id;
			},
			clearInterval: (id) => {
				timers.delete(id);
			},
		},
	});
	const listeners = new Set();
	let visible = true;
	let refreshes = 0;
	let busy = false;
	const stop = foreground.startPersonalTodoForegroundRefresh({
		source: {
			isVisible: () => visible,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		intervalMs: 1000,
		isBusy: () => busy,
		refresh: () => {
			refreshes += 1;
		},
	});
	assert.equal(timers.size, 1, "可见时应有且只有一个计时器");
	for (const entry of timers.values()) entry.handler();
	assert.equal(refreshes, 1, "间隔到点触发刷新");
	busy = true;
	for (const entry of timers.values()) entry.handler();
	assert.equal(refreshes, 1, "在飞请求期间不叠加刷新");
	busy = false;
	visible = false;
	for (const listener of [...listeners]) listener();
	assert.equal(timers.size, 0, "隐藏立即停表");
	visible = true;
	for (const listener of [...listeners]) listener();
	assert.equal(refreshes, 2, "回到前台立即刷新一次");
	assert.equal(timers.size, 1, "回到前台重启计时器");
	stop();
	assert.equal(timers.size, 0, "停止清计时器");
	assert.equal(listeners.size, 0, "停止退订");
	stop();
	assert.equal(timers.size, 0, "停止幂等");
});
