/**
 * 旧阅读历史 hook 的连接边界回归（root 2026-10-14 补修）：
 * - fresh/未 ready：零历史请求（不能拿无条件 client 旁路 fresh 门）；
 * - ready：按连接身份读一次来源；
 * - 切 baseUrl：旧地址在飞响应必须作废，不得回填新连接；
 * - 断开（client 置空）：清空来源/列表/原话并作废在飞票据。
 *
 * 口径：真实 hook + 共享 React/Jotai 宿主（tests/helpers/readingHookHost.mjs），客户端为确定性 fake。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { createReadingHookHarness } from "./helpers/readingHookHost.mjs";

const tick = () => nextTask();

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function historySession(source, id) {
	return { source, id, title: `t-${id}`, bookLabel: null, chapterLabel: null, attribution: "bound", provider: null, model: null, updatedAt: null, counts: null, readable: true, error: null };
}

function createClient(options = {}) {
	const calls = { historySources: 0, listHistory: [], readHistorySession: [] };
	const sourceBatches = options.sourceBatches ?? null;
	return {
		calls,
		historySources: async () => {
			calls.historySources += 1;
			if (sourceBatches) return sourceBatches.shift()();
			return { ok: true, sources: [{ source: "deepread-current", label: "当前", root: "/r", count: 1, readable: true }] };
		},
		listHistory: async (query) => {
			calls.listHistory.push({ ...query });
			const impl = options.listHistory ?? (async () => ({ ok: true, source: query.source, sessions: [historySession(query.source, "s1")], nextCursor: null }));
			return impl(query);
		},
		readHistorySession: async (source, id) => {
			calls.readHistorySession.push({ source, id });
			return { ok: true, source, id, session: historySession(source, id), raw: "", truncated: false };
		},
	};
}

function loadHook(harness) {
	const { useReadingHistory } = harness.load("src/renderer/src/hooks/useReadingHistory.ts");
	return useReadingHistory;
}

test("未启用连接时零历史请求；ready 后按连接身份读一次来源", async () => {
	const harness = createReadingHookHarness();
	const useReadingHistory = loadHook(harness);
	const client = createClient();

	let history = harness.render(() => useReadingHistory({ client: null, connectionKey: null }));
	await tick();
	history = harness.render(() => useReadingHistory({ client: null, connectionKey: null }));
	assert.equal(client.calls.historySources, 0, "未 ready 时不得请求历史来源");
	assert.equal(history.clientAvailable, false);

	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	await tick();
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	assert.equal(client.calls.historySources, 1, "ready 后按连接读一次来源");
	assert.equal(history.sources.length, 1);
	assert.equal(history.clientAvailable, true);
});

test("切换 baseUrl：旧地址在飞响应不得回填新连接", async () => {
	const harness = createReadingHookHarness();
	const useReadingHistory = loadHook(harness);
	const first = deferred();
	const client = createClient({
		sourceBatches: [() => first.promise, () => ({ ok: true, sources: [{ source: "deepread-current", label: "B", root: "/b", count: 3, readable: true }] })],
	});

	let history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	await tick();
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	assert.equal(client.calls.historySources, 1, "第一次连接已发起来源读取");

	// 切到新地址：旧请求仍在飞
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:2222" }));
	await tick();
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:2222" }));
	assert.equal(client.calls.historySources, 2, "换地址必须按新连接重读");
	assert.equal(history.sources[0]?.label, "B");

	// 旧地址迟到：不得把 A 的来源写回新连接
	first.resolve({ ok: true, sources: [{ source: "deepread-current", label: "A", root: "/a", count: 9, readable: true }] });
	await tick();
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:2222" }));
	assert.equal(history.sources[0]?.label, "B", "旧地址迟到响应必须被丢弃");
});

test("断开连接：清空来源/列表/原话并作废在飞列表响应", async () => {
	const harness = createReadingHookHarness();
	const useReadingHistory = loadHook(harness);
	const pendingList = deferred();
	const client = createClient({ listHistory: async () => pendingList.promise });

	let history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	await tick();
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	assert.equal(history.sources.length, 1);

	void history.loadSource("deepread-current");
	history = harness.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	assert.equal(history.stateFor("deepread-current").loading, true);

	// 断开：client 置空（ReadingPage 在非 ready 时这样传）
	history = harness.render(() => useReadingHistory({ client: null, connectionKey: null }));
	await tick();
	history = harness.render(() => useReadingHistory({ client: null, connectionKey: null }));
	assert.equal(history.sources.length, 0, "断开必须清空来源");
	assert.equal(history.clientAvailable, false);

	// 旧列表迟到：不得回填
	pendingList.resolve({ ok: true, source: "deepread-current", sessions: [historySession("deepread-current", "s1")], nextCursor: null });
	await tick();
	history = harness.render(() => useReadingHistory({ client: null, connectionKey: null }));
	assert.deepEqual(JSON.parse(JSON.stringify(history.stateFor("deepread-current").sessions)), [], "断开后旧列表响应必须被丢弃");
});

test("卸载（关页）后旧响应不得写共享 Jotai：重开新挂载不被旧请求回填", async () => {
	// 关闭页面 = 卸载挂载；旧挂载的在飞请求必须被 cleanup 作废，不能写共享 atom 影响新挂载。
	const shared = createReadingHookHarness();
	const atoms = shared.load("src/renderer/src/atoms/reading-atoms.ts");
	const first = createReadingHookHarness({ store: shared.store });
	const { useReadingHistory } = first.load("src/renderer/src/hooks/useReadingHistory.ts", { "../atoms/reading-atoms": atoms });
	const pending = deferred();
	const client = createClient({ sourceBatches: [() => pending.promise] });

	let history = first.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	await tick();
	history = first.render(() => useReadingHistory({ client, connectionKey: "http://127.0.0.1:1111" }));
	assert.equal(client.calls.historySources, 1);
	first.unmount();

	const second = createReadingHookHarness({ store: shared.store });
	const { useReadingHistory: useReadingHistoryAfterRemount } = second.load("src/renderer/src/hooks/useReadingHistory.ts", { "../atoms/reading-atoms": atoms });
	let reopened = second.render(() => useReadingHistoryAfterRemount({ client: null, connectionKey: null }));
	await tick();
	reopened = second.render(() => useReadingHistoryAfterRemount({ client: null, connectionKey: null }));
	assert.equal(reopened.sources.length, 0);

	pending.resolve({ ok: true, sources: [{ source: "deepread-current", label: "A", root: "/a", count: 9, readable: true }] });
	await tick();
	reopened = second.render(() => useReadingHistoryAfterRemount({ client: null, connectionKey: null }));
	assert.equal(reopened.sources.length, 0, "关页后旧挂载的迟到响应不得回填共享 atom");
});
