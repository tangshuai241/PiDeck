import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/** 一轮执行结束分类的生命周期接线：成功/失败/停止都从真实事件路径发出。 */
function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: { isStreaming: false } }) }, stop: () => undefined },
	};
	manager.agents.set("agent-1", runtime);
	const outcomes = [];
	manager.onAgentRunFinished((info) => outcomes.push(info.outcome));
	return { manager, runtime, outcomes };
}

test("agent_settled → succeeded；错误态 settled → failed；abort 后的 settled → aborted", () => {
	const { manager, runtime, outcomes } = createManager();
	manager.handlePiEvent("agent-1", { type: "agent_settled" });
	assert.equal(outcomes.at(-1), "succeeded");
	assert.equal(runtime.tab.status, "idle");

	runtime.tab.status = "error";
	manager.handlePiEvent("agent-1", { type: "agent_settled" });
	assert.equal(outcomes.at(-1), "failed");

	manager.recentlyAborted.add("agent-1");
	runtime.tab.status = "running";
	manager.handlePiEvent("agent-1", { type: "agent_settled" });
	assert.equal(outcomes.at(-1), "aborted");
	assert.equal(runtime.tab.status, "idle", "停止后仍收敛回空闲");
});

test("自动重试最终失败在耗尽点记失败，重试期间不提前结束", () => {
	const { manager, outcomes } = createManager();
	manager.handlePiEvent("agent-1", { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100 });
	assert.equal(outcomes.length, 0, "重试开始不是结果");
	manager.handlePiEvent("agent-1", { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100 });
	assert.equal(outcomes.length, 0, "重试期间不产生结果");
	manager.handlePiEvent("agent-1", { type: "auto_retry_end", success: false, attempt: 3, maxAttempts: 3, finalError: "quota" });
	assert.equal(outcomes.at(-1), "failed");
});

test("用户关闭运行时：进行中的一轮记为 aborted", async () => {
	const { manager, outcomes } = createManager();
	await manager.stop("agent-1");
	assert.equal(outcomes.at(-1), "aborted");
	assert.equal(manager.agents.get("agent-1"), undefined);
});
