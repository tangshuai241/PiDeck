import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const stubs = { tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js") };
const { SessionRuntimeCoordinator } = loadTsCommonJs(resolve("src/main/sessions/SessionRuntimeCoordinator.ts"));
const { remoteUiResponseError } = loadTsCommonJs(resolve("src/main/remote/remoteUiResponseError.ts"), { stubs });
const { parseRequest } = loadTsCommonJs(resolve("packages/tpa-remote/src/request.ts"), { stubs });

function setup() {
	const catalog = { get: (sessionId) => (sessionId === "s1" ? { id: "s1" } : undefined), getRecord: (sessionId) => (sessionId === "s1" ? { id: "s1", title: "会话" } : undefined) };
	const sent = [];
	const agents = {
		list: () => [],
		sendUIResponse: async (agentId, requestId, response) => {
			sent.push({ agentId, requestId, response });
		},
		notifyAskPending: () => undefined,
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("s1", "a1");
	const generation = coordinator.getRuntimeBinding("a1").runtimeGeneration;
	coordinator.observeRuntimeEvent({ sessionId: "s1", agentId: "a1", runtimeGeneration: generation, sourceChannel: "agents:ui-request", payload: { requestId: "q1", method: "input", title: "名字？" } });
	return { coordinator, generation, sent };
}

test("桌面先回答后手机提交同一问题：确定拒绝为 QUESTION_CLOSED，不落到送达未知", async () => {
	const { coordinator, generation, sent } = setup();
	await coordinator.respondToUi({ sessionId: "s1", agentId: "a1", runtimeGeneration: generation, requestId: "q1", response: { value: "桌面答案" } });
	const error = await coordinator.respondToUi({ sessionId: "s1", agentId: "a1", runtimeGeneration: generation, requestId: "q1", response: { value: "手机旧答案" } }).then(
		() => assert.fail("过期回答必须被拒绝"),
		(reason) => reason,
	);
	assert.equal(remoteUiResponseError(error), "QUESTION_CLOSED");
	assert.equal(error.code, "SESSION_COMMAND_FAILED");
	assert.equal(sent.length, 1, "拒绝的回答不再发送给 pi");
});

test("运行时已更换的回答按 RUNTIME_CHANGED 确定拒绝", async () => {
	const { coordinator, generation } = setup();
	coordinator.bindExistingAgent("s1", "a2");
	const error = await coordinator.respondToUi({ sessionId: "s1", agentId: "a1", runtimeGeneration: generation, requestId: "q1", response: { value: "旧进程的答案" } }).then(
		() => assert.fail("旧运行时回答必须被拒绝"),
		(reason) => reason,
	);
	assert.equal(remoteUiResponseError(error), "RUNTIME_CHANGED");
});

test("真正无法确定的异常保持未映射（沿用送达未知机制）", () => {
	assert.equal(remoteUiResponseError(new Error("socket reset")), undefined);
	assert.equal(remoteUiResponseError(undefined), undefined);
});

test("协议：显式发送允许无运行时目标；回答支持批量信封；已读确认绑定结果身份", () => {
	const base = { kind: "request", id: "r1", challenge: "fresh", issuedAt: Date.now() };
	assert.equal(parseRequest({ ...base, method: "session.send", sessionId: "s1", text: "继续" }, "fresh").target, undefined);
	assert.equal(parseRequest({ ...base, method: "ui.respond", sessionId: "s1", target: { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 }, questionId: "q1", answer: JSON.stringify({ answers: [{ id: "a", type: "multi_select", value: ["x"] }] }) }, "fresh").answer.length > 0, true);
	assert.equal(parseRequest({ ...base, method: "attention.ack", sessionId: "s1", completionId: "run-1" }, "fresh").completionId, "run-1");
	assert.throws(() => parseRequest({ ...base, method: "attention.ack", sessionId: "s1" }, "fresh"));
});
