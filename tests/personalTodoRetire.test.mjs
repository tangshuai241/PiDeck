/**
 * 待办「已退场占位」行为回归（P3 返工 R1）：本地占位被服务端 id 替换（identityRemap）后，
 * 任何迟到的列表/推送都不得把它重新插回列表，后续周期刷新也必须保持单一服务端行。
 *
 * 口径与 `personalTodoHook.test.mjs` 一致：加载真实生产 hook 与真实 Jotai，只替换 React 挂载层
 * 与桌面契约依赖；断言落在「事件/响应之后列表里有哪些 id、选中与草稿在哪」。
 *
 * 为什么单独成文件：这是审查退回的阻断项（迟到周期刷新复活已确认占位），需要一份可直接对照
 * 复现步骤的永久回归；不靠标题去重、不动纯合并函数的既有语义。
 */
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const SCOPE_A = { origin: "https://a.example", account: "alice", cloudInstanceId: "0.1.51", accountKey: "key-a" };
const SUMMARY = { pending: 0, sending: 0, conflict: 0, unknown: 0, error: 0, confirmedRecent: 0 };
const WRITE = { available: true, reason: null, verified: true };
const PENDING_SYNC = { phase: "pending", pendingCount: 1, lastError: null, cloudRevision: null, lastAttemptAt: null };

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

/** 未确认的本地占位（无云端 confirmed）。 */
function localPending(id, overrides = {}) {
	return view(id, { confirmed: null, sync: PENDING_SYNC, ...overrides });
}

/** 契约替身：可注入返回、可手动挂起 list（构造迟到响应）。 */
function createClient(options = {}) {
	const listeners = new Set();
	const calls = { list: [], submit: [], resolveConflict: [] };
	let scope = options.scope ?? SCOPE_A;
	let listImpl = options.list ?? (async () => listResult(options.items ?? [], options));
	let submitImpl = options.submit ?? (async () => ({ ok: false, error: { code: "internalError", message: "unused" } }));
	return {
		calls,
		getStatus: async () => ({ ok: true, status: { supported: true, scope, summary: SUMMARY, write: WRITE, lastFetchedAt: "2026-10-14T06:00:00Z", lastError: null } }),
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
		resolveConflict: async () => ({ ok: true, item: null, summary: SUMMARY }),
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
		unmount() {
			for (const slot of slots) {
				if (slot && typeof slot.cleanup === "function") slot.cleanup();
			}
			pendingEffects = [];
		},
	};
}

/** 页面可见期间会挂低频刷新计时器；测试替身要能收尾清理，否则残留 interval 会让进程不退出。 */
const activeTimers = new Set();
function trackedSetInterval(handler, ms) {
	const id = setInterval(handler, ms);
	activeTimers.add(id);
	return id;
}
function trackedClearInterval(id) {
	activeTimers.delete(id);
	clearInterval(id);
}
afterEach(() => {
	for (const id of activeTimers) clearInterval(id);
	activeTimers.clear();
});

function harness(options = {}) {
	const store = createStore();
	const client = createClient(options);
	const host = createHost(store);
	const { usePersonalTodo } = loadTsCommonJs("src/renderer/src/hooks/usePersonalTodo.ts", {
		stubs: { react: host.react, jotai: host.jotai, "../desktopApi": { desktopApi: { personalTodo: client } } },
		globals: { setInterval: trackedSetInterval, clearInterval: trackedClearInterval },
	});
	let controller = null;
	return {
		store,
		client,
		render: () => {
			controller = host.render(() =>
				usePersonalTodo({
					client,
					...(options.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: options.refreshIntervalMs }),
					...(options.foreground === undefined ? {} : { foreground: options.foreground }),
				}),
			);
			return controller;
		},
		unmount: () => host.unmount(),
		get controller() {
			return controller;
		},
	};
}

const tick = () => nextTask();
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** 前台信号替身：可见性与订阅由测试控制（本文件的迟到响应都从「回到前台立即刷新」触发）。 */
function createForeground() {
	let visible = true;
	const listeners = new Set();
	return {
		source: {
			isVisible: () => visible,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		setVisible: (next) => {
			visible = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

function listResult(items, overrides = {}) {
	return { ok: true, scope: overrides.scope ?? SCOPE_A, items, nextCursor: overrides.nextCursor ?? null, source: overrides.source ?? "cloud", fetchedAt: overrides.fetchedAt ?? "2026-10-14T06:00:00Z", summary: SUMMARY, write: WRITE };
}

const idsOf = (todo) => plain(todo.items.map((entry) => entry.item.id));

/** 身份替换事件：本地占位确认后被服务端 id 取代（主进程已证实 old→new）。 */
function remapEvent(remaps, items) {
	return { scope: SCOPE_A, reason: "queue", items, summary: SUMMARY, write: WRITE, reload: false, identityRemap: remaps };
}

test("迟到周期刷新不得复活已退场占位：迁移后的选中与草稿保留，后续刷新保持单一服务端行", async () => {
	const local = localPending("todo_local_1");
	const server = view("todo_srv_1");
	const foreground = createForeground();
	const h = harness({ items: [local], foreground: foreground.source, refreshIntervalMs: 60000 });
	h.render();
	await tick();
	h.render();
	// 打开编辑：选中占位并留一份未提交草稿，身份替换后应一起迁移
	h.controller.select("todo_local_1");
	h.render();
	h.controller.beginEdit(h.render().items[0]);
	h.render();
	h.controller.updateDraftField("note", "迁移中的草稿");
	h.render();

	// 挂起一次刷新（快照仍含本地占位）
	const late = deferred();
	h.client.setListImpl(() => late.promise);
	foreground.setVisible(true);
	await tick();
	assert.equal(h.client.calls.list.length, 2, "回到前台应立即发起一次刷新");

	// 队列确认先到：本地 id 退场，行/选中/草稿迁到服务端 id
	h.client.emit(remapEvent([{ from: "todo_local_1", to: "todo_srv_1" }], [server]));
	let todo = h.render();
	assert.deepEqual(idsOf(todo), ["todo_srv_1"], "身份替换后只保留服务端行");
	assert.equal(todo.selected?.item.id, "todo_srv_1", "选中迁移到服务端 id");
	assert.equal(todo.draft?.itemId, "todo_srv_1", "草稿迁移到服务端 id");
	assert.equal(todo.draft?.fields.note, "迁移中的草稿", "草稿内容保留");

	// 迟到的旧快照（仍含本地占位）返回：不得复活
	late.resolve(listResult([local]));
	await tick();
	todo = h.render();
	assert.deepEqual(idsOf(todo), ["todo_srv_1"], "迟到刷新不得复活已退场占位");
	assert.equal(todo.selected?.item.id, "todo_srv_1", "迟到刷新不得改变选中");
	assert.equal(todo.draft?.fields.note, "迁移中的草稿", "迟到刷新不得清掉草稿");

	// 后续正常刷新：保持单一服务端行
	h.client.setListImpl(async () => listResult([server]));
	foreground.setVisible(true);
	await tick();
	todo = h.render();
	assert.deepEqual(idsOf(todo), ["todo_srv_1"], "后续刷新必须保持唯一服务端行");
	assert.equal(todo.draft?.fields.note, "迁移中的草稿", "后续刷新不得清掉草稿");
	h.unmount();
});

test("迟到的替换响应不得复活已退场占位（替换快照缺席的新行由后续读取恢复，见报告 R2 限制）", async () => {
	const local = localPending("todo_local_1");
	const server = view("todo_srv_1");
	const h = harness({ items: [local] });
	h.render();
	await tick();
	h.client.emit(remapEvent([{ from: "todo_local_1", to: "todo_srv_1" }], [server]));
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"]);

	const late = deferred();
	h.client.setListImpl(() => late.promise);
	h.controller.refresh();
	h.render();
	await tick();
	assert.equal(h.client.calls.list.length, 2, "显式刷新应发起替换读取");
	late.resolve(listResult([local]));
	await tick();
	assert.equal(idsOf(h.render()).includes("todo_local_1"), false, "迟到的替换响应不得复活已退场占位");
	// 该响应早于身份替换，不含服务端行；替换读取“响应缺席即移除”的语义不改，下一次读取必须恢复
	h.client.setListImpl(async () => listResult([server]));
	h.controller.refresh();
	h.render();
	await tick();
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"], "后续替换读取必须恢复唯一服务端行");
	h.unmount();
});

test("迟到的追加分页响应不得复活已退场占位", async () => {
	const local = localPending("todo_local_1");
	const server = view("todo_srv_1");
	const h = harness({ list: async () => listResult([local], { nextCursor: "cursor-1" }) });
	h.render();
	await tick();
	assert.equal(h.render().hasMore, true);
	h.client.emit(remapEvent([{ from: "todo_local_1", to: "todo_srv_1" }], [server]));
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"]);

	const late = deferred();
	h.client.setListImpl(() => late.promise);
	h.controller.loadMore();
	await tick();
	assert.equal(h.client.calls.list.length, 2, "加载更多应发起一次追加读取");
	late.resolve(listResult([local]));
	await tick();
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"], "迟到的追加响应不得复活已退场占位");
	h.unmount();
});

test("迟到的推送不得复活已退场占位，但同批的新行照常合并", async () => {
	const local = localPending("todo_local_1");
	const server = view("todo_srv_1");
	const h = harness({ items: [local] });
	h.render();
	await tick();
	h.client.emit(remapEvent([{ from: "todo_local_1", to: "todo_srv_1" }], [server]));
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"]);

	h.client.emit({ scope: SCOPE_A, reason: "queue", items: [local, view("todo_extra")], summary: SUMMARY, write: WRITE, reload: false });
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1", "todo_extra"], "推送只丢弃已退场 id，新行照常合并");
	h.unmount();
});

test("退场过滤按 id 不按标题：同名但不同 id 的行不被误删", async () => {
	const retired = localPending("todo_local_1", { item: item("todo_local_1", { title: "同名标题" }) });
	const sibling = localPending("todo_local_2", { item: item("todo_local_2", { title: "同名标题" }) });
	const server = view("todo_srv_1", { item: item("todo_srv_1", { title: "同名标题" }) });
	const foreground = createForeground();
	const h = harness({ items: [retired], foreground: foreground.source, refreshIntervalMs: 60000 });
	h.render();
	await tick();
	h.render();
	h.client.emit(remapEvent([{ from: "todo_local_1", to: "todo_srv_1" }], [server]));
	assert.deepEqual(idsOf(h.render()), ["todo_srv_1"]);

	// 另一条同名但不同 id 的本地行进入列表：不能被当成退场行删掉
	h.client.emit({ scope: SCOPE_A, reason: "queue", items: [sibling], summary: SUMMARY, write: WRITE, reload: false });
	let todo = h.render();
	assert.deepEqual(idsOf(todo), ["todo_srv_1", "todo_local_2"], "同名不同 id 的行必须保留");

	// 周期刷新响应只含服务端行：同名本地行有未确认工作，仍按刷新保护策略保留
	h.client.setListImpl(async () => listResult([server]));
	foreground.setVisible(true);
	await tick();
	todo = h.render();
	assert.deepEqual(idsOf(todo), ["todo_srv_1", "todo_local_2"], "刷新不得误删同名本地行");
	assert.equal(todo.items.find((entry) => entry.item.id === "todo_local_2")?.item.title, "同名标题");
	assert.equal(idsOf(todo).includes("todo_local_1"), false, "同名不能成为复活退场行的理由");
	h.unmount();
});
