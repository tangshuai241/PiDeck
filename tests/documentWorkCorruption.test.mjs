/**
 * 档案损坏与幂等并发。
 *
 * 覆盖审查修正项 6：
 * - 主档损坏但 `.bak` 可解析时**不自动修复原位**、不把旧授权"恢复"回来、
 *   也不当作缺失重建；损坏文件原样保留，写入与新执行一律拒绝，只给只读展示；
 * - 重复确认（同 requestId）只发一次 approve 与实际 prompt；
 * - 并发 prepare/start 只有一个成功，串行化锁覆盖整段事务。
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
	const runtime = createFakeRuntime({ alignment: ALIGNMENT });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	// 绑定确认回灌：让"重复确认只发一次 approve"这条断言真的有 approve 可比。
	let confirmed = 0;
	const originalSend = runtime.port.sendControl.bind(runtime.port);
	runtime.port.sendControl = async (input) => {
		const result = await originalSend(input);
		const bind = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (bind && options.confirm !== false) {
			confirmed++;
			const payload = JSON.parse(Buffer.from(bind[1], "base64url").toString("utf8"));
			events.emit("agent-1", {
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
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: { prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }), settleAndArchive: async () => ({ state: "archived", versionId: "v0001_x" }) },
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: options.bindAckMs ?? 60,
	});
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: STABLE_SESSION, sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	const path = store.workPath(work.value.workId);
	return { store, storeFs, service, runtime, events, adapter, work: work.value, path, outputRootId: root.value.outputRootId, root, confirmations: () => confirmed };
}

async function prepareCreate(harness, requestId = "prepare_1") {
	return await harness.service.prepare({ requestId, workId: harness.work.workId, sessionId: STABLE_SESSION, expectedRevision: harness.work.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
}

function startInput(harness, prepared, requestId) {
	return {
		requestId,
		workId: harness.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: NATIVE_SESSION },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	};
}

test("主档损坏 + 可解析 .bak：不自动修复，只给只读展示，写入与新执行被拒", async () => {
	const h = harness();
	const prepared = await prepareCreate(h);
	assert.equal(prepared.ok, true);
	// 制造"主档被截断、.bak 里还有上一份可解析内容"的真实形态。
	const intact = h.storeFs.readFile(h.path);
	h.storeFs.writeFile(`${h.path}.bak`, intact);
	h.storeFs.writeFile(h.path, "{ truncated json");

	const read = h.store.readWork(h.work.workId);
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "IO_ERROR");
	// 只读展示：内容来自备份，但明确标成损坏；磁盘上的损坏文件**原样保留**。
	const display = h.store.readWorkForDisplay(h.work.workId);
	assert.equal(display.corrupt?.repairedFromBackup, true);
	assert.equal(display.record?.workId, h.work.workId);
	assert.equal(h.storeFs.readFile(h.path), "{ truncated json", "不得原位修复损坏文件");
	assert.equal(h.storeFs.readFile(`${h.path}.bak`), intact, "备份也必须保留");
	// 新的执行被拒：准备与分发都拿不到记录。
	const preparedAgain = await h.service.prepare({ requestId: "prepare_2", workId: h.work.workId, sessionId: STABLE_SESSION, expectedRevision: prepared.value.workRevision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	assert.equal(preparedAgain.ok, false);
	const snapshot = await h.service.get({ workId: h.work.workId, sessionId: STABLE_SESSION });
	assert.equal(snapshot.ok, true);
	assert.equal(snapshot.value.corrupt?.repairedFromBackup, true, "界面拿到的是只读 + 损坏原因");
	// 重开恢复必须把损坏工作如实报出来，不能当成不存在后重建。
	const recovered = await h.service.recover(STABLE_SESSION);
	assert.equal(recovered.ok, true);
	assert.deepEqual([...recovered.value.corruptWorkIds], [h.work.workId]);
});

test("同一 requestId 的重复确认只派发一次 approve 与实际 prompt", async () => {
	const h = harness({ bindAckMs: 20 });
	const prepared = await prepareCreate(h);
	const input = startInput(h, prepared, "start_same");
	const first = await h.service.start(input);
	assert.equal(first.ok, true);
	const second = await h.service.start(input);
	assert.equal(second.ok, true);
	assert.equal(second.value.attemptId, first.value.attemptId, "同 requestId 返回原操作");
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1);
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/align approve")).length, 1, "重复确认不得再发一次 approve");
});

test("并发确认只有一个成功：另一个 RUNTIME_BUSY，且只发一次 bind", async () => {
	const h = harness({ bindAckMs: 60 });
	const prepared = await prepareCreate(h);
	// 两个不同 requestId 的确认同时到达（双击"确认"）。
	const [first, second] = await Promise.all([h.service.start(startInput(h, prepared, "start_a")), h.service.start(startInput(h, prepared, "start_b"))]);
	const statuses = [first, second].map((result) => (result.ok ? "ok" : result.error.code));
	assert.equal(statuses.filter((status) => status === "ok").length, 1, JSON.stringify(statuses));
	assert.equal(statuses.filter((status) => status === "RUNTIME_BUSY").length, 1, JSON.stringify(statuses));
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1);
});

test("并发准备只有一个成功：另一个 REVISION_CONFLICT", async () => {
	const h = harness();
	const [first, second] = await Promise.all([prepareCreate(h, "prepare_a"), prepareCreate(h, "prepare_b")]);
	const statuses = [first, second].map((result) => (result.ok ? "ok" : result.error.code));
	assert.equal(statuses.filter((status) => status === "ok").length, 1, JSON.stringify(statuses));
	assert.equal(statuses.filter((status) => status === "REVISION_CONFLICT").length, 1, JSON.stringify(statuses));
});

test("未知分发不重放：命令被接受但没确认时最多发一次 bind", async () => {
	const h = harness({ bindAckMs: 30, confirm: false });
	const prepared = await prepareCreate(h);
	const started = await h.service.start(startInput(h, prepared, "start_unknown"));
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && h.store.readWork(h.work.workId).value.operations[attemptId].state === "dispatching"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(h.store.readWork(h.work.workId).value.operations[attemptId].state, "unknown");
	// 未知结果保守占用这个运行时：新的 requestId 也被拒，且不会出现第二次绑定。
	// （要重新开始，用户要显式取消这条未知操作，或让会话换绑到新的 pi 进程。）
	const again = await h.service.start(startInput(h, { value: { workRevision: h.store.readWork(h.work.workId).value.record.revision, preparation: prepared.value.preparation } }, "start_again"));
	assert.equal(again.ok, false);
	assert.equal(again.error.code, "DISPATCH_UNKNOWN");
	assert.equal(h.runtime.calls.filter((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")).length, 1, "未知期间不得重放，也不得开新的一轮");
	// 显式取消之后同运行时恢复可用（这是唯一不依赖换代的清理路径）。
	const cleared = await h.service.cancel({ requestId: "cancel_unknown", workId: h.work.workId, attemptId, expectedRevision: h.store.readWork(h.work.workId).value.record.revision, expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1 } });
	assert.equal(cleared.ok, true);
	assert.equal(cleared.value.state, "interrupted");
});
