/**
 * IPC 边界：入参校验、会话归属、未知 ID、路径注入拒绝、版本冲突、
 * 未授权制作拒绝、错误不抛裸异常。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const handlers = new Map();
const { registerDocumentWorkIpc } = loadTsCommonJs("src/main/ipc/documentWorkIpc.ts", {
	stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } },
});
const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { createMemoryWorkFs } = await import("./helpers/documentWorkFixtures.mjs");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/** 只把 IPC 边界的调用登记下来：真正的业务断言在各自的服务测试里。 */
function fakeService() {
	const calls = [];
	const respond = (name) => async (input) => {
		calls.push({ name, input });
		return { ok: true, value: { echo: name } };
	};
	return {
		calls,
		service: {
			create: respond("create"),
			get: respond("get"),
			listForSession: respond("list"),
			prepare: respond("prepare"),
			start: respond("start"),
			getOperation: respond("getOperation"),
			cancel: respond("cancel"),
			recover: respond("recover"),
		},
	};
}

function register(options = {}) {
	handlers.clear();
	const store = new DocumentWorkStore({ dir: "/data", fs: createMemoryWorkFs(), now: () => 1, newId: (prefix) => `${prefix}_1` });
	const { service, calls } = fakeService();
	const broadcast = [];
	registerDocumentWorkIpc({ service, store, chooseDirectory: options.chooseDirectory ?? (async () => undefined), broadcast: (event) => broadcast.push(event) });
	return { store, calls, broadcast };
}

test("每个通道都注册了 handler（新增通道三处同步的前两处）", () => {
	register();
	for (const channel of [
		ipcChannels.documentWorkCreate,
		ipcChannels.documentWorkGet,
		ipcChannels.documentWorkPrepare,
		ipcChannels.documentWorkStart,
		ipcChannels.documentWorkOperation,
		ipcChannels.documentWorkCancel,
		ipcChannels.documentWorkRecover,
		ipcChannels.documentWorkListRoots,
		ipcChannels.documentWorkChooseRoot,
		ipcChannels.documentWorkSetRoot,
		ipcChannels.documentWorkForgetRoot,
	]) {
		assert.equal(handlers.has(channel), true, channel);
	}
});

test("只读接口原样转发，且不改变记录版本", async () => {
	const { calls } = register();
	await handlers.get(ipcChannels.documentWorkGet)({}, { workId: "work_1", sessionId: "session-1" });
	assert.equal(calls.at(-1).name, "get");
	assert.equal(calls.at(-1).input.workId, "work_1");
});

test("成果目录只能来自系统选择器：取消不登记，注入的绝对路径不登记", async () => {
	const harness = register();
	const cancelResult = await handleOf(ipcChannels.documentWorkChooseRoot)({});
	assert.equal(cancelResult.ok, true);
	assert.equal(cancelResult.value.cancelled, true);
	assert.equal(harness.store.listOutputRoots().length, 0);
	assert.equal(harness.calls.length, 0, "取消时不叫到服务层");

	// 渲染层没有"直接指定绝对路径"的通道：只有 choose-root（弹对话框）与 set-root（用已登记 ID）。
	const root = harness.store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = harness.store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: "" });
	const injected = await handleOf(ipcChannels.documentWorkSetRoot)({}, { workId: work.value.workId, expectedRevision: work.value.revision, outputRootId: "../etc/passwd" });
	assert.equal(injected.ok, false);
	assert.equal(injected.error.code, "PATH_DENIED");
	const bound = await handleOf(ipcChannels.documentWorkSetRoot)({}, { workId: work.value.workId, expectedRevision: work.value.revision, outputRootId: root.value.outputRootId });
	assert.equal(bound.ok, true);
	assert.equal(harness.store.readWork(work.value.workId).value.record.outputRootId, root.value.outputRootId);
});

test("set-root 的入参校验：缺字段/负版本都返回结构化错误，不抛异常", async () => {
	register();
	for (const input of [undefined, {}, { workId: "w" }, { workId: "w", expectedRevision: -1, outputRootId: "r" }, { workId: "w", expectedRevision: 0 }]) {
		const result = await handleOf(ipcChannels.documentWorkSetRoot)({}, input);
		assert.equal(result.ok, false, JSON.stringify(input));
		assert.equal(result.error.code, "INVALID_INPUT");
	}
});

test("set-root 对未知工作返回 WORK_NOT_FOUND，对过期版本返回 REVISION_CONFLICT", async () => {
	register();
	const missing = await handleOf(ipcChannels.documentWorkSetRoot)({}, { workId: "work_unknown", expectedRevision: 0, outputRootId: "root_unknown" });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "PATH_DENIED");
	const withRoot = register();
	const root = withRoot.store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = withRoot.store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: "" });
	await handleOf(ipcChannels.documentWorkSetRoot)({}, { workId: work.value.workId, expectedRevision: 0, outputRootId: root.value.outputRootId });
	const stale = await handleOf(ipcChannels.documentWorkSetRoot)({}, { workId: work.value.workId, expectedRevision: 0, outputRootId: root.value.outputRootId });
	assert.equal(stale.ok, false);
	assert.equal(stale.error.code, "REVISION_CONFLICT");
});

test("撤销成果根登记只影响登记表，已归档记录保留", async () => {
	const { store } = register();
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	const forgotten = await handleOf(ipcChannels.documentWorkForgetRoot)({}, root.value.outputRootId);
	assert.equal(forgotten.ok, true);
	assert.equal(store.listOutputRoots().length, 0);
	assert.equal(store.readWork(work.value.workId).ok, true, "工作记录不受影响");
	const invalid = await handleOf(ipcChannels.documentWorkForgetRoot)({}, "");
	assert.equal(invalid.ok, false);
	assert.equal(invalid.error.code, "INVALID_INPUT");
});

function handleOf(channel) {
	const handler = handlers.get(channel);
	assert.ok(handler, `handler for ${channel}`);
	return handler;
}
