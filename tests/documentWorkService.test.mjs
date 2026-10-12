/**
 * 工作编排：准备失效、授权绑定实际版本、异步期间运行时替换、忙碌拒绝、
 * 未确认分发记未知且不重放、并发准备被版本检查拒绝。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bindingState, candidateReport, createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs, documentWorkStateMessage } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

const ALIGNMENT = { briefId: "brief_1", revision: 3, phase: "ready", brief: { goal: "write a report", scope: ["Section one"], materials: [], deliverable: "report.docx", preserve: ["Facts stay"], acceptance: ["matches the outline"], questions: [] } };
const TURN = "turn_1";

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return predicate();
}

function setup(options = {}) {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const runtime = createFakeRuntime({ alignment: options.alignment ?? ALIGNMENT, turnTexts: { [TURN]: "please rewrite section one" }, busy: options.busy, target: options.target });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const archiveCalls = [];
	const archive = {
		async freezePreparation({ preparation }) {
			archiveCalls.push({ kind: "freeze", preparationId: preparation.preparationId });
			return { ok: true, value: { stagingAbsolutePath: `C:/out/${preparation.stagingRelativeDir}` } };
		},
		async settleAndArchive() {
			archiveCalls.push({ kind: "settle" });
			return options.archiveOutcome ?? { state: "archived", versionId: "v0001_attempt_1" };
		},
	};
	const changeEvents = [];
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive,
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: (event) => changeEvents.push(event),
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: options.bindAckMs ?? 100,
	});
	const outputRootId = root.value.outputRootId;
	const created = store.createWork({ requestId: "create_1", requestDigest: "digest_create", sessionId: "session-1", sourceTurnId: TURN, title: "report", outputRootId });
	return { store, service, runtime, events, adapter, archiveCalls, changeEvents, work: created.value, outputRootId };
}

function runtimeTriple(runtime) {
	return { sessionId: runtime.target.sessionId, agentId: runtime.target.agentId, runtimeGeneration: runtime.target.runtimeGeneration };
}

let prepareCounter = 0;

async function prepareCreate(harness, overrides = {}) {
	return harness.service.prepare({
		// requestId 必须是程序生成的 id 形态（不能带点号），否则会在边界被拒。
		requestId: `prepare_${++prepareCounter}`,
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: harness.work.revision,
		kind: "create_document",
		requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 },
		...overrides,
	});
}

test("准备阶段：确认单版本不符判失效，briefId 不符要求重新确认", async () => {
	const stale = setup();
	const staleResult = await prepareCreate(stale, { requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 2 } });
	assert.equal(staleResult.ok, false);
	assert.equal(staleResult.error.code, "PREPARATION_STALE");

	const foreign = setup({ alignment: { ...ALIGNMENT, briefId: "brief_other" } });
	const foreignResult = await prepareCreate(foreign);
	assert.equal(foreignResult.ok, false);
	assert.equal(foreignResult.error.code, "APPROVAL_REQUIRED");
});

test("准备阶段：没有活动运行时或运行中忙碌时都不生成准备记录", async () => {
	const offline = setup({ target: null });
	const offlineResult = await prepareCreate(offline);
	assert.equal(offlineResult.ok, false);
	assert.equal(offlineResult.error.code, "RUNTIME_CHANGED");

	const busy = setup({ busy: true });
	const busyResult = await prepareCreate(busy);
	assert.equal(busyResult.ok, true, "准备本身不调模型，忙碌只挡分发");
	const started = await busy.service.start({
		requestId: "start_busy",
		workId: busy.work.workId,
		sessionId: "session-1",
		expectedRevision: busyResult.value.workRevision,
		kind: "create_document",
		preparation: busyResult.value.preparation,
		expectedRuntime: runtimeTriple(busy.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, false);
	assert.equal(started.error.code, "RUNTIME_BUSY");
});

test("改稿准备：没有已确认范围时要求先澄清，不靠关键词猜", async () => {
	const harness = setup();
	const prepared = await prepareCreate(harness);
	assert.equal(prepared.ok, true);
	const revised = await harness.service.prepare({
		requestId: "prepare_revise",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "revise_document",
		requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 },
		feedbackSourceTurnId: TURN,
	});
	// 首轮还没有归档版本：基稿缺失必须报歧义，而不是挑最新文件。
	assert.equal(revised.ok, false);
	assert.equal(revised.error.code, "BASE_AMBIGUOUS");
});

test("分发前复核授权：授权与准备不一致时拒绝，且不发出任何 RPC", async () => {
	const harness = setup();
	const prepared = await prepareCreate(harness);
	assert.equal(prepared.ok, true);
	const started = await harness.service.start({
		requestId: "start_wrong_auth",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 1 },
	});
	assert.equal(started.ok, false);
	assert.equal(started.error.code, "APPROVAL_REQUIRED");
	assert.equal(harness.runtime.calls.filter((call) => call.kind === "sendControl").length, 0);
});

test("绑定命令被拒：记失败并保留输入，不重试", async () => {
	const harness = setup();
	harness.runtime.port.sendControl = async () => ({ accepted: false, error: "runtime busy" });
	const prepared = await prepareCreate(harness);
	const started = await harness.service.start({
		requestId: "start_rejected",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true, "持久化先于分发：start 本身成功");
	const attemptId = started.value.attemptId;
	await waitFor(() => harness.store.readWork(harness.work.workId).value.operations[attemptId].state !== "dispatching");
	const operation = harness.store.readWork(harness.work.workId).value.operations[attemptId];
	assert.equal(operation.state, "failed");
	assert.equal(operation.error.code, "RUNTIME_BUSY");
});

test("命令已接受但没有确认：记未知，不再重复发送", async () => {
	const harness = setup({ bindAckMs: 30 });
	const prepared = await prepareCreate(harness);
	const started = await harness.service.start({
		requestId: "start_unknown",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	const attemptId = started.value.attemptId;
	await waitFor(() => harness.store.readWork(harness.work.workId).value.operations[attemptId].state !== "dispatching");
	const operation = harness.store.readWork(harness.work.workId).value.operations[attemptId];
	assert.equal(operation.state, "unknown");
	assert.equal(harness.runtime.calls.filter((call) => call.kind === "sendControl").length, 1, "未知分发不得重放");
});

test("绑定确认到达后进入运行，并在 settled + 汇报后归档", async () => {
	const harness = setup();
	const prepared = await prepareCreate(harness);
	const started = await harness.service.start({
		requestId: "start_ok",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	await waitFor(() => harness.runtime.calls.some((call) => call.kind === "sendControl" && call.message.includes("bind")));
	harness.events.emit("agent-1", { type: "message_end", sessionId: "session-1", runtimeGeneration: 1, message: documentWorkStateMessage(bindingState({ attemptId, preparationId: prepared.value.preparation.preparationId, digest: prepared.value.preparation.digest })) });
	await waitFor(() => harness.runtime.calls.filter((call) => call.kind === "sendControl").length >= 2);
	const runCall = harness.runtime.calls.filter((call) => call.kind === "sendControl").at(-1);
	assert.match(runCall.message, /^\/align approve brief_1 3$/, "初稿仍走既有对齐批准入口");
	harness.events.emit("agent_1_unused", {});
	harness.events.emit("agent-1", {
		type: "message_end",
		sessionId: "session-1",
		runtimeGeneration: 1,
		message: documentWorkStateMessage(
			bindingState({ attemptId, preparationId: prepared.value.preparation.preparationId, digest: prepared.value.preparation.digest, phase: "reported", reportId: "report_1" }),
			candidateReport({ attemptId, preparationId: prepared.value.preparation.preparationId, digest: prepared.value.preparation.digest }),
		),
	});
	harness.events.settle("agent-1");
	await waitFor(() => harness.archiveCalls.some((call) => call.kind === "settle"));
	const read = harness.store.readWork(harness.work.workId);
	assert.equal(read.value.operations[attemptId].state, "archived");
	assert.ok(read.value.record.versions.includes("v0001_attempt_1"));
	assert.equal(read.value.record.activeOperationId, undefined, "归档后不再有活动操作");
});

test("异步期间运行时被替换：记中断，不再归档", async () => {
	const harness = setup();
	// 让替换发生在绑定命令发出之后、绑定确认之前：确定性覆盖"窗口内换绑"。
	const originalSend = harness.runtime.port.sendControl;
	harness.runtime.port.sendControl = async (input) => {
		const result = await originalSend(input);
		harness.runtime.target.agentId = "agent-2";
		harness.runtime.target.runtimeGeneration = 2;
		return result;
	};
	const prepared = await prepareCreate(harness);
	const started = await harness.service.start({
		requestId: "start_replaced",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	const attemptId = started.value.attemptId;
	await waitFor(() => harness.store.readWork(harness.work.workId).value.operations[attemptId].state !== "dispatching");
	const operation = harness.store.readWork(harness.work.workId).value.operations[attemptId];
	assert.equal(operation.state, "interrupted");
	assert.equal(operation.error.code, "RUNTIME_CHANGED");
	assert.equal(
		harness.archiveCalls.some((call) => call.kind === "settle"),
		false,
		"换绑后不得结算归档",
	);
});

test("同一工作同时只允许一个运行中的操作", async () => {
	const harness = setup({ bindAckMs: 200 });
	const prepared = await prepareCreate(harness);
	const input = {
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	};
	const first = await harness.service.start({ ...input, requestId: "start_first" });
	assert.equal(first.ok, true);
	const second = await harness.service.start({ ...input, requestId: "start_second", expectedRevision: prepared.value.workRevision + 1 });
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "RUNTIME_BUSY");
});

test("同 requestId 同载荷返回原操作，不同载荷报幂等冲突", async () => {
	const harness = setup({ bindAckMs: 200 });
	const prepared = await prepareCreate(harness);
	const input = {
		requestId: "start_idem",
		workId: harness.work.workId,
		sessionId: "session-1",
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: runtimeTriple(harness.runtime),
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	};
	const first = await harness.service.start(input);
	assert.equal(first.ok, true);
	const repeat = await harness.service.start(input);
	assert.equal(repeat.ok, true);
	assert.equal(repeat.value.attemptId, first.value.attemptId);
	assert.equal(harness.runtime.calls.filter((call) => call.kind === "sendControl").length, 1);

	// 分发已经推进了工作版本：下一轮准备必须用最新 revision。
	const currentRevision = harness.store.readWork(harness.work.workId).value.record.revision;
	const other = await prepareCreate(harness, { expectedRevision: currentRevision });
	assert.equal(other.ok, true);
	const conflicting = await harness.service.start({ ...input, expectedRevision: other.value.workRevision, preparation: other.value.preparation });
	assert.equal(conflicting.ok, false);
	assert.equal(conflicting.error.code, "IDEMPOTENCY_CONFLICT");
});

test("过期 expectedRevision 的准备被版本检查拒绝，并发准备只有一个成功", async () => {
	const harness = setup();
	const revision = harness.work.revision;
	const first = await harness.service.prepare({ requestId: "prepare_a", workId: harness.work.workId, sessionId: "session-1", expectedRevision: revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	const second = await harness.service.prepare({ requestId: "prepare_b", workId: harness.work.workId, sessionId: "session-1", expectedRevision: revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "REVISION_CONFLICT");
});

test("跨会话读取被拒，未知工作与未知操作返回结构化错误", async () => {
	const harness = setup();
	const foreign = await harness.service.get({ workId: harness.work.workId, sessionId: "session-other" });
	assert.equal(foreign.ok, false);
	assert.equal(foreign.error.code, "WORK_NOT_FOUND");
	const missing = await harness.service.getOperation({ requestId: "nope", sessionId: "session-1" });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "WORK_NOT_FOUND");
	const list = await harness.service.listForSession("session-1");
	assert.equal(list.ok, true);
	assert.equal(list.value.length, 1);
});
