import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const remoteRequire = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({ globals: { TextEncoder }, stubs: { tweetnacl: remoteRequire("tweetnacl"), "base64-js": remoteRequire("base64-js") } });
const { projectRemoteMessages } = load(resolve("src/main/remote/remoteMessageProjection.ts"));
const { readRemoteMessagePart } = load(resolve("src/main/remote/RemoteMessageGateway.ts"));
const { displayChannels } = load(resolve("packages/tpa-remote/src/displayChannels.ts"));
const { buildConversation, conversationRows } = load(resolve("apps/android/src/conversation.ts"));
const { legacyBodyPage, initialBodyPageState } = load(resolve("apps/android/src/legacyBodyPage.ts"));
const { diffSnapshots, applyPatch } = load(resolve("packages/tpa-remote/src/stream.ts"));
const row = (patch = {}) => ({ id: "a", agentId: "agent", role: "assistant", timestamp: 1, text: "<thinking>reason</thinking>answer", thinking: "reason", ...patch });

test("remote body excludes reasoning before applying the tail budget", () => {
	const source = row({ thinking: "r".repeat(15000), text: `<thinking>${"r".repeat(15000)}</thinking>answer` });
	const result = projectRemoteMessages([source])[0];
	assert.equal(result.text, "answer");
	assert.equal(result.textTruncated, undefined);
	assert.equal(result.thinkingTruncated, true);
	assert(source.text.startsWith("<thinking>"));
});

test("full-content body uses the same separation as timeline and leaves thinking available", async () => {
	const deps = { runtime: { getTarget: () => ({ agentId: "agent" }) }, agents: { getDisplayMessages: () => [row()] } };
	const request = { messageId: "a", channel: "text", offset: 0 };
	assert.equal((await readRemoteMessagePart(deps, { id: "session" }, request)).text, "answer");
	assert.equal((await readRemoteMessagePart(deps, { id: "session" }, { ...request, channel: "thinking" })).text, "reason");
});

test("literal code examples and non-assistant content are preserved", () => {
	const literal = "```xml\n<thinking>reason</thinking>\n```\n`<thinking>reason</thinking>`";
	assert.equal(displayChannels(row({ text: literal })).text, literal);
	assert.equal(displayChannels(row({ text: "<thinking>example</thinking>" })).text, "<thinking>example</thinking>");
	for (const role of ["user", "tool"]) assert.equal(displayChannels(row({ role })).text, row().text);
});

test("partial known reasoning and old tail windows do not become answers", () => {
	assert.equal(displayChannels(row({ text: "<thinking>reas" })).text, "");
	assert.equal(displayChannels(row({ text: "son</thinking>answer", textTruncated: true })).text, "answer");
	assert.equal(displayChannels(row({ text: "answer", channelsSeparated: true })).text, "answer");
	assert.equal(displayChannels(row({ thinking: "discuss </thinking> tag", text: "<thinking>discuss </thinking> tag</thinking>answer" })).text, "answer");
});

const user = (id = "u") => row({ id, role: "user", text: "question", thinking: "" });
const tool = (id, patch = {}) => row({ id, role: "tool", text: "", thinking: "", tool: { name: "shell", status: "done", detail: "output", ...patch } });

test("one turn counts reasoning, calls and interim replies while keeping final answer outside disclosure", () => {
	const turns = buildConversation([user(), row({ id: "progress" }), tool("t1"), tool("t2"), row({ id: "final", text: "done", thinking: "", stopReason: "stop" })], false, false);
	assert.equal(turns.length, 1);
	assert.equal(turns[0].tools, 2);
	assert.equal(turns[0].thoughts, 1);
	assert.equal(turns[0].replies, 1);
	const closed = conversationRows(turns, new Set());
	assert.deepEqual(
		Array.from(closed, (item) => item.kind),
		["message", "summary", "message"],
	);
	assert.equal(closed.at(-1).message.text, "done");
	assert.equal(conversationRows(turns, new Set(["u"])).filter((item) => item.kind === "step").length, 4);
});

test("updates replace the same call but equal text from separate calls still counts twice", () => {
	const turns = buildConversation([user(), tool("live", { callId: "call", status: "running" }), tool("saved", { callId: "call", status: "error" }), tool("other", { callId: "other" })], false, false);
	assert.equal(turns[0].tools, 2);
	assert.equal(turns[0].steps[0].message.tool.status, "error");
});

test("failed or tool-ended runs never promote an earlier progress report to final", () => {
	for (const tail of [tool("last"), row({ id: "error", role: "error", text: "failed", thinking: "" })]) {
		const turn = buildConversation([user(), row(), tail], false, false)[0];
		assert.equal(turn.answer, undefined);
		assert.equal(turn.replies, 1);
	}
	assert.equal(buildConversation([user(), row({ stopReason: "aborted" })], false, false)[0].answer, undefined);
});

test("thought-only rows never produce a body and incomplete history is labeled partial", () => {
	const turn = buildConversation([row({ text: "<thinking>reason</thinking>" })], false, true)[0];
	assert.equal(turn.answer, undefined);
	assert.equal(turn.thoughts, 1);
	assert.equal(turn.replies, 0);
	assert.equal(turn.partial, true);
});

test("manual turn disclosure survives growing content and completion without cross-turn expansion", () => {
	const opened = new Set(["u"]);
	for (const busy of [true, false]) {
		const turns = buildConversation([user(), row(), user("u2"), row({ id: "second" })], busy, false);
		const steps = conversationRows(turns, opened).filter((item) => item.kind === "step");
		assert.equal(steps.length, 1);
		assert.equal(steps[0].step.message.id, "a");
		assert.equal(turns[0].running, false);
	}
});

test("legacy full-body pagination handles every split of opening and closing tags", () => {
	const source = "<thinking>secret\nreason</thinking>final";
	for (let split = 1; split < source.length; split++) {
		const first = legacyBodyPage(source.slice(0, split), initialBodyPageState(), false);
		const last = legacyBodyPage(source.slice(split), first.state, true);
		assert.equal(first.text + last.text, "final", `split ${split}`);
	}
});

test("legacy full-body pagination preserves fenced and inline tag examples", () => {
	const source = "<thinking>secret</thinking>answer\n```xml\n<thinking>example</thinking>\n```\n`<thinking>example</thinking>`";
	const expected = source.replace("<thinking>secret</thinking>", "");
	for (let split = 1; split < source.length; split++) {
		const first = legacyBodyPage(source.slice(0, split), initialBodyPageState(), false);
		const last = legacyBodyPage(source.slice(split), first.state, true);
		assert.equal(first.text + last.text, expected, `split ${split}`);
	}
});

test("stream completion and truncation metadata reach the phone even without text changes", () => {
	const message = { id: "a", role: "assistant", text: "answer", timestamp: 1 };
	const before = { sessionId: "s", messages: [message], questions: [], busy: true, revision: 1, hasOlder: false, cursor: { epoch: "e", sequence: 1 } };
	const after = { ...before, busy: false, messages: [{ ...message, stopReason: "stop", channelsSeparated: true, textTruncated: true }] };
	const patch = diffSnapshots(before, after, { epoch: "e", sequence: 2 });
	const result = applyPatch(before, patch);
	assert.equal(result.messages[0].stopReason, "stop");
	assert.equal(result.messages[0].channelsSeparated, true);
	assert.equal(result.messages[0].textTruncated, true);
});
