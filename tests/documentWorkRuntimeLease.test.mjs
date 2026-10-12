/**
 * 同一运行时上的排他租约。
 *
 * 审查修正项 2：按 workId 的互斥挡不住"两件不同工作在同一个运行时上同时看到 idle"——
 * 两边都会通过 busy 检查与 activeOperationId 检查，然后各发一次绑定、互相覆盖。
 *
 * 租约以运行时身份为键，覆盖 占用 → 绑定 → 运行 → 权威结算；固定加锁顺序
 * （先 workId 互斥，再运行时租约，都是同步 Map 操作，不 await），不会死锁。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs, NATIVE_SESSION, STABLE_SESSION } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");
const { DocumentWorkRuntimeLease } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeLease.ts");

const ALIGNMENT = { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief: { goal: "写一份报告", scope: ["s"], materials: [], deliverable: "报告.docx", preserve: [], acceptance: ["a"], questions: [] } };

function harness(options = {}) {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const runtime = createFakeRuntime({ alignment: ALIGNMENT });
	// 两个会话各自的运行时（不同 runtime 用例用第二个 target）。
	const second = { sessionId: "session_second", agentId: "agent-2", runtimeGeneration: 1, piSessionId: "pi-native-2", projectRoot: "C:/project2" };
	runtime.port.resolveRuntime = async (sessionId) => {
		if (sessionId === runtime.target.sessionId) return { ...runtime.target };
		if (sessionId === second.sessionId) return { ...second };
		return undefined;
	};
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const lease = new DocumentWorkRuntimeLease({ now: () => 500 });
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: {
			prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }),
			settleAndArchive: async () => (options.settle ? options.settle() : { state: "unknown", code: "DISPATCH_UNKNOWN", detail: "test settle" }),
		},
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: options.bindAckMs ?? 80,
		lease,
	});
	const createWork = (sessionId, requestId) => store.createWork({ requestId, requestDigest: `d_${requestId}`, sessionId, sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	return { store, service, runtime, events, adapter, lease, root, second, createWork, pathMemory };
}

async function prepareAndStart(h, work, requestId, target) {
	const prepared = await h.service.prepare({ requestId: `prepare_${requestId}`, workId: work.workId, sessionId: work.sessionId, expectedRevision: work.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	if (!prepared.ok) return prepared;
	return await h.service.start({
		requestId: `start_${requestId}`,
		workId: work.workId,
		sessionId: work.sessionId,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: target,
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
}

test("同一运行时两件工作并发确认：只有一件获准，另一件在绑定之前被拒（运行时仍 idle）", async () => {
	const h = harness();
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const workB = h.createWork(STABLE_SESSION, "create_b").value;
	const [first, second] = await Promise.all([prepareAndStart(h, workA, "A", { ...h.runtime.target }), prepareAndStart(h, workB, "B", { ...h.runtime.target })]);
	const statuses = [first, second].map((result) => (result.ok ? "ok" : result.error.code));
	assert.equal(statuses.filter((status) => status === "ok").length, 1, JSON.stringify(statuses));
	assert.equal(statuses.filter((status) => status === "RUNTIME_BUSY").length, 1, JSON.stringify(statuses));
	// 关键证据：失败的那件在**绑定之前**就被拒，所以只有一个 bind。
	const binds = h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind"));
	assert.equal(binds.length, 1, `同一运行时上只允许一次绑定（实际 ${binds.length}）`);
	// 假运行时全程 idle：竞争不是靠"假装 busy"掩盖的。
	assert.equal(h.runtime.port.runtimeFlags !== undefined, true);
	const leaseHolders = Object.values(h.lease.snapshot());
	assert.equal(leaseHolders.length, 1);
	assert.equal(leaseHolders[0].workId, first.ok ? workA.workId : workB.workId);
});

test("不同运行时可以并行：两件工作各自绑定一次", async () => {
	const h = harness();
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const workB = h.createWork(h.second.sessionId, "create_b").value;
	const [first, second] = await Promise.all([prepareAndStart(h, workA, "A", { ...h.runtime.target }), prepareAndStart(h, workB, "B", { ...h.second })]);
	assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
	assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
	const binds = h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind"));
	assert.equal(binds.length, 2, "不同运行时互不阻塞");
	assert.equal(Object.keys(h.lease.snapshot()).length, 2);
});

test("取消释放租约，且只释放自己那一份", async () => {
	const h = harness();
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const started = await prepareAndStart(h, workA, "A", { ...h.runtime.target });
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	const cancelled = await h.service.cancel({ requestId: "cancel_1", workId: workA.workId, attemptId, expectedRevision: h.store.readWork(workA.workId).value.record.revision, expectedRuntime: { ...h.runtime.target } });
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.value.state, "interrupted");
	assert.equal(Object.keys(h.lease.snapshot()).length, 0, "取消必须成对释放租约");
	// 释放之后同一运行时可以被另一件工作接手。
	const workB = h.createWork(STABLE_SESSION, "create_b").value;
	const next = await prepareAndStart(h, workB, "B", { ...h.runtime.target });
	assert.equal(next.ok, true);
	assert.equal(Object.keys(h.lease.snapshot()).length, 1);
});

test("未知分发不会自动重放：同一 requestId 不再发第二次绑定", async () => {
	const h = harness({ bindAckMs: 20 });
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const started = await prepareAndStart(h, workA, "A", { ...h.runtime.target });
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && h.store.readWork(workA.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(h.store.readWork(workA.workId).value.operations[attemptId].state, "unknown");
	// 结算即释放租约，但重放保护来自 requestId 台账与终态：同一 requestId 不会再发绑定。
	const repeated = await h.service.start({
		requestId: "start_A",
		workId: workA.workId,
		sessionId: workA.sessionId,
		expectedRevision: h.store.readWork(workA.workId).value.record.revision,
		kind: "create_document",
		preparation: { preparationId: started.value.preparationId, digest: started.value.preparationDigest },
		expectedRuntime: { ...h.runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(repeated.ok, true);
	assert.equal(repeated.value.attemptId, attemptId, "同 requestId 返回原操作");
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1, "未知分发不得重放");
	assert.equal(Object.keys(h.lease.snapshot()).length, 0, "终态后租约释放，运行时不会被永久占住");
});

test("租约是同步的 Map 所有权：换绑天然换键，不会误放别人的租约", () => {
	const lease = new DocumentWorkRuntimeLease({ now: () => 1 });
	const target = { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: NATIVE_SESSION };
	assert.equal(lease.acquire({ target, workId: "work_a", attemptId: "attempt_a" }).ok, true);
	assert.equal(lease.acquire({ target, workId: "work_a", attemptId: "attempt_a" }).ok, true, "同一 attempt 重入幂等");
	assert.equal(lease.acquire({ target, workId: "work_b", attemptId: "attempt_b" }).ok, false);
	// 别人的 attempt 不能释放我的租约。
	assert.equal(lease.release({ target, attemptId: "attempt_b" }), false);
	assert.equal(lease.holder(target)?.workId, "work_a");
	// 换代后是新的键。
	assert.equal(lease.acquire({ target: { ...target, runtimeGeneration: 2 }, workId: "work_b", attemptId: "attempt_b" }).ok, true);
	assert.equal(lease.acquire({ target: { ...target, agentId: "agent-9" }, workId: "work_c", attemptId: "attempt_c" }).ok, true);
	assert.equal(lease.release({ target, attemptId: "attempt_a" }), true);
	assert.equal(lease.holder(target), undefined);
	lease.releaseAll();
	assert.deepEqual({ ...lease.snapshot() }, {});
});

test("未知分发保守占用同运行时：新 request 被拒且没有第二次 bind，换代后恢复", async () => {
	const h = harness({ bindAckMs: 20 });
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const started = await prepareAndStart(h, workA, "A", { ...h.runtime.target });
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	// 绑定命令被接受但没等到确认：结果未知。
	for (let index = 0; index < 200 && h.store.readWork(workA.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(h.store.readWork(workA.workId).value.operations[attemptId].state, "unknown");
	const bindsAfterUnknown = h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length;
	assert.equal(bindsAfterUnknown, 1);

	// 另一件工作在同一运行时用**新的** requestId：必须被拒，且不得发出第二次绑定。
	const workB = h.createWork(STABLE_SESSION, "create_b").value;
	const blocked = await prepareAndStart(h, workB, "B", { ...h.runtime.target });
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error.code, "DISPATCH_UNKNOWN");
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1, "未知占用期间不得再绑定");
	// 同一件工作的旧 requestId 走幂等路径，也不重放。
	const repeat = await h.service.start({
		requestId: "start_A",
		workId: workA.workId,
		sessionId: workA.sessionId,
		expectedRevision: h.store.readWork(workA.workId).value.record.revision,
		kind: "create_document",
		preparation: { preparationId: started.value.preparationId, digest: started.value.preparationDigest },
		expectedRuntime: { ...h.runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(repeat.ok, true);
	assert.equal(repeat.value.attemptId, attemptId);
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1);

	// 换到新运行时（新 pi 进程）：未知占用不再约束，新工作可以正常开始。
	h.runtime.target.agentId = "agent-2";
	h.runtime.target.runtimeGeneration = 2;
	h.runtime.target.piSessionId = "pi-native-2";
	const prepared = await h.service.prepare({ requestId: "prepare_B2", workId: workB.workId, sessionId: workB.sessionId, expectedRevision: h.store.readWork(workB.workId).value.record.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	assert.equal(prepared.ok, true);
	const afterReplace = await h.service.start({
		requestId: "start_B2",
		workId: workB.workId,
		sessionId: workB.sessionId,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { ...h.runtime.target, agentId: "agent-2", runtimeGeneration: 2, piSessionId: "pi-native-2" },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(afterReplace.ok, true, afterReplace.ok ? "" : JSON.stringify(afterReplace.error));
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 2, "新运行时上可以正常绑定");
});

test("未知占用可以被用户显式取消清理，之后同运行时恢复可用", async () => {
	const h = harness({ bindAckMs: 20 });
	const workA = h.createWork(STABLE_SESSION, "create_a").value;
	const started = await prepareAndStart(h, workA, "A", { ...h.runtime.target });
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && h.store.readWork(workA.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(h.store.readWork(workA.workId).value.operations[attemptId].state, "unknown");
	// 用户显式清理：unknown → interrupted（这就是那条权威证据）。
	const cleared = await h.service.cancel({ requestId: "cancel_unknown", workId: workA.workId, attemptId, expectedRevision: h.store.readWork(workA.workId).value.record.revision, expectedRuntime: { ...h.runtime.target } });
	assert.equal(cleared.ok, true);
	assert.equal(cleared.value.state, "interrupted");
	assert.equal(h.store.blockingUnknownOperation({ sessionId: STABLE_SESSION, target: { agentId: "agent-1", runtimeGeneration: 1 } }), undefined);
	const workB = h.createWork(STABLE_SESSION, "create_b").value;
	const next = await prepareAndStart(h, workB, "B", { ...h.runtime.target });
	assert.equal(next.ok, true, next.ok ? "" : JSON.stringify(next.error));
});
