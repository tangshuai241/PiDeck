import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionTitleAction, generateTitleForSession } = loadTsCommonJs("src/renderer/src/utils/sessionTitleAction.ts");
const saved = () => ({ backend: "pi", status: "active", messageCount: 2, filePath: "C:/project/session.jsonl", noSession: false });
const target = () => ({ sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 2 });
const runtime = () => ({ ...target(), status: "idle", projectId: "project-a", cwd: "C:/project", createdAt: 1 });

test("saved Pi history can activate for naming without an existing process", () => {
	assert.equal(sessionTitleAction(saved(), undefined), "activate");
	for (const status of ["closed", "detached", "error"]) assert.equal(sessionTitleAction(saved(), { status }), "activate");
});
test("an idle live Pi process can name its own conversation", () => {
	assert.equal(sessionTitleAction(saved(), runtime()), "generate");
});
test("starting and responding sessions wait without interrupting the agent", () => {
	for (const status of ["starting", "running"]) assert.equal(sessionTitleAction(saved(), { ...runtime(), status }), "busy");
});
test("empty drafts explain that a first message is required", () => {
	const draft = { backend: "pi", status: "draft", messageCount: 0, noSession: false };
	assert.equal(sessionTitleAction(draft, undefined), "empty");
	assert.equal(sessionTitleAction(draft, runtime()), "empty");
});
test("other backends and closed anonymous sessions are not activated for Pi naming", () => {
	assert.equal(sessionTitleAction({ ...saved(), backend: "dsh" }, runtime()), "unsupported");
	assert.equal(sessionTitleAction({ ...saved(), noSession: true }, undefined), "empty");
});

function apiFixture(activation = { ok: true, value: runtime() }) {
	const calls = [];
	const api = {
		activateRuntime: async (sessionId) => {
			calls.push({ kind: "activate", sessionId });
			return activation;
		},
		generateTitle: async (input) => {
			calls.push({ kind: "generate", ...input });
			return { ok: true };
		},
	};
	return { calls, api };
}
test("a cold naming click activates exactly its session then binds to the returned generation", async () => {
	const { calls, api } = apiFixture();
	assert.equal((await generateTitleForSession("session-a", undefined, api, () => true)).ok, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].kind, "activate");
	assert.equal(calls[0].sessionId, "session-a");
	assert.equal(calls[1].kind, "generate");
	assert.equal(calls[1].agentId, "agent-a");
	assert.equal(calls[1].runtimeGeneration, 2);
});
test("an already running idle session does not start another process", async () => {
	const { calls, api } = apiFixture();
	await generateTitleForSession("session-a", target(), api, () => true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].kind, "generate");
});
test("manual edits while startup is pending prevent generation", async () => {
	const { calls, api } = apiFixture();
	await assert.rejects(generateTitleForSession("session-a", undefined, api, () => false));
	assert.equal(calls.length, 1);
});
test("failed, busy or mismatched activation never sends a title command", async () => {
	for (const result of [{ ok: false }, { ok: true, value: { ...runtime(), status: "running" } }, { ok: true, value: { ...runtime(), sessionId: "session-b" } }]) {
		const { calls, api } = apiFixture(result);
		await assert.rejects(generateTitleForSession("session-a", undefined, api, () => true));
		assert.equal(calls.length, 1);
	}
});
