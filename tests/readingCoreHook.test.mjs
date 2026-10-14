/**
 * 阅读核心 hook 的行为复现（先红后绿）：重挂时已有的选中版本必须拿到版本，
 * 且不能因为重挂多打一次网络；IPC 拒绝要收尾成可见错误；切书迟到的版本响应仍然丢弃。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { createReadingHookHarness } from "./helpers/readingHookHost.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => nextTask();

test("重启后按服务缓存恢复已存在的版本，并登记有效请求票据", async () => {
	const cache = new Map();
	const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: (key) => cache.delete(key) };
	const first = createReadingHookHarness();
	const { useReadingCore } = first.load("src/renderer/src/hooks/useReadingCore.ts");
	const client = createClient();
	let core = first.render(() => useReadingCore({ client, selectionStorage: storage }));
	await tick();
	core = first.render(() => useReadingCore({ client, selectionStorage: storage }));
	core.selectBook({ workId: "w1", editionId: "e1" });
	first.unmount();
	// 全新的 Jotai store 模拟应用重启，不能靠旧 atom 伪装恢复。
	const second = createReadingHookHarness();
	const { useReadingCore: reopenedHook } = second.load("src/renderer/src/hooks/useReadingCore.ts");
	let reopened = second.render(() => reopenedHook({ client, selectionStorage: storage }));
	for (let step = 0; step < 4; step += 1) {
		await tick();
		reopened = second.render(() => reopenedHook({ client, selectionStorage: storage }));
	}
	assert.deepEqual(plain(reopened.selected), { workId: "w1", editionId: "e1" });
	await tick();
	reopened = second.render(() => reopenedHook({ client, selectionStorage: storage }));
	assert.equal(reopened.edition?.identity.editionId, "e1");
});

function identity(workId, editionId) {
	return { workId, editionId, contentVersion: `v-${editionId}`, filename: `${editionId}.epub`, size: 1024 };
}

function createClient(options = {}) {
	const calls = { getStatus: 0, listLibrary: 0, getEdition: [], getChapter: [], resolveQuote: [] };
	let editionImpl =
		options.getEdition ??
		(async (workId, editionId) => ({
			ok: true,
			edition: { identity: identity(workId, editionId), toc: [{ pos: 1, href: "OEBPS/c1.xhtml", title: "第一章", isChapter: true, chapterNum: 1, mapStatus: "chapter" }], spine: [], analysis: null },
		}));
	let statusImpl =
		options.getStatus ?? (async () => ({ ok: true, status: { availability: "ready", connection: { baseUrl: "http://127.0.0.1:18965", connected: true, authRequired: null, credentialStored: false, rememberPassword: false, lastError: null, lastConnectedAt: null }, notesApi: true, historyApi: true, dataDir: "/tmp" } }));
	return {
		calls,
		getStatus: async () => {
			calls.getStatus += 1;
			return statusImpl();
		},
		connect: async () => ({ ok: true, status: (await statusImpl()).status }),
		disconnect: async () => ({ ok: true, status: (await statusImpl()).status }),
		listLibrary: async () => {
			calls.listLibrary += 1;
			return {
				ok: true,
				works: [
					{
						workId: "w1",
						title: "书",
						author: null,
						editionCount: 2,
						editions: [
							{ editionId: "e1", rel: "a.epub", size: 1, mtime: 0, title: null },
							{ editionId: "e2", rel: "b.epub", size: 1, mtime: 0, title: null },
						],
					},
				],
				fetchedAt: "2026-10-14T10:00:00.000Z",
			};
		},
		getEdition: async (workId, editionId) => {
			calls.getEdition.push({ workId, editionId });
			return editionImpl(workId, editionId);
		},
		getChapter: async (workId, editionId, chapter) => {
			calls.getChapter.push({ workId, editionId, chapter });
			return { ok: true, identity: identity(workId, editionId), chapter: { chapterNum: 1, title: "第一章", href: String(chapter), text: "正文", wordCount: 2, textDigest: null, offsetUnit: "unicode_code_point" } };
		},
		resolveQuote: async (quoteInput) => {
			calls.resolveQuote.push(plain(quoteInput));
			const impl = options.resolveQuote ?? (async (text) => ({ ok: true, identity: identity(quoteInput.workId, quoteInput.editionId), status: "exact", candidates: [], candidatesTruncated: false, note: text }));
			return impl(quoteInput.text, quoteInput);
		},
		setEditionImpl(next) {
			editionImpl = next;
		},
	};
}

test("重新挂载时已有的选中版本仍然拿到版本，且不额外重复请求", async () => {
	// 重挂的忠实模拟：atom 模块只加载一次（共享同一批 atom 实例），两个挂载宿主共享同一 store，
	// 各自持有独立的 React 槽位——这才是「关页重开」而不是「同一挂载重复渲染」。
	const shared = createReadingHookHarness();
	const atoms = shared.load("src/renderer/src/atoms/reading-atoms.ts");
	const first = createReadingHookHarness({ store: shared.store });
	const { useReadingCore } = first.load("src/renderer/src/hooks/useReadingCore.ts", { "../atoms/reading-atoms": atoms });
	const client = createClient();

	let core = first.render(() => useReadingCore({ client }));
	await tick();
	core = first.render(() => useReadingCore({ client }));
	core.selectBook({ workId: "w1", editionId: "e1" });
	core = first.render(() => useReadingCore({ client }));
	await tick();
	core = first.render(() => useReadingCore({ client }));
	assert.equal(core.edition?.identity.editionId, "e1", "首次选择版本必须加载");
	assert.equal(client.calls.getEdition.length, 1);

	// 关页重开：Jotai atom 仍保留选中版本与已加载的版本视图
	const second = createReadingHookHarness({ store: shared.store });
	const { useReadingCore: useReadingCoreAfterRemount } = second.load("src/renderer/src/hooks/useReadingCore.ts", { "../atoms/reading-atoms": atoms });
	let reopened = second.render(() => useReadingCoreAfterRemount({ client }));
	await tick();
	reopened = second.render(() => useReadingCoreAfterRemount({ client }));
	assert.equal(reopened.selected?.editionId, "e1", "重挂后选中版本仍是 e1");
	assert.equal(reopened.editionLoading, false, "不得停在加载态");
	assert.equal(reopened.edition?.identity.editionId, "e1", "重挂后已有选中版本必须仍能拿到版本（票据不能是空的）");
	assert.equal(client.calls.getEdition.length, 1, "重挂不应重复请求同一个版本");
	assert.equal(client.calls.getStatus, 2, "每次打开页面各读一次状态（不叠加）");
});

test("切书迟到响应仍然丢弃：只保留当前选中版本的版本视图", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	let resolveA = null;
	const client = createClient({
		getEdition: (workId, editionId) =>
			editionId === "e1"
				? new Promise((resolve) => {
						resolveA = resolve;
					})
				: Promise.resolve({ ok: true, edition: { identity: identity(workId, editionId), toc: [], spine: [], analysis: null } }),
	});

	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	core.selectBook({ workId: "w1", editionId: "e1" });
	core = harness.render(() => useReadingCore({ client }));
	core = harness.render(() => useReadingCore({ client }));
	core.selectBook({ workId: "w1", editionId: "e2" });
	core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.edition?.identity.editionId, "e2", "当前选中版本是 e2");

	resolveA({ ok: true, edition: { identity: identity("w1", "e1"), toc: [], spine: [], analysis: null } });
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.edition?.identity.editionId, "e2", "e1 的迟到响应不得覆盖当前版本");
});

test("IPC 拒绝时收尾成可见错误，不停在加载态", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	const client = createClient({ getEdition: async () => Promise.reject(new Error("ipc down")) });

	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	core.selectBook({ workId: "w1", editionId: "e1" });
	core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.editionLoading, false, "拒绝后必须退出加载态");
	assert.equal(core.editionError?.code, "internalError", "拒绝要变成可见的结构化错误");
	assert.equal(core.edition, null);
});

test("状态读取被拒绝时也收尾成可见错误", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	const client = createClient({ getStatus: async () => Promise.reject(new Error("ipc down")) });

	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.statusLoading, false, "拒绝后必须退出加载态");
	assert.equal(core.statusError?.code, "internalError");
	assert.equal(core.decision.kind, "unavailable", "读取失败要如实显示不可用，而不是加载中");
});

function quoteResult(note, workId, editionId) {
	return { ok: true, identity: identity(workId, editionId), status: "exact", candidates: [], candidatesTruncated: false, note };
}

function mountCore(client) {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	let core = harness.render(() => useReadingCore({ client }));
	return {
		harness,
		get core() {
			return core;
		},
		render: () => {
			core = harness.render(() => useReadingCore({ client }));
			return core;
		},
	};
}

/** 选版本 + 打开一章；返回渲染后的控制器（含 await 让版本/正文响应落地）。 */
async function openBookChapter(page, editionId, href = "OEBPS/c1.xhtml", chapterNum = 1) {
	let core = page.render();
	core.selectBook({ workId: "w1", editionId });
	core = page.render();
	await tick();
	core = page.render();
	core.openChapter({ pos: chapterNum, href, title: "章", isChapter: true, chapterNum, mapStatus: "chapter" });
	core = page.render();
	await tick();
	return page.render();
}

test("核验票据：A→B→A 的旧回执一律丢弃，当前选择仍可正常核验", async () => {
	const pendingText = new Map();
	const client = createClient({
		resolveQuote: (text) =>
			new Promise((resolve) => {
				pendingText.set(text, resolve);
			}),
	});
	const page = mountCore(client);
	await tick();
	page.render();

	let core = await openBookChapter(page, "e1");
	let first = core.verifySelection("甲");
	core = page.render();
	assert.equal(core.selection.verifying, true, "核验在飞");

	// 切到另一版本：上一书的选区不得继续当作当前书的选区
	core = await openBookChapter(page, "e2");
	assert.equal(core.selection.quote, null, "切书必须清掉上一书的选区展示");
	assert.equal(core.selection.verifying, false, "切书后不得残留上一书的核验中状态");
	let second = core.verifySelection("乙");
	core = page.render();
	assert.equal(core.selection.verifying, true);

	// 切回 A 并发起新的核验「丙」
	core = await openBookChapter(page, "e1");
	const third = core.verifySelection("丙");
	core = page.render();
	assert.equal(core.selection.verifying, true);

	// B 的回执（现在属于旧书）到达：不得回填，也不得收掉丙的 verifying
	pendingText.get("乙")(quoteResult("乙", "w1", "e2"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote, null, "旧书回执不得回填当前选区");
	assert.equal(core.selection.verifying, true, "旧回执不得收掉新核验的 verifying");

	// 丙的回执到达：正常核验
	pendingText.get("丙")(quoteResult("丙", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote?.note, "丙", "当前选择的回执正常落地");
	assert.equal(core.selection.verifying, false);

	// 最早的甲回执最晚到达：同样丢弃（不能靠对象相等误判）
	pendingText.get("甲")(quoteResult("甲", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote?.note, "丙", "最早的旧回执不得覆盖当前核验结果");
	assert.equal(core.selection.verifying, false);

	const settled = await Promise.all([first, second, third]);
	assert.equal(settled.length, 3);
});

test("同书连续核验只允许最新；换章与清选区都会作废在飞核验并收尾 verifying", async () => {
	const pendingText = new Map();
	const client = createClient({
		resolveQuote: (text) =>
			new Promise((resolve) => {
				pendingText.set(text, resolve);
			}),
	});
	const page = mountCore(client);
	await tick();
	page.render();
	let core = await openBookChapter(page, "e1");

	core.verifySelection("甲1");
	core = page.render();
	core.verifySelection("甲2");
	core = page.render();
	assert.equal(core.selection.verifying, true);
	pendingText.get("甲2")(quoteResult("甲2", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote?.note, "甲2", "最新的同书核验先落地");
	pendingText.get("甲1")(quoteResult("甲1", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote?.note, "甲2", "同书旧核验不得回填");

	// 换章：在飞核验作废，且必须收尾当前 verifying
	core.verifySelection("甲3");
	core = page.render();
	assert.equal(core.selection.verifying, true);
	core.openChapter({ pos: 2, href: "OEBPS/c2.xhtml", title: "第二章", isChapter: true, chapterNum: 2, mapStatus: "chapter" });
	core = page.render();
	await tick();
	core = page.render();
	pendingText.get("甲3")(quoteResult("甲3", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.verifying, false, "换章后旧核验不得把 verifying 卡在 true");
	assert.notEqual(core.selection.quote?.note, "甲3", "换章后旧核验不得回填");

	// 清选区：在飞核验同样作废
	core.verifySelection("甲4");
	core = page.render();
	core.clearSelection();
	core = page.render();
	assert.equal(core.selection.verifying, false);
	pendingText.get("甲4")(quoteResult("甲4", "w1", "e1"));
	await tick();
	core = page.render();
	assert.equal(core.selection.quote, null, "清选区后旧核验不得把它写回来");
	assert.equal(core.selection.verifying, false);
});

test("未探测且从未成功：不读书库、显示连接面板（fresh 不扫默认 18965）", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	const client = createClient({
		getStatus: async () => ({
			ok: true,
			status: { availability: "unknown", connection: { baseUrl: "http://127.0.0.1:18965", connected: false, authRequired: null, credentialStored: false, rememberPassword: false, lastError: null, lastConnectedAt: null }, notesApi: null, historyApi: null, dataDir: "/tmp" },
		}),
	});
	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.decision.kind, "needsConnection", "无成功历史时显示连接面板而非 loading");
	assert.equal(client.calls.listLibrary, 0, "没有成功历史时不得扫库/访问默认端口");
	assert.equal(client.calls.getStatus, 1);
});

test("曾有成功连接：自动读库并在状态仍未知时复核一次（不额外扫业务）", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	const priorConnection = { baseUrl: "http://127.0.0.1:18965", connected: false, authRequired: null, credentialStored: false, rememberPassword: false, lastError: null, lastConnectedAt: "2026-10-14T10:00:00.000Z" };
	const client = createClient({
		getStatus: async () => ({
			ok: true,
			status: { availability: client.calls.listLibrary > 0 ? "ready" : "unknown", connection: priorConnection, notesApi: null, historyApi: null, dataDir: "/tmp" },
		}),
	});
	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(client.calls.listLibrary, 1, "有成功历史时照旧自动读库恢复");
	assert.equal(core.decision.kind, "ready", "读库成功后复核状态应收口为 ready，不得停在 loading");
	assert.equal(client.calls.getStatus, 2, "仅在状态仍为 unknown 时复核一次");
});

test("getStatus 失败不继续读书库（错误分支优先）", async () => {
	const harness = createReadingHookHarness();
	const { useReadingCore } = harness.load("src/renderer/src/hooks/useReadingCore.ts");
	const client = createClient({ getStatus: async () => ({ ok: false, error: { code: "unavailable", message: "down" } }) });
	let core = harness.render(() => useReadingCore({ client }));
	await tick();
	core = harness.render(() => useReadingCore({ client }));
	assert.equal(core.decision.kind, "unavailable");
	assert.equal(client.calls.listLibrary, 0, "状态读不到时不得继续扫库");
});
