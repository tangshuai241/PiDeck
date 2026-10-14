/**
 * P04 修正轮：阅读材料带入控制器的竞态回归（useReadingMaterialBring）。
 *
 * 覆盖评审指出的真实竞态与边界：
 * - 延迟新建会话期间 A→B：不把 A 的新会话绑到 B、不带入材料，但已创建会话必须登记保留；
 * - 延迟绑定期间 A→B→A：epoch 已推进，迟到完成丢弃（即使来源身份看起来又一致）；
 * - 同步带入要求绑定会话仍存在；stale 一律走显式重绑，不自动带入；
 * - 旧书快照混进当前 props 时拒绝带入；选区替换重置 picker/notice；卸载作废在飞完成。
 *
 * 口径：真实生产 hook + 共享 React/Jotai 替身宿主（tests/helpers/readingHookHost.mjs），
 * 契约依赖全部注入 fake；延迟用可控 deferred，不作时序假设。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { createReadingHookHarness } from "./helpers/readingHookHost.mjs";

const tick = () => nextTask();
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function snapshot(overrides = {}) {
	return {
		workId: "w1",
		editionId: "e1",
		contentVersion: "cv1",
		chapterHref: "ch1",
		chapterNum: 1,
		text: "选中原文",
		start: 3,
		end: 9,
		capturedAt: "2026-10-15T00:00:00.000Z",
		...overrides,
	};
}

function quote(status = "exact") {
	return { ok: true, identity: { workId: "w1", editionId: "e1", contentVersion: "cv1", filename: null, size: null }, status, candidates: [], candidatesTruncated: false, note: null };
}

function source(overrides = {}) {
	return {
		workId: "w1",
		editionId: "e1",
		contentVersion: "cv1",
		chapterHref: "ch1",
		chapterNum: 1,
		workTitle: "书",
		editionTitle: null,
		chapterTitle: "第一章",
		selection: { snapshot: snapshot(), quote: quote() },
		projectId: "proj-1",
		...overrides,
	};
}

const SOURCE_B = source({
	workId: "w2",
	editionId: "e2",
	contentVersion: "cv2",
	chapterHref: "ch2",
	chapterNum: 2,
	chapterTitle: "第二章",
	selection: { snapshot: snapshot({ workId: "w2", editionId: "e2", contentVersion: "cv2", chapterHref: "ch2", capturedAt: "2026-10-16T00:00:00.000Z", text: "B 书原文" }), quote: quote() },
});

function bindingRecord(sessionId, workId = "w1", editionId = "e1") {
	return { workId, editionId, sessionId, projectId: "proj-1", createdAt: "2026-10-15T00:00:00.000Z", lastUsedAt: "2026-10-15T00:00:00.000Z" };
}

function makeDeps() {
	const calls = { bind: [], append: [], create: [], register: [], unbind: [] };
	const bindingState = { loading: false, binding: null, sessionExists: false, stale: false, reason: "missing", error: null };
	const deps = {
		binding: {
			state: bindingState,
			refresh: async () => undefined,
			bind: async (input) => {
				calls.bind.push(input);
				return { ok: true, binding: { workId: input.ref?.workId ?? "w1", editionId: input.ref?.editionId ?? "e1", sessionId: input.sessionId, projectId: input.projectId, createdAt: "t", lastUsedAt: "t" } };
			},
			unbind: async (ref) => {
				calls.unbind.push(ref);
				return { ok: true, removed: true };
			},
		},
		appendMaterial: (input) => {
			calls.append.push(input);
			return { duplicate: false };
		},
		createDraft: async (input) => {
			calls.create.push(input);
			return { id: "sess-new", projectId: input.projectId };
		},
		registerSession: (session) => calls.register.push(session),
		readSession: (sessionId) => ({ id: sessionId, projectId: "proj-1" }),
		newSessionTitle: () => "阅读工作台会话",
	};
	return { calls, bindingState, deps };
}

function loadHook() {
	const harness = createReadingHookHarness();
	const { useReadingMaterialBring } = harness.load("src/renderer/src/hooks/useReadingMaterialBring.ts");
	return { harness, useReadingMaterialBring };
}

test("延迟新建会话期间切到 B：不绑定到 B、不带入材料，已创建会话保留登记", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	const pendingCreate = deferred();
	deps.createDraft = () => {
		calls.create.push({ projectId: "proj-1" });
		return pendingCreate.promise;
	};

	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.createAndBind();
	await tick();

	// A 书的新建请求还没回来，用户切到 B 书
	controller = harness.render(() => useReadingMaterialBring(SOURCE_B, deps));
	pendingCreate.resolve({ id: "sess-new", projectId: "proj-1" });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(SOURCE_B, deps));

	assert.equal(calls.register.length, 1, "已创建的新会话必须登记保留（不删除/不回滚）");
	assert.equal(calls.register[0].id, "sess-new");
	assert.equal(calls.bind.length, 0, "来源已切换：不得把 A 的新会话绑定到当前书");
	assert.equal(calls.append.length, 0, "来源已切换：不得带入材料");
	assert.equal(controller.notice, null, "迟到完成不得在当前页报成功");
	assert.deepEqual(calls.create, [{ projectId: "proj-1" }]);
});

test("延迟绑定期间 A→B→A：显式带点击时 ref，迟到完成仍被 epoch 丢弃", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, bindingState, deps } = makeDeps();
	const pendingBind = deferred();
	deps.binding.bind = (input) => {
		calls.bind.push(input);
		return pendingBind.promise;
	};

	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	// 切到 B 再切回 A：身份文本一致但 epoch 已推进，旧完成不得生效
	controller = harness.render(() => useReadingMaterialBring(SOURCE_B, deps));
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	pendingBind.resolve({ ok: true, binding: bindingRecord("sess-a") });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));

	assert.equal(calls.bind.length, 1);
	assert.deepEqual(plain(calls.bind[0].ref), { workId: "w1", editionId: "e1" }, "bind 必须显式带点击时的来源 ref");
	assert.equal(calls.append.length, 0, "A→B→A 的迟到完成必须丢弃，不得带入材料");
	assert.equal(controller.notice, null);
	assert.equal(controller.busy, false, "来源切换后 busy 不得残留");
	assert.equal(bindingState.binding, null);
});

test("绑定并带入成功路径：显式 ref + 目标会话 + bound 通知", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.bind.length, 1);
	assert.deepEqual(plain(calls.bind[0].ref), { workId: "w1", editionId: "e1" });
	assert.equal(calls.append.length, 1);
	assert.equal(calls.append[0].sessionId, "sess-a");
	assert.equal(controller.notice, "bound");
	assert.equal(controller.busy, false);
});

test("同步带入：绑定会话存在才追加；stale 要求显式重绑，不自动带入", () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, bindingState, deps } = makeDeps();
	bindingState.binding = bindingRecord("sess-a");
	bindingState.sessionExists = true;

	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.append.length, 1, "绑定有效时应追加进该会话");
	assert.equal(calls.append[0].sessionId, "sess-a");
	assert.equal(controller.notice, "brought");

	// 会话被删（stale）：不得自动带入，也不得静默替换绑定
	bindingState.sessionExists = false;
	bindingState.stale = true;
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.append.length, 1, "stale 不得追加材料");
	assert.equal(calls.bind.length, 0, "stale 不得静默重新绑定");
	assert.equal(controller.errorKey, "workbenchMaterial.errorBindUnavailable");
});

test("旧书快照混进当前来源时拒绝带入（身份校验不靠调用方）", () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, bindingState, deps } = makeDeps();
	bindingState.binding = bindingRecord("sess-a");
	bindingState.sessionExists = true;
	// 来源自称 w1/e1，但快照来自旧书 w-old：材料身份与当前来源不符
	const mismatched = source({ selection: { snapshot: snapshot({ workId: "w-old", chapterHref: "ch-old" }), quote: quote() } });
	let controller = harness.render(() => useReadingMaterialBring(mismatched, deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(mismatched, deps));
	assert.equal(calls.append.length, 0, "跨书旧快照不得带入");
	assert.equal(controller.errorKey, "workbenchMaterial.errorMaterial");
});

test("选区替换重置 picker/notice；unbind 用点击时 ref，不碰其它书", () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.openPicker();
	controller.selectTarget("sess-a");
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(controller.pickerOpen, true);
	assert.equal(controller.picked, "sess-a");

	// 同一本书内换了选区（新 capturedAt）：交互态重置，避免把旧的选中目标带到新材料上
	const replaced = source({ selection: { snapshot: snapshot({ capturedAt: "2026-10-17T00:00:00.000Z", text: "新选区" }), quote: quote() } });
	harness.render(() => useReadingMaterialBring(replaced, deps));
	controller = harness.render(() => useReadingMaterialBring(replaced, deps));
	assert.equal(controller.pickerOpen, false);
	assert.equal(controller.picked, null);

	controller.unbindBound();
	assert.deepEqual(plain(calls.unbind), [{ workId: "w1", editionId: "e1" }], "解绑必须带点击时 ref");
});

test("卸载作废在飞新建：不绑定/不带入，但已创建会话仍登记保留", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	const pendingCreate = deferred();
	deps.createDraft = () => pendingCreate.promise;

	const controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.createAndBind();
	await tick();
	harness.unmount();
	pendingCreate.resolve({ id: "sess-new", projectId: "proj-1" });
	await tick();

	assert.equal(calls.register.length, 1, "卸载也应保留已创建会话");
	assert.equal(calls.bind.length, 0, "卸载后不得绑定");
	assert.equal(calls.append.length, 0, "卸载后不得带入材料");
});

test("同步带入要求绑定属于当前书目且目标现在仍在目录里", () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, bindingState, deps } = makeDeps();
	// 绑定记录是另一本书：不得带入
	bindingState.binding = bindingRecord("sess-a", "w2", "e2");
	bindingState.sessionExists = true;
	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.append.length, 0, "绑定书目不符时不得带入");
	assert.equal(controller.errorKey, "workbenchMaterial.errorBindUnavailable");

	// 绑定记录正确，但目录里已查不到该会话：不得带入
	bindingState.binding = bindingRecord("sess-a");
	deps.readSession = () => null;
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.append.length, 0, "目标不在当前目录时不得写入");
	assert.equal(controller.errorKey, "workbenchMaterial.errorBindUnavailable");
});

test("旧章节选区不得套新章节：chapterHref/chapterNum 不符时拒绝带入", () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, bindingState, deps } = makeDeps();
	bindingState.binding = bindingRecord("sess-a");
	bindingState.sessionExists = true;
	const crossChapter = source({ chapterHref: "ch2", chapterNum: 2, selection: { snapshot: snapshot({ chapterHref: "ch1", chapterNum: 1 }), quote: quote() } });
	let controller = harness.render(() => useReadingMaterialBring(crossChapter, deps));
	controller.bringToBound();
	controller = harness.render(() => useReadingMaterialBring(crossChapter, deps));
	assert.equal(calls.append.length, 0, "旧章快照不得套新章来源");
	assert.equal(controller.errorKey, "workbenchMaterial.errorMaterial");
});

test("bind 拒绝/抛错都结化为结构化错误，不产生 unhandled rejection", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	deps.binding.bind = async () => {
		throw new Error("ipc down");
	};
	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(controller.errorKey, "workbenchMaterial.errorBind");
	assert.equal(controller.notice, null);
	assert.equal(calls.append.length, 0);
	assert.equal(controller.busy, false);

	deps.binding.bind = async () => ({ ok: false, error: { code: "unavailable", message: "no" } });
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(controller.errorKey, "workbenchMaterial.errorBind");
});

test("同一 capturedAt 但偏移/核验档位变化：在飞绑定完成按新来源作废", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	const pendingBind = deferred();
	deps.binding.bind = (input) => {
		calls.bind.push(input);
		return pendingBind.promise;
	};
	const first = source();
	const second = source({ selection: { snapshot: snapshot({ start: 10, end: 20 }), quote: quote("normalized") } });

	let controller = harness.render(() => useReadingMaterialBring(first, deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(second, deps));
	pendingBind.resolve({ ok: true, binding: bindingRecord("sess-a") });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(second, deps));
	assert.equal(calls.append.length, 0, "偏移/档位变化后旧完成不得生效");
	assert.equal(controller.notice, null);
});

test("bind 挂起期间目标从目录消失：await 后实时核对为 null → 0 append", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	let live = { "sess-a": { id: "sess-a", projectId: "proj-1" } };
	deps.readSession = (sessionId) => live[sessionId] ?? null;
	const pendingBind = deferred();
	deps.binding.bind = (input) => {
		calls.bind.push(input);
		return pendingBind.promise;
	};

	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.bindAndBring({ sessionId: "sess-a", projectId: "proj-1" });
	await tick();
	live = {}; // 绑定挂起期间会话被删
	pendingBind.resolve({ ok: true, binding: bindingRecord("sess-a") });
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.append.length, 0, "await 后目标已不在当前目录：不得 append");
	assert.equal(controller.errorKey, "workbenchMaterial.errorBindUnavailable");
});

test("新建注册后 getter 实时可见：register 同步入目录，createAndBind 照常绑定带入", async () => {
	const { harness, useReadingMaterialBring } = loadHook();
	const { calls, deps } = makeDeps();
	const live = {};
	deps.readSession = (sessionId) => live[sessionId] ?? null;
	deps.registerSession = (session) => {
		calls.register.push(session);
		live[session.id] = { id: session.id, projectId: session.projectId };
	};

	let controller = harness.render(() => useReadingMaterialBring(source(), deps));
	controller.createAndBind();
	await tick();
	controller = harness.render(() => useReadingMaterialBring(source(), deps));
	assert.equal(calls.register.length, 1);
	assert.equal(calls.append.length, 1, "注册后实时 getter 应能看到新会话并带入");
	assert.equal(calls.append[0].sessionId, "sess-new");
	assert.equal(controller.notice, "created");
});
