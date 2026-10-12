/**
 * 会话身份：稳定 catalog 会话 id 与原生 Pi 会话 id 是两套体系。
 *
 * 覆盖审查修正项 1：
 * - 绑定载荷必须同时携带两者，扩展**只用原生 id** 校验身份；
 * - 新草稿稳定 id ≠ 原生 id 也必须能绑定成功（旧实现会拒绝所有绑定）；
 * - 恢复（分支快照）按原生 id 匹配，换会话文件的快照不得继承；
 * - restart（换代）与旧 runtime 的迟到消息必须被拒。
 *
 * 这里的"扩展"是真实文件 `resources/extensions/pi-deck-document-work.ts` 的注册 handler，
 * 不是替身：命令、隐藏状态消息、`agent_end` 都由它产生。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createFakeEventSource, createFakeRuntime, createMemoryFs, createMemoryWorkFs, NATIVE_SESSION, STABLE_SESSION, WORK_ID } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
/** 与扩展同源的模块图：extension 的 import 会被缓存到同一实例。 */
const protocolBridge = loadTsCommonJs("resources/extensions/pi-deck-document-work-binding.ts");
// 扩展与闸模块必须共用**同一个**加载器实例（下面的 stub 把扩展的 import 指向它），
// 否则扩展注册到 A 实例、测试在 B 实例上查询，永远查不到。
const extension = loadTsCommonJs("resources/extensions/pi-deck-document-work.ts", { stubs: { typebox: require("typebox"), "./pi-deck-document-work-binding": protocolBridge } }).default;
const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

const ALIGNMENT = { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief: { goal: "write a report", scope: ["Section one"], materials: [], deliverable: "report.docx", preserve: ["Facts stay"], acceptance: ["matches the outline"], questions: [] } };

/**
 * 真实扩展的 harness：注册表 + 分支快照 + 隐藏消息发件箱。
 * 与 alignment 的 harness 同思路，不引入 pi 进程。
 */
function extensionHarness(options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const messages = [];
	let branch = options.entries ? structuredClone(options.entries) : [];
	let nativeSessionId = options.nativeSessionId ?? NATIVE_SESSION;
	const notifications = [];
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => options.idle !== false,
		hasPendingMessages: () => false,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionId: () => nativeSessionId, getBranch: () => structuredClone(branch), setSessionId: (value) => (nativeSessionId = value) },
	};
	extension({
		on: (event, callback) => handlers.set(event, callback),
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: (value) => tools.set(value.name, value),
		appendEntry: (customType, data) => {
			branch.push({ type: "custom", customType, data: structuredClone(data) });
		},
		// pi 会把扩展发出的消息标成 role: "custom"；主进程侧的投影依赖这个角色标记。
		sendMessage: (message) => messages.push({ ...structuredClone(message), role: "custom" }),
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	});
	return {
		ctx,
		messages,
		notifications,
		branch,
		command: (args) => commands.get("tpa-work").handler(args, ctx),
		fire: (event, payload) => handlers.get(event)?.(payload, ctx),
		tool: (name) => tools.get(name),
		/** 最近一条隐藏状态消息（扩展发布的绑定确认）。 */
		lastState: () => [...messages].reverse().find((message) => message.customType === "tpa-document-work-state"),
		setNativeSession: (value) => (nativeSessionId = value),
	};
}

/** 主进程侧：真实 store/service/adapter + 假运行时端口；sendControl 直连真实扩展。 */
function jointHarness(options = {}) {
	const storeFs = createMemoryWorkFs();
	const pathMemory = createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const root = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const runtime = createFakeRuntime({ alignment: ALIGNMENT, target: options.target });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const harness = extensionHarness(options);
	// 主进程 → 扩展：绑定命令真的交给扩展 handler；扩展发布的隐藏消息再回流到 main 的事件订阅。
	runtime.port.sendControl = async (input) => {
		runtime.calls.push({ kind: "sendControl", message: input.message, requestId: input.requestId });
		const match = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (match) {
			await harness.command(`bind ${match[1]}`);
			const published = harness.lastState();
			if (published) events.emit(runtime.target.agentId, { type: "message_end", sessionId: input.sessionId, runtimeGeneration: input.expectedRuntime.runtimeGeneration, message: published });
		}
		return { accepted: true };
	};
	const archiveCalls = [];
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: {
			prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }),
			settleAndArchive: async () => {
				archiveCalls.push("settle");
				return { state: "archived", versionId: "v0001_attempt_1" };
			},
		},
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: options.bindAckMs ?? 50,
	});
	const work = store.createWork({ requestId: "create_1", requestDigest: "d", sessionId: STABLE_SESSION, sourceTurnId: "turn_1", title: "t", outputRootId: root.value.outputRootId });
	return { store, service, runtime, events, adapter, harness, work: work.value, archiveCalls };
}

async function prepared(harness) {
	const result = await harness.service.prepare({
		requestId: "prepare_1",
		workId: harness.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: harness.work.revision,
		kind: "create_document",
		requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 },
	});
	assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
	return result.value;
}

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return predicate();
}

test("绑定载荷同时携带稳定会话 id 与原生 Pi 会话 id，扩展只用原生 id 校验", async () => {
	const harness = jointHarness();
	const result = await prepared(harness);
	const started = await harness.service.start({
		requestId: "start_1",
		workId: harness.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: result.workRevision,
		kind: "create_document",
		preparation: result.preparation,
		expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: NATIVE_SESSION },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true);
	await waitFor(() => harness.runtime.calls.some((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind")));
	const bindCall = harness.runtime.calls.find((call) => call.kind === "sendControl" && call.message.startsWith("/tpa-work bind"));
	const payload = JSON.parse(Buffer.from(bindCall.message.split(" ")[2], "base64url").toString("utf8"));
	// 两个身份都在载荷里，且值不同——这正是真实新草稿的形态。
	assert.equal(payload.sessionId, STABLE_SESSION);
	assert.equal(payload.nativeSessionId, NATIVE_SESSION);
	assert.notEqual(payload.sessionId, payload.nativeSessionId);
	assert.equal(payload.agentId, "agent-1");
	assert.equal(payload.runtimeGeneration, 1);
	// 扩展确认后 main 认领绑定并派发（初稿仍走既有 /align approve 入口）。
	await waitFor(() => harness.runtime.calls.some((call) => call.kind === "sendControl" && call.message.startsWith("/align approve")));
	const approve = harness.runtime.calls.find((call) => call.kind === "sendControl" && call.message.startsWith("/align approve"));
	assert.equal(approve.message, "/align approve brief_1 3");
	assert.equal(harness.harness.notifications.length, 0, "合法绑定不应产生警告");
});

test("稳定 id 与原生 id 不同也能绑定；原生 id 不匹配则拒绝（旧实现会全部拒绝）", async () => {
	const matching = jointHarness();
	await matching.harness.command(`bind ${bindingPayload({ nativeSessionId: NATIVE_SESSION })}`);
	assert.equal(matching.harness.lastState().details.documentWork.nativeSessionId, NATIVE_SESSION);
	assert.equal(matching.harness.notifications.length, 0);

	const mismatched = jointHarness();
	// 扩展所在会话换了（新草稿/另一个会话），载荷还是旧原生 id。
	mismatched.harness.setNativeSession("pi-native-other");
	await mismatched.harness.command(`bind ${bindingPayload({ nativeSessionId: NATIVE_SESSION })}`);
	assert.equal(mismatched.harness.lastState(), undefined, "原生身份不符不得发布绑定确认");
	assert.match(mismatched.harness.notifications.at(-1), /invalid payload/);
});

test("分支恢复按原生会话 id 匹配：换会话文件的快照不得继承", () => {
	const state = bindingStateForExtension();
	const entries = [
		{ type: "session", id: "session" },
		{ type: "custom", customType: "tpa-document-work-snapshot", data: { schemaVersion: 1, nativeSessionId: NATIVE_SESSION, binding: state, phase: "reported" } },
	];
	const restored = extensionHarness({ entries, nativeSessionId: NATIVE_SESSION });
	restored.fire("session_start", {});
	assert.equal(restored.branch.length, entries.length, "恢复本身不写新快照");
	void restored.command("status");
	assert.match(restored.notifications.at(-1), new RegExp(WORK_ID));

	// 同一个分支快照落到另一个原生会话（fork/导入）：不得继承绑定。
	const foreign = extensionHarness({ entries, nativeSessionId: "pi-native-imported" });
	foreign.fire("session_start", {});
	void foreign.command("status");
	assert.match(foreign.notifications.at(-1), /No document work is bound/);
});

test("restart 换代后旧 runtime 的迟到确认被拒（stale），不会认领当前绑定", async () => {
	const harness = jointHarness({ bindAckMs: 60 });
	const result = await prepared(harness);
	// 记下绑定命令但**不**把确认回灌：模拟旧世代进程的确认晚到。
	let bindMessage;
	harness.runtime.port.sendControl = async (input) => {
		harness.runtime.calls.push({ kind: "sendControl", message: input.message, requestId: input.requestId });
		if (input.message.startsWith("/tpa-work bind")) bindMessage = input.message;
		return { accepted: true };
	};
	const started = await harness.service.start({
		requestId: "start_restart",
		workId: harness.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: result.workRevision,
		kind: "create_document",
		preparation: result.preparation,
		expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: NATIVE_SESSION },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, true);
	const attemptId = started.value.attemptId;
	await waitFor(() => typeof bindMessage === "string");
	// 换代：同一个 agentId 现在是第 2 代运行时。
	harness.runtime.target.runtimeGeneration = 2;
	harness.events.emit("agent-1", {
		type: "message_end",
		sessionId: STABLE_SESSION,
		runtimeGeneration: 1,
		message: {
			role: "custom",
			customType: "tpa-document-work-state",
			display: false,
			details: { documentWork: { schemaVersion: 1, sessionId: STABLE_SESSION, nativeSessionId: NATIVE_SESSION, workId: harness.work.workId, attemptId, preparationId: result.preparation.preparationId, digest: result.preparation.digest, phase: "bound" } },
		},
	});
	await waitFor(() => harness.store.readWork(harness.work.workId).value.operations[attemptId].state !== "dispatching");
	const operation = harness.store.readWork(harness.work.workId).value.operations[attemptId];
	assert.equal(operation.state, "interrupted");
	assert.equal(operation.error.code, "RUNTIME_CHANGED");
});

test("原生会话 id 缺失的运行时不允许绑定（记失败，不发出绑定命令）", async () => {
	const harness = jointHarness({ target: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, projectRoot: "C:/project" } });
	const result = await prepared(harness);
	const started = await harness.service.start({
		requestId: "start_no_native",
		workId: harness.work.workId,
		sessionId: STABLE_SESSION,
		expectedRevision: result.workRevision,
		kind: "create_document",
		preparation: result.preparation,
		expectedRuntime: { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1 },
		authorization: { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 },
	});
	assert.equal(started.ok, false);
	assert.equal(started.error.code, "EXTENSION_UNAVAILABLE");
	assert.equal(harness.runtime.calls.filter((call) => call.kind === "sendControl").length, 0, "拿不到原生身份就不该发出任何绑定命令");
});

/** 构造一个完整的绑定载荷（字段与 docs/协议一致）。 */
function bindingStateForExtension() {
	return {
		schemaVersion: 1,
		sessionId: STABLE_SESSION,
		nativeSessionId: NATIVE_SESSION,
		agentId: "agent-1",
		runtimeGeneration: 1,
		outputRootId: "root_1",
		workId: WORK_ID,
		attemptId: "attempt_1",
		preparationId: "prep_1",
		digest: "digest-1",
		kind: "create_document",
		stagingRelativeDir: `${WORK_ID}/staging/round`,
		outputRelativeDir: WORK_ID,
		outputRootPath: "C:/out",
		materials: [],
		materialRoots: [{ rootId: "root_1", path: "C:/out", kind: "output_root", label: "out" }],
		scope: { allow: [], preserve: [], wholeDocument: true },
		budgetBytes: 1024,
	};
}

/**
 * 绑定载荷必须是**规范 JSON**（键排序、无空格）：主进程与扩展两侧都按同一规范字符串
 * 判定"是不是被改过的载荷"，随便 stringify 出来的载荷会被合法拒绝。
 */
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function bindingPayload(overrides = {}) {
	return Buffer.from(canonical({ ...bindingStateForExtension(), ...overrides }), "utf8").toString("base64url");
}

test("审批闸只约束进行中的同轮次：归档后的旧 binding 不阻断后续普通 Plan 确认", async () => {
	const harnessA = extensionHarness();
	// 进行中的文稿轮次（brief_1 revision 3）：只约束它自己那一份确认单。
	await harnessA.command(`bind ${bindingPayload({ briefId: "brief_1", briefRevision: 3 })}`);
	const gate = sharedGate();
	assert.equal(gate.refuse("brief_1", 1), "Document work work_1 is bound to confirmation brief_1 revision 3; approve that exact revision or cancel this round.");
	assert.match(gate.refuse("brief_2", 1), /bound to another confirmation sheet/);
	assert.equal(gate.refuse("brief_1", 3), undefined);

	// 轮次结算（agent_end 正常结束 + 汇报）：binding 保留用于读/改稿意向，但不再约束批准。
	harnessA.fire("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] });
	assert.equal(sharedGate().refuse("brief_2", 1), undefined, "归档后不得阻断同一会话的普通 Plan 确认");
	assert.equal(sharedGate().refuse("brief_1", 1), undefined);
});

test("绑定载荷损坏不会永久阻断普通批准", async () => {
	const harnessB = extensionHarness();
	await harnessB.command("bind not-a-valid-payload");
	// 没有进行中的轮次：闸必须放行（文稿侧会在分发阶段如实失败，用户的普通任务照常执行）。
	assert.equal(sharedGate().refuse("brief_2", 1), undefined);
});

/**
 * 取出扩展当前注册的批准闸。
 *
 * 关键：扩展与闸模块必须由**同一个加载器实例**加载，否则扩展注册到 A 实例的闸，
 * 测试却在 B 实例上查询，永远查不到（这正是"不能只测 helper 返回值"的意义）。
 */
function sharedGate() {
	return { refuse: (briefId, revision) => protocolBridge.documentWorkApprovalRefusal(briefId, revision) };
}
