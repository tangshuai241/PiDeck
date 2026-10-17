import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const remoteRequire = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({ stubs: { tweetnacl: remoteRequire("tweetnacl"), "base64-js": remoteRequire("base64-js") } });
const { createRemoteSessionGateway } = load(resolve("src/main/remote/RemoteSessionGateway.ts"));
const { parseRequest } = load(resolve("packages/tpa-remote/src/request.ts"));
const { commandIdentity } = load(resolve("packages/tpa-remote/src/commandIdentity.ts"));
const { togglePinned, parseMobilePreferences } = load(resolve("apps/android/src/mobilePreferences.ts"));
const target = { sessionId: "s", agentId: "a", runtimeGeneration: 1 };
const choice = { provider: "provider", modelId: "chosen" };
function harness(options = {}) {
	const calls = [];
	const entry = { id: "s", projectId: "p", title: "test", updatedAt: 1, model: { provider: "provider", modelId: "previous" } };
	const models = [{ provider: "provider", id: "chosen", name: "Chosen" }];
	const runtime = {
		getRuntimeMessages: () => ({ target }),
		getTarget: () => target,
		listPendingUiRequests: () => [],
		validateTarget: () => ({ ok: !options.stale }),
		listRuntimeModels: async () => {
			if (options.becomesBusy) options.busy = true;
			if (options.becomesStale) options.stale = true;
			return { ok: true, value: { target, value: models } };
		},
		setRuntimeModel: async (...args) => {
			calls.push(["model", ...args]);
			return { ok: true, value: { target, value: { provider: args[1], modelId: args[2] } } };
		},
		send: async (input) => {
			calls.push(["send", input]);
			return { accepted: true };
		},
		getRuntimeForkMessages: async () => ({ ok: true, value: { target, value: [{ entryId: "user-entry", text: "original" }] } }),
	};
	const gateway = createRemoteSessionGateway({
		catalog: { get: () => entry, listEntries: () => [entry] },
		runtime,
		agents: { list: () => [{ id: "a", status: options.busy ? "running" : "idle" }], getDisplayMessages: () => [] },
		projects: { get: () => ({ name: "p" }) },
		attention: { summaryFor: () => ({ sessionId: "s", running: false, pendingQuestionCount: 0, completionUnread: false }), subscribe: () => () => undefined },
		getDocuments: () => null,
		sessionForkCommands: {
			forkRuntimeSession: async (...args) => {
				calls.push(["fork", ...args]);
				return { ok: true, value: { targetSessionId: "child", text: "original" } };
			},
		},
	});
	return { gateway, calls };
}
test("phone model preference is applied before dispatch through the shared runtime", async () => {
	const { gateway, calls } = harness();
	const result = await gateway.execute({ id: "r", method: "session.send", sessionId: "s", target, text: "hello", model: choice });
	assert.equal(result.ok, true);
	assert.deepEqual(
		calls.map((x) => x[0]),
		["model", "send"],
	);
	assert.equal(calls[0][2], "provider");
	assert.equal(calls[0][3], "chosen");
});
test("busy, unavailable and stale model choices never dispatch an unintended prompt", async () => {
	for (const options of [{ busy: true }, { stale: true }, { becomesBusy: true }, { becomesStale: true }, {}]) {
		const { gateway, calls } = harness(options);
		await assert.rejects(gateway.execute({ id: "r", method: "session.send", sessionId: "s", target, text: "hello", model: Object.keys(options).length ? choice : { ...choice, modelId: "missing" } }));
		assert.equal(calls.length, 0);
	}
});
test("model catalog returns provider identity and names from Pi", async () => {
	const { gateway } = harness();
	const result = await gateway.execute({ id: "r", method: "models.list", sessionId: "s" });
	assert.equal(result.result[0].id, "chosen");
	assert.equal(result.result[0].provider, "provider");
});
test("branch uses the existing fork command service and never resends the source message", async () => {
	const { gateway, calls } = harness();
	const result = await gateway.execute({ id: "r", method: "session.fork", sessionId: "s", target, entryId: "user-entry" });
	assert.equal(result.result.sessionId, "child");
	assert.deepEqual(
		calls.map((x) => x[0]),
		["fork"],
	);
});
test("request validation and retry identity include the selected model and fork anchor", () => {
	const base = { kind: "request", id: "r", challenge: "c", issuedAt: 1, method: "session.send", sessionId: "s", target, text: "hello" };
	assert.equal(parseRequest({ ...base, model: choice }, "c", 1).model.modelId, "chosen");
	assert.throws(() => parseRequest({ ...base, model: { provider: "", modelId: "x" } }, "c", 1));
	assert.notEqual(commandIdentity("session.send", base), commandIdentity("session.send", { ...base, model: choice }));
	assert.notEqual(commandIdentity("session.fork", { ...base, entryId: "a" }), commandIdentity("session.fork", { ...base, entryId: "b" }));
});
test("mobile pins use stable entry identity, survive cache parsing and toggle without session writes", () => {
	const message = { id: "live", entryId: "entry", role: "user", text: "hello", timestamp: 1 };
	const first = togglePinned({ pins: {} }, "s", message);
	assert.equal(parseMobilePreferences(JSON.parse(JSON.stringify(first))).pins.s[0].text, "hello");
	assert.equal(togglePinned(first, "s", { ...message, id: "saved" }).pins.s.length, 0);
});
test("old and malformed cache preferences fall back without losing the model choice schema", () => {
	assert.equal(Object.keys(parseMobilePreferences(undefined).pins).length, 0);
	assert.equal(parseMobilePreferences({ model: { provider: "p", id: "m", name: "model" } }).model.id, "m");
	assert.equal(parseMobilePreferences({ model: { provider: "", id: "m" } }).model, undefined);
});
