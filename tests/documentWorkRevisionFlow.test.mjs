/**
 * 普通聊天改稿：完整调用链。
 *
 * 覆盖审查修正项 3：用户不重走对齐、不需要内部命令。
 * - 扩展只报**意向候选**（真实 `pi-deck-document-work.ts` 的 handler 产生）；
 * - 主进程重新验证（最后一条真实用户消息 + 指纹 + 范围），等该回合权威稳定；
 * - 然后准备、绑定并**只派发一次** `/tpa-work revise`；
 * - 扩展用主进程冻结的指令正文触发回合；
 * - 结算后工作记录里出现新的归档版本（不只是"bind 被调用过"）。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs, NATIVE_SESSION, STABLE_SESSION } from "./helpers/documentWorkFixtures.mjs";
import { instructionDigest } from "./helpers/instructionDigest.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const extension = loadTsCommonJs("resources/extensions/pi-deck-document-work.ts", { stubs: { typebox: require("typebox") } }).default;
const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

const INSTRUCTION = "只改第二节，把结论改短一点";
const BASE_RELATIVE = "work_1/versions/v0001/deliverable.docx";

function extensionHarness(entries = []) {
	const handlers = new Map();
	const commands = new Map();
	const messages = [];
	const branch = structuredClone(entries);
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => NATIVE_SESSION, getBranch: () => structuredClone(branch) },
	};
	extension({
		on: (event, callback) => handlers.set(event, callback),
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: () => undefined,
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message) => messages.push({ ...structuredClone(message), role: "custom" }),
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	});
	return { ctx, messages, branch, command: (args) => commands.get("tpa-work").handler(args, ctx), fire: (event, payload) => handlers.get(event)?.(payload, ctx) };
}

/** 真实扩展 + 真实 store/service/adapter：命令与隐藏消息双向回流。 */
function jointHarness() {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"], files: { [`C:/out/${BASE_RELATIVE}`]: "archived draft bytes" } });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const runtime = createFakeRuntime({
		alignment: { briefId: "brief_1", revision: 3, phase: "complete", hasOpenQuestions: false, brief: { goal: "g", scope: ["第一节", "第二节"], materials: [], deliverable: "d", preserve: [], acceptance: ["a"], questions: [] } },
		turns: { turn_1: { entryId: "turn_1", role: "user", text: INSTRUCTION, textDigest: instructionDigest(INSTRUCTION), isLatestUserTurn: true } },
	});
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	// 真实形态：扩展从上一轮的分支快照里恢复"最近一件工作"，普通聊天才知道该报哪件工作的意向。
	const bindCalls = [];
	runtime.port.sendControl = async (input) => {
		runtime.calls.push({ kind: "sendControl", message: input.message, requestId: input.requestId });
		const bind = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (bind) {
			bindCalls.push(bind[1]);
			await harness.command(`bind ${bind[1]}`);
			const published = [...harness.messages].reverse().find((message) => message.customType === "tpa-document-work-state");
			if (published) events.emit(runtime.target.agentId, { type: "message_end", sessionId: input.sessionId, runtimeGeneration: input.expectedRuntime.runtimeGeneration, message: published });
		}
		if (input.message === "/tpa-work revise") await harness.command("revise");
		return { accepted: true };
	};
	const archived = [];
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: {
			// 冻结基稿的真实形态：主进程要靠这个绝对路径去读标题、把"第二节"落到真实章节。
			prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work_1/staging/round", frozenBaseAbsolutePath: "C:/out/work_1/staging/round/_tpa/base/deliverable.docx", frozenBaseRelativePath: "work_1/staging/round/_tpa/base/deliverable.docx" } }),
			settleAndArchive: async () => {
				const versionId = `v0002_attempt_${archived.length + 1}`;
				archived.push(versionId);
				return { state: "archived", versionId };
			},
		},
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => ["第一节", "第二节"],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: 50,
		settleMs: 200,
	});
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: STABLE_SESSION, sourceTurnId: "turn_0", title: "report", outputRootId: root.value.outputRootId });
	// 预置一版已归档、检查通过的成果，作为改稿基稿。
	const version = {
		schemaVersion: 1,
		workId: work.value.workId,
		versionId: "v0001_attempt_0",
		ordinal: 1,
		attemptId: "attempt_0",
		preparationId: "prep_0",
		kind: "create_document",
		relativeDir: "work_1/versions/v0001",
		artifacts: [{ relativePath: BASE_RELATIVE, sha256: "a".repeat(64), bytes: 20 }],
		editableSources: [],
		snapshots: [],
		provenance: { kind: "created", method: "word_local_edit" },
		inspection: { schemaVersion: 1, status: "passed", channels: [], inspectorVersion: "doc-inspector-v2", bytes: 20, budgetBytes: 1024, elapsedMs: 1 },
		userAcceptance: "not_collected",
		archivedAt: 1,
	};
	// 指纹必须与磁盘内容一致，否则会被判定成"手工改过"。
	version.artifacts[0].sha256 = createHashOf("archived draft bytes");
	store.withWork(work.value.workId, work.value.revision, (bucket) => ({ ok: true, value: { bucket: { ...bucket, versions: [version] }, value: version } }));
	// 与装配层一致：意向事件交给服务的入口处理。
	adapter.subscribe((event) => {
		if (event.kind !== "intent" || event.stale) return;
		void service.handleRevisionIntent({ target: { ...event.target, piSessionId: NATIVE_SESSION, projectRoot: "C:/project" }, intent: event.intent }).catch(() => undefined);
	});
	const snapshot = {
		schemaVersion: 1,
		nativeSessionId: NATIVE_SESSION,
		phase: "reported",
		binding: {
			schemaVersion: 1,
			sessionId: STABLE_SESSION,
			nativeSessionId: NATIVE_SESSION,
			agentId: "agent-1",
			runtimeGeneration: 1,
			outputRootId: root.value.outputRootId,
			workId: work.value.workId,
			attemptId: "attempt_0",
			preparationId: "prep_0",
			digest: "digest-0",
			kind: "create_document",
			stagingRelativeDir: `${work.value.workId}/staging/round`,
			outputRelativeDir: work.value.workId,
			outputRootPath: "C:/out",
			materials: [],
			materialRoots: [{ rootId: root.value.outputRootId, path: "C:/out", kind: "output_root", label: "out" }],
			scope: { allow: [], preserve: [], wholeDocument: true },
			budgetBytes: 1024,
		},
	};
	// 扩展只认分支里的真实用户消息：正文必须真的在分支上，而不是测试自报。
	const harness = extensionHarness([
		{ type: "session", id: "session" },
		{ type: "custom", customType: "tpa-document-work-snapshot", data: snapshot },
		{ type: "message", id: "turn_1", parentId: "session", message: { role: "user", content: INSTRUCTION } },
	]);
	harness.fire("session_start", {});
	return { store, service, runtime, events, adapter, harness, work: store.readWork(work.value.workId).value.record, bindCalls, archived };
}

function createHashOf(value) {
	const { createHash } = require("node:crypto");
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitFor(predicate, timeoutMs = 1500) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return predicate();
}

test("普通聊天的改稿意向：扩展只报候选，主进程验证后派发一次并归档新版本", async () => {
	const harness = jointHarness();
	// 1) 扩展在回合开始时只发意向候选（不发命令、不派发）。
	await harness.harness.fire("before_agent_start", {});
	const intent = harness.harness.messages.find((message) => message.customType === "tpa-document-work-intent");
	assert.ok(intent, "扩展必须报出意向候选");
	assert.equal(intent.details.intent.sourceTurnId, "turn_1");
	assert.equal(intent.details.intent.instructionDigest, instructionDigest(INSTRUCTION));
	assert.equal(harness.bindCalls.length, 0, "意向本身不派发任何绑定");

	// 2) 把候选交给主进程（模拟装配层的事件订阅），并把回合推到权威稳定点。
	harness.events.emit("agent-1", { type: "message_end", sessionId: STABLE_SESSION, runtimeGeneration: 1, message: intent });
	harness.events.settle("agent-1");

	await waitFor(() => harness.archived.length > 0);
	assert.equal(harness.archived.length, 1, "一轮只归档一次");
	assert.equal(harness.bindCalls.length, 1, "一轮只绑定一次");
	const payload = JSON.parse(Buffer.from(harness.bindCalls[0], "base64url").toString("utf8"));
	// 冻结的是**本轮用户指令**，不是旧确认单的全篇范围。
	assert.equal(payload.kind, "revise_document");
	assert.equal(payload.instruction.text, INSTRUCTION);
	assert.equal(payload.instruction.textDigest, instructionDigest(INSTRUCTION));
	assert.deepEqual([...payload.scope.allow], ["第二节"]);
	assert.equal(payload.scope.wholeDocument, false);
	assert.equal(payload.base.relativePath, BASE_RELATIVE);
	// 3) 扩展按主进程冻结的正文触发了回合。
	const execute = harness.harness.messages.find((message) => message.customType === "tpa-document-work-execute");
	assert.ok(execute, "扩展必须触发一个实际改稿回合");
	assert.match(execute.content, /只改第二节/);
	assert.equal(execute.details.sourceTurnId, "turn_1");
	// 4) 工作记录里出现了新版本，且活动操作已清空。
	const record = harness.store.readWork(harness.work.workId).value.record;
	assert.ok(record.versions.includes(harness.archived[0]), "归档版本必须写进工作记录");
	assert.equal(record.activeOperationId, undefined);
});

test("意向不再指向最后一条用户消息时作废：不派发、不归档", async () => {
	const harness = jointHarness();
	await harness.harness.fire("before_agent_start", {});
	const intent = harness.harness.messages.find((message) => message.customType === "tpa-document-work-intent");
	// 主进程读回的是"用户又发了新消息"的形态：旧轮不得授权。
	harness.runtime.port.readUserTurn = async () => ({ entryId: "turn_1", role: "user", text: INSTRUCTION, textDigest: instructionDigest(INSTRUCTION), isLatestUserTurn: false });
	harness.events.emit("agent-1", { type: "message_end", sessionId: STABLE_SESSION, runtimeGeneration: 1, message: intent });
	harness.events.settle("agent-1");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(harness.bindCalls.length, 0);
	assert.equal(harness.archived.length, 0);
});

test("意向在换 runtime 后作废：等稳定点时换绑就不派发", async () => {
	const harness = jointHarness();
	await harness.harness.fire("before_agent_start", {});
	const intent = harness.harness.messages.find((message) => message.customType === "tpa-document-work-intent");
	harness.events.emit("agent-1", { type: "message_end", sessionId: STABLE_SESSION, runtimeGeneration: 1, message: intent });
	// 稳定点之前换绑（agentId 变了）：意向作废。
	harness.runtime.target.agentId = "agent-2";
	harness.runtime.target.runtimeGeneration = 2;
	harness.events.settle("agent-2");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(harness.bindCalls.length, 0);
	assert.equal(harness.archived.length, 0);
});

test("同一轮重复意向只派发一次", async () => {
	const harness = jointHarness();
	await harness.harness.fire("before_agent_start", {});
	const intent = harness.harness.messages.find((message) => message.customType === "tpa-document-work-intent");
	for (let index = 0; index < 3; index++) harness.events.emit("agent-1", { type: "message_end", sessionId: STABLE_SESSION, runtimeGeneration: 1, message: intent });
	harness.events.settle("agent-1");
	await waitFor(() => harness.archived.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(harness.bindCalls.length, 1, "同一 workId + turnId 只派发一次");
	assert.equal(harness.archived.length, 1);
});
