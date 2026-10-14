/**
 * 待办域 hook 的行为测试：加载/选中、草稿保护、失败与冲突保留、切账号迟到结果、父子动作映射。
 *
 * 口径：加载真实生产 hook 与真实 Jotai 状态，只替换 React 挂载层与桌面契约依赖
 * （注入契约替身，符合「逻辑测试可注入契约依赖」）。断言落在「点了之后状态是什么、
 * 发了什么操作」上，不做源码字符串扫描。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const SCOPE_A = { origin: "https://a.example", account: "alice", cloudInstanceId: "0.1.51", accountKey: "key-a" };
const SCOPE_B = { origin: "https://b.example", account: "bob", cloudInstanceId: "0.1.52", accountKey: "key-b" };
const SUMMARY = { pending: 0, sending: 0, conflict: 0, unknown: 0, error: 0, confirmedRecent: 0 };
const WRITE = { available: true, reason: null, verified: true };

function item(id, overrides = {}) {
	return {
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
		...overrides,
	};
}

function view(id, overrides = {}) {
	const confirmed = overrides.confirmed === undefined ? item(id) : overrides.confirmed;
	return {
		item: overrides.item ?? confirmed ?? item(id),
		confirmed,
		draft: overrides.draft ?? null,
		sync: overrides.sync ?? { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null },
		linkedTasks: overrides.linkedTasks ?? [],
	};
}

const subtodo = (id, status) => ({ id, text: `子 ${id}`, note: "", status, assignee: null, linkedTaskIds: [] });

/** 契约替身：可注入返回、可手动挂起 list（用来构造迟到响应）。 */
function createClient(options = {}) {
	const listeners = new Set();
	const calls = { list: [], submit: [], resolveConflict: [] };
	let scope = options.scope ?? SCOPE_A;
	let listImpl = options.list ?? (async () => ({ ok: true, scope, items: options.items ?? [], nextCursor: null, source: "cloud", fetchedAt: "2026-10-14T06:00:00Z", summary: SUMMARY, write: WRITE }));
	let submitImpl = options.submit ?? (async () => ({ ok: true, item: view("todo_new"), summary: SUMMARY, write: WRITE, accepted: true, requestId: "req-1" }));
	return {
		calls,
		getStatus: async () => ({ ok: true, status: { supported: options.supported ?? true, scope, summary: SUMMARY, write: WRITE, lastFetchedAt: "2026-10-14T06:00:00Z", lastError: null } }),
		list: async (query) => {
			calls.list.push(query);
			return listImpl(query);
		},
		get: async () => ({ ok: false, error: { code: "internalError", message: "unused" } }),
		submit: async (input) => {
			calls.submit.push(input);
			return submitImpl(input);
		},
		retry: async () => ({ ok: true, summary: SUMMARY, write: WRITE, retried: 0 }),
		resolveConflict: async (input) => {
			calls.resolveConflict.push(input);
			return options.resolveConflict ? options.resolveConflict(input) : { ok: true, item: null, summary: SUMMARY };
		},
		onChanged: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		setScope: (next) => {
			scope = next;
		},
		setListImpl: (next) => {
			listImpl = next;
		},
		setSubmitImpl: (next) => {
			submitImpl = next;
		},
	};
}

/** React 替身：槽位按调用顺序复用；effect 在渲染后统一执行（依赖不变则不重跑）。 */
function createHost(store) {
	const slots = [];
	let cursor = 0;
	let pendingEffects = [];
	const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
	const react = {
		useState(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
				},
			];
		},
		useRef(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { current: initial };
			return slots[index];
		},
		useCallback(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { value: fn, deps };
			return slots[index].value;
		},
		useMemo(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { value: fn(), deps };
			return slots[index].value;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (slot && sameDeps(slot.deps, deps)) return;
			pendingEffects.push(() => {
				slot?.cleanup?.();
				slots[index] = { cleanup: fn(), deps };
			});
		},
	};
	const setters = new Map();
	/** 与真实 jotai 一致：同一个 atom 的 setter 必须跨渲染保持同一引用，否则会拖垮依赖它的 useCallback/useEffect。 */
	const setterFor = (target) => {
		if (!setters.has(target)) {
			setters.set(target, (next) => {
				store.set(target, typeof next === "function" ? next(store.get(target)) : next);
			});
		}
		return setters.get(target);
	};
	const jotai = {
		atom,
		useAtom: (target) => {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || slot.atom !== target) slots[index] = { atom: target };
			return [store.get(target), setterFor(target)];
		},
		useAtomValue: (target) => {
			cursor++;
			return store.get(target);
		},
		useSetAtom: (target) => {
			cursor++;
			return setterFor(target);
		},
	};
	return {
		react,
		jotai,
		render(callback) {
			cursor = 0;
			const result = callback();
			const effects = pendingEffects;
			pendingEffects = [];
			for (const effect of effects) effect();
			return result;
		},
	};
}

function harness(options = {}) {
	const store = createStore();
	const client = createClient(options);
	const host = createHost(store);
	const { usePersonalTodo } = loadTsCommonJs("src/renderer/src/hooks/usePersonalTodo.ts", {
		stubs: { react: host.react, jotai: host.jotai, "../desktopApi": { desktopApi: { personalTodo: client } } },
	});
	let controller = null;
	return {
		store,
		client,
		render: () => {
			controller = host.render(() => usePersonalTodo({ client }));
			return controller;
		},
		get controller() {
			return controller;
		},
	};
}

const tick = () => nextTask();

test("打开页面才读取：状态与第一页到达后列表可见，选中按事项身份生效", async () => {
	const h = harness({ items: [view("todo_1"), view("todo_2")] });
	let todo = h.render();
	assert.equal(todo.clientAvailable, true);
	todo = h.render();
	assert.equal(todo.loading, true, "首屏进入加载态");
	await tick();
	todo = h.render();
	assert.equal(todo.loading, false);
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_1", "todo_2"]);
	assert.equal(h.client.calls.list.length, 1, "打开页面读取一次第一页");

	todo.select("todo_1");
	todo = h.render();
	assert.equal(todo.selected?.item.id, "todo_1");
	todo.select("todo_2");
	todo = h.render();
	assert.equal(todo.selected?.item.id, "todo_2");
});

test("草稿保护：编辑脏值可见，提交失败保留输入并记录结构化错误，受理成功才清缓冲", async () => {
	const target = view("todo_1");
	const h = harness({ items: [target] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();
	todo.beginEdit(todo.selected);
	todo = h.render();
	assert.ok(todo.draft, "打开编辑后存在界面缓冲");
	assert.equal(todo.draft.dirty, false);

	todo.updateDraftField("title", "改过的标题");
	todo = h.render();
	assert.equal(todo.draft.fields.title, "改过的标题");
	assert.equal(todo.draft.dirty, true);

	// 保存失败：保留缓冲 + 记录错误
	h.client.setSubmitImpl(async () => ({ ok: false, error: { code: "writeFailed", message: "boom" } }));
	await todo.saveDraft();
	todo = h.render();
	assert.ok(todo.draft, "保存失败不得清掉用户输入");
	assert.equal(todo.draft.fields.title, "改过的标题");
	assert.equal(todo.draft.lastError?.code, "writeFailed");
	assert.equal(h.client.calls.submit[0].operation.kind, "patch");
	assert.equal(h.client.calls.submit[0].operation.expectedRevision, "rev-todo_1");
	assert.equal(typeof h.client.calls.submit[0].clientRequestId, "string");

	// 重试复用同一个 requestId（不产生第二条记录）
	const firstRequestId = h.client.calls.submit[0].clientRequestId;
	await todo.saveDraft();
	assert.equal(h.client.calls.submit[1].clientRequestId, firstRequestId, "重试必须复用同一 requestId");

	// 受理成功：缓冲清掉，视图换成主进程返回的记录
	h.client.setSubmitImpl(async () => ({ ok: true, item: view("todo_1", { item: item("todo_1", { title: "改过的标题" }) }), summary: SUMMARY, write: WRITE, accepted: true, requestId: firstRequestId }));
	await todo.saveDraft();
	todo = h.render();
	assert.equal(todo.draft, null, "受理成功后界面缓冲交由主进程队列管理");
	assert.equal(h.client.calls.submit[2].clientRequestId, firstRequestId, "受理成功也复用同一 requestId");
});

test("冲突保留：本地草稿与云端版本并存，处理前不自动覆盖，处理后按选择收敛", async () => {
	const cloud = item("todo_1", { title: "云端标题", revision: "rev-cloud" });
	const mine = item("todo_1", { title: "我的标题", revision: "" });
	const conflicted = view("todo_1", { confirmed: cloud, item: mine, draft: mine, sync: { phase: "conflict", pendingCount: 1, lastError: { code: "conflict", message: "x" }, cloudRevision: "rev-cloud", lastAttemptAt: null } });
	const h = harness({ items: [conflicted] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();
	assert.equal(todo.selected.item.title, "我的标题", "冲突时渲染本人草稿");
	assert.equal(todo.selected.confirmed.title, "云端标题", "云端版本同时可见");
	assert.equal(h.client.calls.resolveConflict.length, 0, "不自动替用户做决定");

	h.client.setSubmitImpl(async () => ({ ok: true, item: view("todo_1"), summary: SUMMARY, write: WRITE, accepted: true, requestId: "req" }));
	await todo.resolveConflict("todo_1", "takeCloud");
	todo = h.render();
	assert.deepEqual(plain(h.client.calls.resolveConflict), [{ id: "todo_1", choice: "takeCloud" }]);
	assert.equal(todo.draft, null, "冲突处理后界面缓冲交给主进程");
});

test("切账号迟到结果不落当前视图：旧账号响应被丢弃，新账号重新取数", async () => {
	let releaseOld;
	const oldPending = new Promise((resolve) => {
		releaseOld = resolve;
	});
	let call = 0;
	const h = harness({
		items: [view("todo_1")],
		list: async () => {
			call += 1;
			if (call === 1) return oldPending;
			return { ok: true, scope: SCOPE_B, items: [view("todo_b")], nextCursor: null, source: "cloud", fetchedAt: "2026-10-14T06:00:00Z", summary: SUMMARY, write: WRITE };
		},
	});
	let todo = h.render();
	await tick();
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), [], "首个列表请求仍挂着（模拟慢响应）");

	// 账号切换推送：作用域键变 B，hook 重载列表
	h.client.setScope(SCOPE_B);
	h.client.emit({ scope: SCOPE_B, reason: "identity", items: [], summary: SUMMARY, write: WRITE, reload: false });
	todo = h.render();
	await tick();
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_b"], "新账号数据生效");

	// 旧账号的迟到响应随后到达：必须被丢弃
	releaseOld({ ok: true, scope: SCOPE_A, items: [view("todo_stale")], nextCursor: null, source: "cloud", fetchedAt: "2026-10-14T05:00:00Z", summary: SUMMARY, write: WRITE });
	await tick();
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_b"], "旧账号迟到结果不得落进当前视图");
});

test("父子动作映射：有未完成子项挡下父项完成（不发请求），子项状态只改子项", async () => {
	const withOpenChild = view("todo_1", { item: item("todo_1", { subtodos: [subtodo("s1", "open"), subtodo("s2", "done")], subtodoProgress: { total: 2, done: 1, open: 1, cancelled: 0 } }) });
	const h = harness({ items: [withOpenChild] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();

	await todo.toggleStatus(todo.selected);
	todo = h.render();
	assert.equal(h.client.calls.submit.length, 0, "被本地规则挡住就不发请求");
	assert.equal(todo.notice?.key, "personalTodo.subtodoBlockedComplete");

	// 子项完成：只发 subtodoStatus，父项状态不出现在操作里
	await todo.toggleSubtodo(todo.selected, "s1", "done");
	assert.equal(h.client.calls.submit.length, 1);
	assert.equal(h.client.calls.submit[0].operation.kind, "subtodoStatus");
	assert.equal(h.client.calls.submit[0].operation.subtodoId, "s1");
	assert.equal("status" in h.client.calls.submit[0].operation && h.client.calls.submit[0].operation.status, "done");
	assert.notEqual(h.client.calls.submit[0].operation.kind, "status", "子项完成不得改父项状态");

	// 子项全部完成后父项才可以完成
	const readyView = view("todo_1", { item: item("todo_1", { subtodos: [subtodo("s1", "done")] }) });
	h.client.setListImpl(async () => ({ ok: true, scope: SCOPE_A, items: [readyView], nextCursor: null, source: "cloud", fetchedAt: "2026-10-14T06:00:00Z", summary: SUMMARY, write: WRITE }));
	todo.refresh();
	todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();
	await todo.toggleStatus(todo.selected);
	assert.equal(h.client.calls.submit[1].operation.kind, "status");
	assert.equal(h.client.calls.submit[1].operation.status, "done");
});

test("写门关闭与结果未知：都保留输入与 requestId，不谎称已保存", async () => {
	const target = view("todo_1");
	const h = harness({ items: [target] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();
	todo.beginEdit(todo.selected);
	todo = h.render();
	todo.updateDraftField("note", "离线也要留住的备注");
	todo = h.render();

	for (const code of ["writeUnavailable", "unknownOutcome", "offline"]) {
		h.client.setSubmitImpl(async () => ({ ok: false, error: { code, message: "x" } }));
		await todo.saveDraft();
		todo = h.render();
		assert.ok(todo.draft, `${code}: 必须保留界面缓冲`);
		assert.equal(todo.draft.fields.note, "离线也要留住的备注");
		assert.equal(todo.draft.lastError?.code, code);
		// 同一份缓冲的每次重试都复用同一 requestId（不产生第二条记录）
		const requestIds = h.client.calls.submit.map((call) => call.clientRequestId);
		assert.equal(new Set(requestIds).size, 1, `${code}: requestId 必须复用`);
	}
});

test("IPC 拒绝收口：提交抛错变成结构化失败，草稿与输入保留，待提交状态恢复", async () => {
	const target = view("todo_1");
	const h = harness({ items: [target] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_1");
	todo = h.render();
	todo.beginEdit(todo.selected);
	todo = h.render();
	todo.updateDraftField("title", "不想丢的标题");
	todo = h.render();

	// 契约替身直接 reject（preload 未注册 / handler 抛错）
	h.client.setSubmitImpl(async () => {
		throw new Error("ipc rejected");
	});
	await todo.saveDraft(); // 不得 reject
	todo = h.render();
	assert.ok(todo.draft, "抛错时草稿保留");
	assert.equal(todo.draft.fields.title, "不想丢的标题");
	assert.equal(todo.draft.lastError?.code, "internalError");
	assert.deepEqual(plain(todo.pendingIds), [], "待提交标记必须恢复（不能永久禁用按钮）");
	assert.equal(todo.notice?.key, "personalTodo.errorInternalError");
	assert.equal(todo.pageError?.code, "internalError");
});

test("筛选窗口：本页无匹配但还有下一页时保留加载更多，并累计已加载页数", async () => {
	const h = harness({
		items: [],
		list: async () => ({ ok: true, scope: SCOPE_A, items: [], nextCursor: "cursor-2", source: "cloud", fetchedAt: "2026-10-14T06:00:00Z", summary: SUMMARY, write: WRITE }),
	});
	let todo = h.render();
	await tick();
	todo = h.render();
	assert.equal(todo.items.length, 0);
	assert.equal(todo.hasMore, true, "还有下一页：必须保留加载入口");
	assert.equal(todo.loadedPages, 1);
	assert.equal(h.client.calls.list.length, 1);
	todo.loadMore();
	todo = h.render();
	await tick();
	todo = h.render();
	assert.equal(todo.loadedPages, 2, "继续加载累计已加载页数");
	assert.equal(todo.hasMore, true);
	assert.equal(h.client.calls.list[1].cursor, "cursor-2", "用游标续页");
});

test("新建占位确认：身份映射事件把本地占位换成服务端事项，选中与未提交草稿一起迁移", async () => {
	const localView = view("todo_local_1", { sync: { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null } });
	const h = harness({ items: [localView] });
	let todo = h.render();
	await tick();
	todo = h.render();
	todo.select("todo_local_1");
	todo = h.render();
	todo.beginEdit(todo.selected);
	todo = h.render();
	todo.updateDraftField("title", "打字中的标题");
	todo = h.render();
	assert.equal(todo.draft?.itemId, "todo_local_1");

	// 主进程确认事件：明确的 old→new 身份（不靠标题；两条同名事项也不能互相顶掉）
	h.client.emit({ scope: SCOPE_A, reason: "queue", items: [view("todo_srv_1")], summary: SUMMARY, write: WRITE, reload: false, identityRemap: [{ from: "todo_local_1", to: "todo_srv_1" }] });
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_srv_1"], "本地占位必须被替换而不是并存（否则出现同标题幽灵行）");
	assert.equal(todo.selected?.item.id, "todo_srv_1", "选中迁到 serverID");
	assert.equal(todo.draft?.itemId, "todo_srv_1", "草稿归属迁到 serverID");
	assert.equal(todo.draft?.fields.title, "打字中的标题", "未提交输入保留");

	// 另一条同名事项仍在列表里：不去重、不互相顶掉
	h.client.emit({ scope: SCOPE_A, reason: "queue", items: [view("todo_srv_2", { item: item("todo_srv_2", { title: "打字中的标题" }) })], summary: SUMMARY, write: WRITE, reload: false });
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_srv_1", "todo_srv_2"], "真同名事项必须同时保留");
});

test("ACK 早于 submit 返回：后到的本地占位结果不得复活占位或把已确认版本降级", async () => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const localView = view("todo_local_1", { sync: { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null } });
	const h = harness({ items: [localView] });
	let todo = h.render();
	await tick();
	todo = h.render();

	// 提交在飞（服务端还没回）；pending 结果稍后会带回旧的本地占位
	h.client.setSubmitImpl(() => pending);
	const inflight = todo.createItem({ title: "新建", note: "", category: "", deadline: "", urgency: "" });
	todo = h.render();
	assert.equal(h.client.calls.submit.length, 1);

	// 确认事件先到：带 local→server 映射，列表里已经是云端确认条目
	h.client.emit({ scope: SCOPE_A, reason: "queue", items: [view("todo_srv_1")], summary: SUMMARY, write: WRITE, reload: false, identityRemap: [{ from: "todo_local_1", to: "todo_srv_1" }] });
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_srv_1"]);

	// 迟到的 submit 结果仍是 local 视图（confirmed 为空、revision 空）→ 必须被丢弃
	release({ ok: true, item: view("todo_local_1", { sync: { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null } }), summary: SUMMARY, write: WRITE, accepted: true, requestId: "req_late" });
	await inflight;
	todo = h.render();
	assert.deepEqual(plain(todo.items.map((entry) => entry.item.id)), ["todo_srv_1"], "迟到的本地占位结果不得重新插行");
	assert.equal(todo.items[0].item.revision, "rev-todo_srv_1", "不得把已确认版本降回空 revision");
	assert.equal(todo.items[0].sync.phase, "synced");
});

test("身份迁移保留 dirty 草稿：目标键已有更新输入时不覆盖，旧键总是让位", async () => {
	const drafts = loadTsCommonJs("src/renderer/src/utils/personalTodoDraft.ts", { stubs: { "../i18n": {} } });
	const base = { scopeKey: "s", itemId: "todo_local_1", baseRevision: "", base: { title: "", note: "", category: "", deadline: "", urgency: "" }, fields: { title: "旧输入", note: "", category: "", deadline: "", urgency: "" }, dirty: true, requestId: null, lastError: null };
	const newer = { ...base, itemId: "todo_srv_1", fields: { ...base.fields, title: "更新的输入" } };
	const migrated = drafts.remapPersonalTodoDrafts({ "s::todo_local_1": base }, "s", [{ from: "todo_local_1", to: "todo_srv_1" }]);
	assert.deepEqual(plain(Object.keys(migrated)), ["s::todo_srv_1"]);
	assert.equal(migrated["s::todo_srv_1"].fields.title, "旧输入", "无目标键时草稿随身份迁移");
	assert.equal(migrated["s::todo_srv_1"].itemId, "todo_srv_1");
	const kept = drafts.remapPersonalTodoDrafts({ "s::todo_local_1": base, "s::todo_srv_1": newer }, "s", [{ from: "todo_local_1", to: "todo_srv_1" }]);
	assert.equal(kept["s::todo_srv_1"].fields.title, "更新的输入", "目标键已有更新输入时不得被旧 dirty 覆盖");
	assert.equal("s::todo_local_1" in kept, false);
	assert.deepEqual(plain(drafts.remapPersonalTodoDrafts({}, "s", [{ from: "a", to: "b" }])), {}, "没有草稿时原样返回");
});
