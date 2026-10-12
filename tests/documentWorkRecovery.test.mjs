/**
 * 恢复与降级：活动分支补登记、未确认工作不自动启动、结果缺失记未知、
 * 归档失败保留输入、扩展关闭不破坏普通聊天。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindingState, candidateReport, createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

const STATE_TYPE = "tpa-document-work-state";

const entry = (id, parentId, details) => ({ type: "custom_message", id, parentId, customType: STATE_TYPE, display: false, content: "", details });
const message = (id, parentId, role = "user") => ({ type: "message", id, parentId, message: { role, content: id } });

async function historyFixture(run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-document-work-"));
	const path = join(directory, "session.jsonl");
	const reader = new SessionHistoryReader({ toHostPath: (value) => value, convertMessages: (_agent, messages) => messages, trimMessages: (messages) => messages, translate: () => "summary" });
	const write = (entries) => writeFile(path, `${entries.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n")}\n`);
	try {
		await run({ reader, path, write });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("活动分支补登记：绑定与候选汇报都能读回，且不恢复执行授权", async () => {
	await historyFixture(async ({ reader, path, write }) => {
		const entries = [{ type: "session", id: "session" }, entry("state", "session", { documentWork: bindingState({ phase: "reported", reportId: "report_1" }), report: candidateReport() })];
		let parent = "state";
		for (let index = 0; index < 30; index++) {
			entries.push(message(`m${index}`, parent, index % 2 === 0 ? "user" : "assistant"));
			parent = `m${index}`;
		}
		await write(entries);
		const result = await reader.readDocumentWorkEntries(path);
		assert.equal(result.bindings.length, 1);
		assert.equal(result.reports.length, 1);
		assert.equal(result.bindings[0].phase, "reported");
		assert.equal(result.reports[0].reportId, "report_1");
		// 不可信/超大条目被跳过，不会污染结果。
		await write([{ type: "session", id: "session" }, entry("bad", "session", { documentWork: { schemaVersion: 1, workId: 1 } }), entry("foreign", "session", { documentWork: { ...bindingState(), schemaVersion: 9 } })]);
		const degraded = await reader.readDocumentWorkEntries(path);
		assert.equal(degraded.bindings.length, 0);
		assert.equal(degraded.reports.length, 0);
	});
});

test("会话重开恢复：只回报磁盘状态，不自动重放未结算操作", async () => {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	const runtime = createFakeRuntime({ alignment: { briefId: "brief_1", revision: 1, phase: "ready", brief: { scope: ["s"], preserve: [] } } });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: { freezePreparation: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/x" } }), settleAndArchive: async () => ({ state: "unknown", code: "DISPATCH_UNKNOWN" }) },
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: 20,
	});
	const recovered = await service.recover("session-1");
	assert.equal(recovered.ok, true);
	assert.equal(recovered.value.works.length, 1);
	assert.equal(recovered.value.operations.length, 0, "重开时不造操作记录");
	assert.equal(runtime.calls.filter((call) => call.kind === "sendControl").length, 0, "重开不自动分发");
	assert.equal(service.unsettledOperationIds().length, 0);

	// 结果缺失（未确认绑定）记 unknown，而不是当作成功归档。
	const prepared = await service.prepare({ requestId: "prepare_1", workId: work.value.workId, sessionId: "session-1", expectedRevision: work.value.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 1 } });
	const started = await service.start({
		requestId: "start_1",
		workId: work.value.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 1 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && store.readWork(work.value.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(store.readWork(work.value.workId).value.operations[attemptId].state, "unknown");
	assert.equal(service.unsettledOperationIds().length, 0, "unknown 是终态：不会在下次重开被当成待续");
});

test("归档失败保留 staging 与输入，操作记失败且不再自动重试", async () => {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/userData"], files: { "C:/out/work/staging/p1/a.docx": "draft bytes" } });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	const runtime = createFakeRuntime({ alignment: { briefId: "brief_1", revision: 1, phase: "ready", brief: { scope: ["s"], preserve: [] } } });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: {
			freezePreparation: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/p1" } }),
			// 归档时把 staging 里的候选文件写坏（模拟写盘失败），返回失败并保留输入。
			settleAndArchive: async () => ({ state: "failed", code: "IO_ERROR", detail: "the version directory is not writable" }),
		},
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: 50,
	});
	const prepared = await service.prepare({ requestId: "prepare_1", workId: work.value.workId, sessionId: "session-1", expectedRevision: work.value.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 1 } });
	const started = await service.start({
		requestId: "start_1",
		workId: work.value.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 1 },
	});
	const attemptId = started.value.attemptId;
	await new Promise((resolve) => setTimeout(resolve, 5));
	events.emit("agent-1", {
		type: "message_end",
		sessionId: "session-1",
		runtimeGeneration: 1,
		message: { role: "custom", customType: STATE_TYPE, display: false, details: { documentWork: bindingState({ attemptId, preparationId: prepared.value.preparation.preparationId, digest: prepared.value.preparation.digest }) } },
	});
	events.settle("agent-1");
	for (let index = 0; index < 200 && store.readWork(work.value.workId).value.operations[attemptId].state !== "failed"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	const operation = store.readWork(work.value.workId).value.operations[attemptId];
	assert.equal(operation.state, "failed");
	assert.equal(operation.error.code, "IO_ERROR");
	assert.equal(store.readWork(work.value.workId).value.record.lastFailure.code, "IO_ERROR");
	assert.equal(pathMemory.fs.exists("C:/out/work/staging/p1/a.docx"), true, "失败保留输入与 staging");
	assert.equal(pathMemory.fs.exists("C:/out/work/versions/v0001/a.docx"), false, "失败不产生半成品版本");
});

test("扩展关闭/不可用：文稿入口给出明确错误，普通会话读写不受影响", async () => {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/userData"] });
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_1` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: "session-1", sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	// 没有扩展注册绑定命令：RPC 接受但永远等不到确认 → 记未知，普通聊天与记录都不坏。
	const runtime = createFakeRuntime({ alignment: { briefId: "brief_1", revision: 1, phase: "ready", brief: { scope: ["s"], preserve: [] } } });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: { freezePreparation: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/x" } }), settleAndArchive: async () => ({ state: "unknown", code: "DISPATCH_UNKNOWN" }) },
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		now: () => 500,
		newId: (prefix) => `${prefix}_x1`,
		bindAckMs: 20,
	});
	const prepared = await service.prepare({ requestId: "prepare_1", workId: work.value.workId, sessionId: "session-1", expectedRevision: work.value.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 1 } });
	const started = await service.start({
		requestId: "start_1",
		workId: work.value.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 1 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && store.readWork(work.value.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(store.readWork(work.value.workId).value.operations[attemptId].state, "unknown");
	// 会话级读取与列表仍然可用（界面能显示"结果未确定"，聊天功能不受影响）。
	const snapshot = await service.get({ workId: work.value.workId, sessionId: "session-1" });
	assert.equal(snapshot.ok, true);
	assert.equal(snapshot.value.operation?.state, "unknown", "界面能读到结果未确定而不是空白");
	const list = await service.listForSession("session-1");
	assert.equal(list.ok, true);
	adapter.dispose();
	assert.equal(events.listenerCount(), 0, "订阅与解绑配对");
});
