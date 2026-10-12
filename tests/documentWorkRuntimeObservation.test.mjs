/**
 * 运行时开始/结算的真实观测（真机缺陷回归）。
 *
 * 证据（live-acceptance：post-context-run-record-api.json、app-2026-10-12.log）：批准已被接受、
 * 模型真的跑了 5m33s 并汇报了成果，但主进程在 3 分钟时把操作结算成
 * DISPATCH_UNKNOWN/run_not_observed，从未归档。
 *
 * 原因：AgentManager 的轻量 runtime 补丁（agent_start/agent_end 边沿、流式与工具边沿）只带
 * `{ agentId, state }`，不带 sessionId/runtimeGeneration；文稿适配器只认自带完整三元组的载荷，
 * 于是「本轮开始」「本轮结束」两个边沿全被丢掉，开始观察器只能等到超时。
 *
 * 修法（按复核意见）：不在收端用「当前绑定」补全身份——重启后同一 agentId 会换代，补全会把旧
 * 事件认成新 runtime；而是让生产 emitter 在发出时刻冻结 `streamRuntimeTriple`（AGENTS：所有
 * runtime 事件必须带 sessionId+agentId+runtimeGeneration）。
 *
 * 本测试只假 pi 传输面与扩展回报通道：runtime 输出由**真实 AgentManager** 通过真实 pi 事件入口
 * 发出，文稿域与适配器都是生产模块。超时参数刻意设得很短——修复绝不能靠放宽超时。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { AGENT_ID, SESSION_ID, createHarness, createWork, prepareCreate, startRound, waitFor } from "./helpers/documentWorkServiceHarness.mjs";

const NATIVE_SESSION = "01a12fd6-9f5a-77ad-a09e-0f0022ecc466";
const AUTHORIZATION = { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 };
const REPORT = "桥梁监测安排，长度 120 米。此为合成材料，不含真实项目数据。";
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 真实生产 emitter：真 AgentManager + 假 pi 传输面（RPC 只记录，不触发任何业务）。 */
function createEmitter() {
	const requests = [];
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 20_000 }) },
		{},
		undefined,
		undefined,
		undefined,
		(key) => key,
	);
	const process = {
		isRunning: () => true,
		getDiagnostics: () => null,
		client: {
			request: async (payload) => {
				requests.push(payload.type);
				if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: NATIVE_SESSION } };
				return { success: true, data: {} };
			},
		},
	};
	const tab = {
		id: AGENT_ID,
		projectId: "project-1",
		cwd: "C:/project",
		title: "Session",
		status: "idle",
		deckSessionId: SESSION_ID,
		sessionId: NATIVE_SESSION,
		runtimeGeneration: 1,
		sessionPath: join(mkdtempSync(join(tmpdir(), "pideck-runtime-obs-")), "session.jsonl"),
		sessionEnvironment: "native",
		sessionSource: "pi",
		createdAt: 1,
	};
	manager.agents.set(AGENT_ID, { tab, process });
	return { manager, process, tab, requests };
}

/** 准备并启动一轮（批准路径）。 */
async function startAttempt(harness, requestId) {
	const view = await createWork(harness);
	harness.alignment();
	const prepared = await prepareCreate(harness, view);
	assert.equal(prepared.ok, true, JSON.stringify(prepared));
	const started = await startRound(harness, view, prepared, requestId, AUTHORIZATION);
	assert.equal(started.ok, true, JSON.stringify(started));
	return view;
}

test("真实 emitter：agent_start/agent_end 边沿被认成开始与结算，本轮成果归档", async () => {
	const harness = createHarness({ startTimeoutMs: 150, bindTimeoutMs: 1_000, settleTimeoutMs: 8_000 });
	const emitter = createEmitter();
	try {
		harness.attachOutputs((emit) => emitter.manager.onOutput((_channel, payload) => emit(payload)));
		const view = await startAttempt(harness, "req-start");
		// 真实 pi 事件入口：agent_start → setAgentTurnActive(true) → 轻量补丁（三要素由 emitter 冻结）。
		emitter.manager.handlePiEvent(AGENT_ID, { type: "agent_start" }, emitter.process);
		// 关键判据：开始边沿必须被认到。超过开始超时（150ms）后仍不得落成 run_not_observed，
		// 且这一步刻意还不发候选汇报——「模型已汇报」不能替代「观察到本轮在跑」。
		await sleep(400);
		assert.equal(await harness.operationPhase(view.workId, "req-start"), "running", "开始边沿必须被观察到，不能等超时");
		await harness.writeStaged(REPORT);
		harness.reportCandidate(harness.bindingPayload().attemptId);
		// agent_end + 一次完整运行态刷新：本轮稳定完成。
		emitter.manager.handlePiEvent(AGENT_ID, { type: "agent_end" }, emitter.process);
		await emitter.manager.publishRuntimeState(AGENT_ID);
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "archived", JSON.stringify(operation.error ?? null));
		// 公开相位先到 archived，记录写入仍在结算协程里：必须先 drain 再读版本，避免假阴性。
		await harness.domain.service.drain();
		const record = await harness.domain.service.getView(view.workId, SESSION_ID);
		assert.equal(record.ok, true, JSON.stringify(record));
		assert.ok(record.value.versions.length >= 1, "本轮必须归档出一个版本");
	} finally {
		await harness.cleanup();
	}
});

test("换代之后：同一 agentId 的新 generation 补丁不构成本轮的「在跑」", async () => {
	const harness = createHarness({ startTimeoutMs: 150, bindTimeoutMs: 1_000, settleTimeoutMs: 5_000 });
	const emitter = createEmitter();
	try {
		harness.attachOutputs((emit) => emitter.manager.onOutput((_channel, payload) => emit(payload)));
		const view = await startAttempt(harness, "req-start");
		// 模拟「预检/启动期间 runtime 被替换」：同一 agentId，generation 已经换代。
		emitter.tab.runtimeGeneration = 2;
		emitter.manager.handlePiEvent(AGENT_ID, { type: "agent_start" }, emitter.process);
		await waitFor(async () => (await harness.operationPhase(view.workId, "req-start")) !== "running", 3_000, "换代后的忙补丁不该认到本轮");
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "unknown", "换代后的补丁不得被算作本轮开始");
		assert.equal(operation.error.code, "DISPATCH_UNKNOWN");
		assert.equal(operation.error.detail, "run_not_observed");
	} finally {
		await harness.cleanup();
	}
});

test("无标识的迟到补丁不得获得当前权威（收端不做身份补全）", async () => {
	const harness = createHarness({ startTimeoutMs: 150, bindTimeoutMs: 1_000, settleTimeoutMs: 5_000 });
	try {
		const view = await startAttempt(harness, "req-start");
		// 没有 sessionId/runtimeGeneration 的补丁（旧版本 emitter / 任意来源）：
		// 若适配器拿「当前绑定」去补全，这里就会把已过期的忙事件认成当前轮在跑。
		harness.emitRawOutput({ agentId: AGENT_ID, state: { isTurnActive: true, isStreaming: true } });
		await waitFor(async () => (await harness.operationPhase(view.workId, "req-start")) !== "running", 3_000, "无标识补丁不该认到本轮");
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "unknown");
		assert.equal(operation.error.detail, "run_not_observed");
	} finally {
		await harness.cleanup();
	}
});

test("已结算 unknown 之后迟到的候选汇报保持 fail-closed", async () => {
	const harness = createHarness({ startTimeoutMs: 150, bindTimeoutMs: 1_000, settleTimeoutMs: 5_000 });
	const emitter = createEmitter();
	try {
		harness.attachOutputs((emit) => emitter.manager.onOutput((_channel, payload) => emit(payload)));
		const view = await startAttempt(harness, "req-start");
		const attemptId = harness.bindingPayload().attemptId;
		const unknown = await harness.terminal(view.workId, "req-start");
		assert.equal(unknown.phase, "unknown");
		assert.equal(unknown.error.detail, "run_not_observed");
		// 真实候选（模型确实写完了文件）在 unknown 之后到达：不得据此采纳、归档或重放。
		emitter.manager.handlePiEvent(AGENT_ID, { type: "agent_start" }, emitter.process);
		await harness.writeStaged(REPORT);
		harness.reportCandidate(attemptId);
		emitter.manager.handlePiEvent(AGENT_ID, { type: "agent_end" }, emitter.process);
		await sleep(250);
		const operation = await harness.domain.service.getOperation(view.workId, "req-start", SESSION_ID);
		assert.equal(operation.ok, true, JSON.stringify(operation));
		assert.equal(operation.value.phase, "unknown", "迟到汇报不得把 unknown 改写成完成");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length, 0, "unknown 不得释放租约或重放");
	} finally {
		await harness.cleanup();
	}
});
