/**
 * 工作编排：异步期间的运行时复查、版本检查、忙碌拒绝、跨会话隔离。
 *
 * 身份/授权矩阵见 `documentWorkAuthorization.test.mjs` 与 `documentWorkIdentity.test.mjs`；
 * 幂等与并发见 `documentWorkCorruption.test.mjs`；这里只留编排本身的独有行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs, NATIVE_SESSION, STABLE_SESSION } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

const ALIGNMENT = { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief: { goal: "写一份季度复盘报告", scope: ["s"], materials: [], deliverable: "报告.docx", preserve: [], acceptance: ["a"], questions: [] } };

function harness(options = {}) {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const runtime = createFakeRuntime({ alignment: ALIGNMENT, busy: options.busy, queued: options.queued });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const archiveCalls = [];
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: {
			prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }),
			settleAndArchive: async () => {
				archiveCalls.push("settle");
				return { state: "archived", versionId: "v0001_x" };
			},
		},
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: options.bindAckMs ?? 40,
	});
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: STABLE_SESSION, sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	return { store, service, runtime, events, adapter, archiveCalls, work: work.value };
}

const prepareInput = (h, requestId = "prepare_1", expectedRevision = h.work.revision) => ({ requestId, workId: h.work.workId, sessionId: STABLE_SESSION, expectedRevision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });

test("忙碌或有排队输入时拒绝分发，准备本身不受影响", async () => {
	const harness1 = harness({ busy: true });
	const prepared = await harness1.service.prepare(prepareInput(harness1));
	assert.equal(prepared.ok, true);
	const blocked = await harness1.service.start({
		requestId: "start_busy",
		workId: harness1.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { ...harness1.runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error.code, "RUNTIME_BUSY");

	const queued = harness({ queued: true });
	const preparedQueued = await queued.service.prepare(prepareInput(queued));
	const blockedQueued = await queued.service.start({
		requestId: "start_queued",
		workId: queued.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: preparedQueued.value.workRevision,
		kind: "create_document",
		preparation: preparedQueued.value.preparation,
		expectedRuntime: { ...queued.runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(blockedQueued.error.code, "RUNTIME_BUSY");
	assert.equal(queued.archiveCalls.length, 0);
});

test("过期 expectedRevision 的准备被版本检查拒绝", async () => {
	const h = harness();
	const first = await h.service.prepare(prepareInput(h, "prepare_a", h.work.revision));
	assert.equal(first.ok, true);
	const second = await h.service.prepare(prepareInput(h, "prepare_b", h.work.revision));
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "REVISION_CONFLICT");
	assert.equal(second.error.currentRevision, first.value.workRevision);
});

test("跨会话读取与查询被拒，未知工作/未知请求返回结构化错误", async () => {
	const h = harness();
	const foreign = await h.service.get({ workId: h.work.workId, sessionId: "session-other" });
	assert.equal(foreign.ok, false);
	assert.equal(foreign.error.code, "WORK_NOT_FOUND");
	const missing = await h.service.getOperation({ requestId: "nope", sessionId: STABLE_SESSION });
	assert.equal(missing.ok, false);
	const list = await h.service.listForSession(STABLE_SESSION);
	assert.equal(list.ok, true);
	assert.equal(list.value.length, 1);
	const runs = await h.service.listForSession("");
	assert.equal(runs.ok, false);
});

test("异步期间正常完成：绑定确认 → 运行 → 归档，活动操作被清空", async () => {
	const h = harness();
	// 绑定确认自动回灌（真实形态：扩展发布隐藏状态）。
	const original = h.runtime.port.sendControl.bind(h.runtime.port);
	h.runtime.port.sendControl = async (input) => {
		const result = await original(input);
		const bind = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (bind) {
			const payload = JSON.parse(Buffer.from(bind[1], "base64url").toString("utf8"));
			h.events.emit("agent-1", {
				type: "message_end",
				sessionId: input.sessionId,
				runtimeGeneration: input.expectedRuntime.runtimeGeneration,
				message: {
					role: "custom",
					customType: "tpa-document-work-state",
					display: false,
					details: { documentWork: { schemaVersion: 1, sessionId: payload.sessionId, nativeSessionId: payload.nativeSessionId, workId: payload.workId, attemptId: payload.attemptId, preparationId: payload.preparationId, digest: payload.digest, phase: "bound" } },
				},
			});
		}
		return result;
	};
	const prepared = await h.service.prepare(prepareInput(h));
	const started = await h.service.start({
		requestId: "start_ok",
		workId: h.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { ...h.runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && h.store.readWork(h.work.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	// 假归档器立即返回成功：中间态可能在同一 tick 内走完，只断言"离开 dispatching"。
	assert.ok(["running", "archived"].includes(h.store.readWork(h.work.workId).value.operations[attemptId].state), "绑定确认后必须离开 dispatching");
	h.events.settle("agent-1");
	for (let index = 0; index < 200 && h.store.readWork(h.work.workId).value.operations[attemptId].state !== "archived"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	const bucket = h.store.readWork(h.work.workId).value;
	assert.equal(bucket.operations[attemptId].state, "archived");
	assert.ok(bucket.record.versions.includes("v0001_x"));
	assert.equal(bucket.record.activeOperationId, undefined);
});

test("运行时三元组里的原生身份必须存在，否则拒绝分发", async () => {
	const h = harness();
	const prepared = await h.service.prepare(prepareInput(h));
	const blocked = await h.service.start({
		requestId: "start_no_native",
		workId: h.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: "another-native" },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error.code, "RUNTIME_CHANGED");
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl").length, 0);
	assert.equal(NATIVE_SESSION.length > 0, true);
});
