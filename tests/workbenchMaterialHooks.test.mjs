/**
 * P04 工作台材料 / 阅读会话绑定 hook 行为测试。
 *
 * 口径：加载真实生产 hook；只替换 React 挂载层、jotai 的 useStore 与两个契约边界
 *（composer 原子写入口、desktopApi.reading.*）。断言落在「点了之后状态是什么、写了哪个会话」。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const tick = () => nextTask();
const plain = (value) => JSON.parse(JSON.stringify(value));

/** React 替身：槽位按调用顺序复用；effect 在渲染后统一执行（依赖不变则不重跑）。 */
function createHost(store, extraJotai = {}) {
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
	const jotai = { useStore: () => store, ...extraJotai };
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

const READING_MATERIAL = {
	kind: "reading_segment",
	workId: "w1",
	editionId: "e1",
	contentVersion: "v1",
	workTitle: "书名",
	editionTitle: null,
	chapterHref: "ch1.xhtml",
	chapterNum: 1,
	chapterTitle: "第一章",
	start: 0,
	end: 4,
	verify: "exact",
	text: "选中原文",
	capturedAt: "2026-10-15T00:00:00.000Z",
};

/** 原子替身：与生产 composer-atoms 同写语义（追加不覆盖、空则删键），供 hook 真实读写。 */
function createComposerAtoms() {
	const sessionDraftByIdAtom = atom({});
	const sessionQuotesByIdAtom = atom({});
	const setSessionDraftAtom = atom(null, (get, set, input) => {
		const drafts = { ...get(sessionDraftByIdAtom) };
		const current = drafts[input.sessionId] ?? "";
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		if (nextValue) drafts[input.sessionId] = nextValue;
		else delete drafts[input.sessionId];
		set(sessionDraftByIdAtom, drafts);
	});
	const setSessionQuotesAtom = atom(null, (get, set, input) => {
		const quotes = { ...get(sessionQuotesByIdAtom) };
		const current = quotes[input.sessionId] ?? {};
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		if (Object.keys(nextValue).length > 0) quotes[input.sessionId] = nextValue;
		else delete quotes[input.sessionId];
		set(sessionQuotesByIdAtom, quotes);
	});
	return { sessionDraftByIdAtom, sessionQuotesByIdAtom, setSessionDraftAtom, setSessionQuotesAtom };
}

function materialHarness() {
	const store = createStore();
	const atoms = createComposerAtoms();
	const host = createHost(store);
	const { useWorkbenchMaterial } = loadTsCommonJs("src/renderer/src/hooks/useWorkbenchMaterial.ts", {
		stubs: {
			react: host.react,
			jotai: host.jotai,
			"../atoms/composer-atoms": atoms,
		},
	});
	const controller = host.render(() => useWorkbenchMaterial());
	return { store, atoms, controller };
}

test("useWorkbenchMaterial：只写目标会话草稿与快照，不触碰当前/其它会话", () => {
	const h = materialHarness();
	h.store.set(h.atoms.sessionDraftByIdAtom, { "sess-active": "当前会话的文字", "sess-a": "A 的原文字" });
	const report = h.controller.appendMaterial({ sessionId: "sess-a", material: READING_MATERIAL, now: 7, createId: () => "q12345678" });
	assert.equal(report.sessionId, "sess-a");
	assert.equal(report.duplicate, false);

	const drafts = plain(h.store.get(h.atoms.sessionDraftByIdAtom));
	assert.equal(drafts["sess-active"], "当前会话的文字", "不得写当前会话");
	assert.equal(drafts["sess-a"], "A 的原文字 #q12345678 ", "只向目标会话追加 token，原文字保留");
	const quotes = plain(h.store.get(h.atoms.sessionQuotesByIdAtom));
	assert.equal(quotes["sess-active"], undefined);
	assert.deepEqual(quotes["sess-a"].q12345678.material, READING_MATERIAL);
	assert.equal(quotes["sess-a"].q12345678.messageId, "");
});

test("useWorkbenchMaterial：同材料重复带入只报 duplicate，不追加第二个 chip", () => {
	const h = materialHarness();
	h.store.set(h.atoms.sessionDraftByIdAtom, { "sess-a": "原文字" });
	const first = h.controller.appendMaterial({ sessionId: "sess-a", material: READING_MATERIAL, createId: () => "qaaaaaaaa" });
	const second = h.controller.appendMaterial({ sessionId: "sess-a", material: READING_MATERIAL, createId: () => "qbbbbbbbb" });
	assert.equal(second.duplicate, true);
	assert.equal(second.snippetId, first.snippetId);
	const drafts = plain(h.store.get(h.atoms.sessionDraftByIdAtom));
	assert.equal(drafts["sess-a"].split("#q").length - 1, 1, "目标会话草稿里只有一个材料 token");
	const quotes = plain(h.store.get(h.atoms.sessionQuotesByIdAtom));
	assert.deepEqual(Object.keys(quotes["sess-a"]), [first.snippetId]);
});

function bindingHarness(fakeReading) {
	const store = createStore();
	const host = createHost(store);
	const { useReadingSessionBinding } = loadTsCommonJs("src/renderer/src/hooks/useReadingSessionBinding.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: { reading: fakeReading } },
		},
	});
	return { store, host, useReadingSessionBinding };
}

/** 可手动结算的 Promise，用来构造 A/B 迟到响应。 */
function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const BINDING_A = { workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1", createdAt: "2026-10-15T00:00:00.000Z", lastUsedAt: "2026-10-15T00:00:00.000Z" };
const BINDING_B = { ...BINDING_A, workId: "w2", editionId: "e2", sessionId: "sess-b" };

test("useReadingSessionBinding：解析结果落到状态；切版本后 A 的迟到结果被丢弃", async () => {
	const pendingA = deferred();
	const fakeReading = {
		resolveBinding: (ref) => (ref.workId === "w1" ? pendingA.promise : Promise.resolve({ ok: true, binding: BINDING_B, sessionExists: true, stale: false, reason: "none" })),
		bindSession: async () => ({ ok: false, error: { code: "invalidInput", message: "unused" } }),
		unbindSession: async () => ({ ok: true, removed: false }),
	};
	const h = bindingHarness(fakeReading);
	let controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	// 首次渲染后 effect 已发起解析（setState 在渲染外发生，需再渲染一次才能观测到新状态）
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	assert.equal(controller.state.loading, true, "解析中必须显式进入加载态");

	// 切到 B：A 的请求仍在飞，必须先被丢弃
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w2", editionId: "e2" }));
	await tick();
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w2", editionId: "e2" }));
	assert.equal(controller.state.binding.sessionId, "sess-b");

	// A 迟到回包：不得写进当前 B 的作用域状态
	pendingA.resolve({ ok: true, binding: BINDING_A, sessionExists: true, stale: false, reason: "none" });
	await tick();
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w2", editionId: "e2" }));
	assert.equal(controller.state.binding.sessionId, "sess-b", "A 书迟到结果不得覆盖 B 书状态");
});

test("useReadingSessionBinding：bind 成功更新状态；作用域切换后旧 bind 回包不覆盖", async () => {
	const pendingBind = deferred();
	const fakeReading = {
		resolveBinding: async (ref) => ({ ok: true, binding: ref.workId === "w1" ? null : BINDING_B, sessionExists: ref.workId !== "w1", stale: false, reason: ref.workId === "w1" ? "missing" : "none" }),
		bindSession: () => pendingBind.promise,
		unbindSession: async () => ({ ok: true, removed: true }),
	};
	const h = bindingHarness(fakeReading);
	let controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	await tick();
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	assert.equal(controller.state.reason, "missing");

	const bindPromise = controller.bind({ sessionId: "sess-a", projectId: "proj-1" });
	// 切到 B（B 有绑定），随后 A 的 bind 才回包
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w2", editionId: "e2" }));
	await tick();
	pendingBind.resolve({ ok: true, binding: BINDING_A });
	const result = await bindPromise;
	assert.equal(result.ok, true, "显式绑定本身是成功的（已写入主进程）");
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w2", editionId: "e2" }));
	assert.equal(controller.state.binding.sessionId, "sess-b", "旧作用域的绑定结果不得覆盖当前状态");
});

test("useReadingSessionBinding：会话已删（stale）如实回报，不静默替换；unbind 回到 missing", async () => {
	const stale = { workId: "w1", editionId: "e1", sessionId: "sess-gone", projectId: "proj-1", createdAt: "2026-10-15T00:00:00.000Z", lastUsedAt: "2026-10-15T00:00:00.000Z" };
	let removed = false;
	const fakeReading = {
		resolveBinding: async () => (removed ? { ok: true, binding: null, sessionExists: false, stale: false, reason: "missing" } : { ok: true, binding: stale, sessionExists: false, stale: true, reason: "sessionMissing" }),
		bindSession: async () => ({ ok: true, binding: stale }),
		unbindSession: async () => {
			removed = true;
			return { ok: true, removed: true };
		},
	};
	const h = bindingHarness(fakeReading);
	let controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	await tick();
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	assert.equal(controller.state.stale, true);
	assert.equal(controller.state.reason, "sessionMissing");
	assert.equal(controller.state.binding.sessionId, "sess-gone", "stale 时保留原绑定供用户确认重绑");
	assert.equal(controller.state.sessionExists, false);

	const result = await controller.unbind();
	assert.equal(result.ok, true);
	controller = h.host.render(() => h.useReadingSessionBinding({ workId: "w1", editionId: "e1" }));
	assert.equal(controller.state.binding, null);
	assert.equal(controller.state.reason, "missing");
});
