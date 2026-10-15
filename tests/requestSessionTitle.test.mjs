import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { requestSessionTitle } = loadTsCommonJs("src/main/pi/requestSessionTitle.ts");
const { registerSessionTitleIpc } = loadTsCommonJs("src/main/ipc/sessionTitleIpc.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

function clientFixture({ present = true, fail = false } = {}) {
	const client = new EventEmitter();
	const calls = [];
	client.request = async (input) => {
		calls.push(input);
		if (input.type === "get_commands") return { success: true, data: { commands: present ? [{ name: "pideck-title", source: "extension" }] : [] } };
		const requestId = JSON.parse(input.message.slice("/pideck-title ".length)).requestId;
		client.emit("event", { type: "extension_ui_request", method: "setStatus", statusKey: "pideck:title-result:unrelated", statusText: "wrong" });
		client.emit("event", { type: "extension_ui_request", method: "setStatus", statusKey: `pideck:title-result:${requestId}`, statusText: "修复额度刷新" });
		return { success: !fail };
	};
	return { client, calls };
}
test("title request accepts only its exact result and cleans up the event listener", async () => {
	const { client, calls } = clientFixture();
	assert.equal(await requestSessionTitle(client, () => true), "修复额度刷新");
	assert.equal(calls.length, 2);
	assert.equal(client.listenerCount("event"), 0);
});

test("manual title commands carry the latest configured model without changing the running model", async () => {
	const { client, calls } = clientFixture();
	const model = { provider: "custom-go", modelId: "deepseek-v4.1-flash" };
	await requestSessionTitle(client, () => true, model);
	assert.deepEqual(JSON.parse(calls[1].message.slice("/pideck-title ".length)).model, model);
});

test("extension failure categories cross RPC without upstream response bodies", async () => {
	const { client } = clientFixture();
	client.request = async (input) => {
		if (input.type === "get_commands") return { success: true, data: { commands: [{ name: "pideck-title", source: "extension" }] } };
		const { requestId } = JSON.parse(input.message.slice("/pideck-title ".length));
		client.emit("event", { type: "extension_ui_request", method: "setStatus", statusKey: `pideck:title-error:${requestId}`, statusText: "TITLE_AUTH_UNAVAILABLE" });
		return { success: true };
	};
	await assert.rejects(
		requestSessionTitle(client, () => true),
		/TITLE_AUTH_UNAVAILABLE/,
	);
	assert.equal(client.listenerCount("event"), 0);
});
test("missing extension never falls through to a normal prompt", async () => {
	const { client, calls } = clientFixture({ present: false });
	await assert.rejects(requestSessionTitle(client, () => true));
	assert.equal(calls.length, 1);
});
test("failed command preserves the old title and removes the listener", async () => {
	const { client } = clientFixture({ fail: true });
	await assert.rejects(requestSessionTitle(client, () => true));
	assert.equal(client.listenerCount("event"), 0);
});
test("runtime replaced during generation cannot accept the old result", async () => {
	const { client } = clientFixture();
	let checks = 0;
	await assert.rejects(requestSessionTitle(client, () => ++checks < 3));
});

function ipcFixture() {
	let handler;
	let title = "Original";
	let valid = true;
	const writes = [];
	const deps = {
		sessionCatalog: {
			get: () => ({ title, backend: "pi" }),
			claimTitleOwnership: async () => {},
			update: async (_id, patch) => {
				writes.push(patch);
				return { id: "session-a", ...patch };
			},
		},
		sessionRuntimeCoordinator: {
			validateTarget: () => ({ ok: valid }),
			renameRuntime: async (_target, name) => {
				writes.push(name);
				return { ok: true };
			},
		},
		agentManager: { generateSessionTitle: async () => "New title" },
	};
	const requests = registerSessionTitleIpc(
		{
			handle: (_channel, callback) => {
				handler = callback;
			},
		},
		deps,
	);
	const target = { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1 };
	return {
		requests,
		deps,
		writes,
		target,
		invoke: (input = target) => handler({}, input),
		changeTitle: () => {
			title = "User edit";
		},
		invalidate: () => {
			valid = false;
		},
	};
}
test("explicit title persists through the owning session after target validation", async () => {
	const harness = ipcFixture();
	assert.equal((await harness.invoke()).ok, true);
	assert.deepEqual(plain(harness.writes), ["New title", { title: "New title" }]);
});

test("a provider failure returns a specific category and never changes the catalog", async () => {
	const harness = ipcFixture();
	harness.deps.agentManager.generateSessionTitle = async () => {
		throw new Error("TITLE_PROVIDER_ERROR");
	};
	assert.deepEqual(plain(await harness.invoke()), { ok: false, error: "TITLE_PROVIDER_ERROR" });
	assert.deepEqual(harness.writes, []);
});
test("a concurrent user rename wins over the generated title", async () => {
	const harness = ipcFixture();
	harness.deps.agentManager.generateSessionTitle = async () => {
		harness.changeTitle();
		return "New title";
	};
	assert.equal((await harness.invoke()).ok, false);
	assert.equal(harness.writes.length, 0);
});
test("stale runtime and malformed targets cause zero title requests", async () => {
	const harness = ipcFixture();
	let calls = 0;
	harness.deps.agentManager.generateSessionTitle = async () => {
		calls++;
		return "New";
	};
	harness.invalidate();
	assert.equal((await harness.invoke()).ok, false);
	assert.equal((await harness.invoke({})).ok, false);
	assert.equal(calls, 0);
});

test("manual rename during ownership persistence cancels the generated native rename", async () => {
	const harness = ipcFixture();
	harness.deps.sessionCatalog.claimTitleOwnership = async () => {
		harness.requests.invalidate(harness.target.sessionId);
	};
	assert.equal((await harness.invoke()).ok, false);
	assert.equal(harness.writes.length, 0);
});

test("manual rename while native RPC is in flight prevents generated catalog persistence", async () => {
	const harness = ipcFixture();
	harness.deps.sessionRuntimeCoordinator.renameRuntime = async () => {
		harness.requests.invalidate(harness.target.sessionId);
		return { ok: true };
	};
	assert.equal((await harness.invoke()).ok, false);
	assert.equal(harness.writes.length, 0);
});
