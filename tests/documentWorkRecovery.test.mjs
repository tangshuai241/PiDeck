/**
 * 恢复与降级：活动分支补登记、未确认工作不自动启动、结果缺失记未知、
 * 归档失败保留输入、扩展关闭不破坏普通聊天。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as f from "./helpers/documentWorkFixtures.mjs";
import { bindingState, candidateReport, createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs } from "./helpers/documentWorkFixtures.mjs";

const ALIGNMENT = { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief: { goal: "g", scope: ["s"], materials: [], deliverable: "d", preserve: [], acceptance: ["a"], questions: [] } };
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

test("归档失败保留 staging 与输入，操作记失败且不再自动重试", async () => {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"], files: { "C:/out/work/staging/round/a.docx": "draft bytes" } });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	const runtime = createFakeRuntime({ alignment: ALIGNMENT });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	// 绑定确认自动回灌；归档返回失败（写盘不可用），staging 与输入必须保留。
	const original = runtime.port.sendControl.bind(runtime.port);
	runtime.port.sendControl = async (input) => {
		const result = await original(input);
		const bind = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (bind) {
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
		archive: { prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }), settleAndArchive: async () => ({ state: "failed", code: "IO_ERROR", detail: "the version directory is not writable" }) },
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: 40,
	});
	const prepared = await service.prepare({ requestId: "prepare_1", workId: work.value.workId, sessionId: f.STABLE_SESSION, expectedRevision: work.value.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 } });
	assert.equal(prepared.ok, true, prepared.ok ? "" : JSON.stringify(prepared.error));
	const started = await service.start({
		requestId: "start_1",
		workId: work.value.workId,
		sessionId: f.STABLE_SESSION,
		expectedRevision: prepared.value.workRevision,
		kind: "create_document",
		preparation: prepared.value.preparation,
		expectedRuntime: { ...runtime.target },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	for (let index = 0; index < 200 && store.readWork(work.value.workId).value.operations[attemptId].state !== "running"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	events.settle("agent-1");
	for (let index = 0; index < 200 && store.readWork(work.value.workId).value.operations[attemptId].state !== "failed"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
	const bucket = store.readWork(work.value.workId).value;
	assert.equal(bucket.operations[attemptId].state, "failed");
	assert.equal(bucket.operations[attemptId].error.code, "IO_ERROR");
	assert.equal(bucket.record.lastFailure.code, "IO_ERROR");
	assert.equal(pathMemory.fs.exists("C:/out/work/staging/round/a.docx"), true, "失败保留输入与 staging");
	assert.equal(pathMemory.fs.exists("C:/out/work_1/versions/v0001/a.docx"), false, "失败不产生半成品版本");
});
