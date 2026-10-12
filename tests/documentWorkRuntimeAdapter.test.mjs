/**
 * 运行时适配层：绑定确认必须匹配身份与摘要；模型汇报不构成批准；
 * 旧 attempt/会话/世代的迟到消息被隔离；解绑与订阅配对。
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as f from "./helpers/documentWorkFixtures.mjs";
import { createFakeEventSource, createFakeRuntime, documentWorkStateMessage, bindingState, candidateReport } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkRuntimeAdapter, runtimeStillMatches } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

function createAdapter(options = {}) {
	const runtime = createFakeRuntime(options);
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	return { runtime, events, adapter };
}

test("绑定确认只在 attemptId + preparationId + digest + 运行时三元组全部匹配时成立", async () => {
	const { runtime, events, adapter } = createAdapter({ target: { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 4, piSessionId: f.NATIVE_SESSION } });
	const target = { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 4, piSessionId: f.NATIVE_SESSION };
	const waiting = adapter.awaitBinding({ target, attemptId: "attempt_1", preparationId: "prep_1", digest: "digest-1", timeoutMs: 200 });
	// 身份不符的确认先到：不能认领。
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 4, message: documentWorkStateMessage(bindingState({ attemptId: "attempt_other" })) });
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 4, message: documentWorkStateMessage(bindingState({ digest: "other-digest" })) });
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 4, message: documentWorkStateMessage(bindingState()) });
	const outcome = await waiting;
	assert.equal(outcome.ok, true);
	assert.equal(outcome.state.attemptId, "attempt_1");
	void runtime;
});

test("过期世代的确认被标 stale，不满足等待条件", async () => {
	const runtime = createFakeRuntime({ target: { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 2, piSessionId: f.NATIVE_SESSION } });
	const events = createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	// 事件先于绑定世代：mock 的 readRuntimeBinding 会回报生成代 2，因此这里改绑到 3。
	runtime.target.runtimeGeneration = 3;
	const waiting = adapter.awaitBinding({ target: { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 3, piSessionId: f.NATIVE_SESSION }, attemptId: "attempt_1", preparationId: "prep_1", digest: "digest-1", timeoutMs: 50 });
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 2, message: documentWorkStateMessage(bindingState()) });
	const outcome = await waiting;
	assert.equal(outcome.ok, false, "过期消息不能顶替当前绑定");
});

test("候选汇报只发布报告事件，不产生任何批准或执行信号", async () => {
	const { events, adapter } = createAdapter();
	const seen = [];
	const unsubscribe = adapter.subscribe((event) => seen.push(event.kind));
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 1, message: documentWorkStateMessage(bindingState({ phase: "reported", reportId: "report_1" }), candidateReport()) });
	await new Promise((resolve) => setTimeout(resolve, 0));
	unsubscribe();
	assert.deepEqual([...seen].sort(), ["binding", "report"]);
	const report = adapter.findReport({ attemptId: "attempt_1", preparationId: "prep_1", digest: "digest-1" });
	assert.equal(report?.reportId, "report_1");
	assert.equal(adapter.findReport({ attemptId: "attempt_2", preparationId: "prep_1", digest: "digest-1" }), undefined, "迟到汇报不能绑定到其它 attempt");
});

test("agent_end 只是事件，settled 才是稳定点；两者都带运行时三元组", async () => {
	const { events, adapter } = createAdapter();
	const seen = [];
	adapter.subscribe((event) => seen.push(event));
	events.emit("agent-1", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
	events.settle("agent-1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		seen.map((event) => event.kind),
		["agent_end", "settled"],
	);
	assert.equal(seen[0].stopReason, "aborted");
	assert.equal(seen[0].target.sessionId, f.STABLE_SESSION);
	assert.equal(seen[0].target.agentId, "agent-1");
	assert.equal(seen[0].target.runtimeGeneration, 1);
});

test("dispose 解除所有订阅与保留事件，重复调用幂等", async () => {
	const { events, adapter } = createAdapter();
	assert.equal(events.listenerCount(), 2);
	adapter.dispose();
	adapter.dispose();
	assert.equal(events.listenerCount(), 0);
	events.emit("agent-1", { type: "message_end", sessionId: f.STABLE_SESSION, runtimeGeneration: 1, message: documentWorkStateMessage(bindingState()) });
	const seen = [];
	adapter.subscribe((event) => seen.push(event));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(seen.length, 0, "解绑后不再收事件");
});

test("补登记走只读历史端口，失败降级为空结果而不是抛错", async () => {
	const { adapter } = createAdapter({ history: { bindings: [bindingState()], reports: [candidateReport()] } });
	const backfilled = await adapter.backfill("agent-1");
	assert.equal(backfilled.bindings.length, 1);
	assert.equal(backfilled.reports.length, 1);

	const runtime = createFakeRuntime();
	runtime.port.readHistory = async () => {
		throw new Error("history unavailable");
	};
	const events = createFakeEventSource();
	const failing = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	const degraded = await failing.backfill("agent-1");
	assert.equal(degraded.bindings.length, 0);
	assert.equal(degraded.reports.length, 0);
});

test("运行时是否仍匹配：换绑后必须返回 false", async () => {
	const runtime = createFakeRuntime({ target: { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: f.NATIVE_SESSION } });
	assert.equal(await runtimeStillMatches(runtime.port, { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1 }), true);
	assert.equal(await runtimeStillMatches(runtime.port, { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 2 }), false);
	assert.equal(await runtimeStillMatches(runtime.port, { sessionId: "session-2", agentId: "agent-1", runtimeGeneration: 1 }), false);
	// 原生身份也参与判定：同一次绑定期间换会话文件即视为换绑。
	assert.equal(await runtimeStillMatches(runtime.port, { sessionId: f.STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: "other-native" }), false);
});
