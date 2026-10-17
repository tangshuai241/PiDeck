import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({ globals: { TextEncoder, TextDecoder, Uint8Array, URL }, stubs: { tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js") } });
const { createRemoteCatalogGateway } = load(resolve("src/main/remote/RemoteCatalogGateway.ts"));
const { createRemoteSessionGateway } = load(resolve("src/main/remote/RemoteSessionGateway.ts"));
const { readRemoteHistory } = load(resolve("src/main/remote/RemoteHistoryGateway.ts"));
const { parseHistory, prependHistory } = load(resolve("packages/tpa-remote/src/history.ts"));
const { parseTaskTime } = load(resolve("apps/android/src/taskForm.ts"));
const { parseRemoteHostSettings } = load(resolve("src/main/config/remoteHostSettings.ts"));
const { keyPair, encode } = load(resolve("packages/tpa-remote/src/crypto.ts"));
const message = (id) => ({ id: `entry-assistant-${id}`, role: "assistant", text: id, timestamp: 1, entryId: id });

test("remote session creation uses a registered project and its existing model preference", async () => {
	const calls = [];
	const project = { id: "p", name: "TPA", path: "E:\\TPA", environment: "wsl" };
	const gateway = createRemoteCatalogGateway({
		projects: { list: () => [project], get: (id) => (id === "p" ? project : undefined) },
		catalog: {
			listEntries: () => [
				{ projectId: "p", backend: "pi", model: "existing", thinkingLevel: "high", updatedAt: 2 },
				{ projectId: "other", model: "foreign", updatedAt: 99 },
			],
			createDraft: async (input) => {
				calls.push(input);
				return { id: "created" };
			},
		},
	});
	assert.equal(await gateway.createSession({ projectId: "p" }), "created");
	assert.equal(calls[0].model, "existing");
	assert.equal(calls[0].environment, "wsl");
	await assert.rejects(gateway.createSession({ projectId: "unknown" }), /PROJECT_UNAVAILABLE/);
	assert.equal(calls.length, 1);
});
test("remote task creation delegates to the desktop scheduler without a second store", async () => {
	const calls = [];
	const store = {
		getSnapshot: () => ({ tasks: [] }),
		createTask: async (input) => {
			calls.push(input);
			return { id: "task" };
		},
	};
	const gateway = createRemoteCatalogGateway({ catalog: {}, projects: { get: (id) => (id === "p" ? { id } : undefined) }, getAutomations: () => store });
	const receipt = await gateway.createTask({ task: { name: "Review", projectId: "p", prompt: "Read", trigger: "daily", hour: 9, minute: 30 } });
	assert.equal(receipt.id, "task");
	assert.equal(Object.keys(receipt).length, 1);
	assert.equal(calls[0].schedule.expression, "30 9 * * *");
	assert.equal(calls[0].backend, "pi");
	await assert.rejects(gateway.createTask({ task: { projectId: "unknown" } }), /AUTOMATION_UNAVAILABLE/);
	assert.equal(calls.length, 1);
});
test("oversized historical turns continue from the first delivered stable entry", async () => {
	const messages = Array.from({ length: 90 }, (_, index) => ({ id: String(index), role: "assistant", text: "row", timestamp: 1, meta: { entryId: String(index) } }));
	let args;
	const page = await readRemoteHistory(
		{
			readSessionDisplayTurnPage: async (...input) => {
				args = input;
				return { messages, total: 100, nextBefore: 5 };
			},
		},
		{ id: "s", filePath: "catalog-owned", projectId: "p" },
		{ before: 10 },
	);
	assert.equal(args[0], "catalog-owned");
	assert.equal(page.messages.length, 80);
	assert.equal(page.nextBeforeEntryId, "10");
	assert.equal(page.nextBefore, 10);
	const decoded = parseHistory(page, "s");
	assert.equal(decoded.messages[0].entryId, "10");
	assert.equal(decoded.messages[0].id, "entry-assistant-10");
});
test("historical windows de-duplicate overlap and slide without joining a live gap", () => {
	const rows = prependHistory([message("a"), message("b")], [message("b"), message("c"), message("d")], 3);
	assert.equal(rows.map((row) => row.entryId).join(","), "a,b,c");
	assert.throws(() => parseHistory({ messages: [], nextBefore: -1 }, "s"));
});
test("task time rejects invalid input rather than silently changing the schedule", () => {
	assert.equal(JSON.stringify(parseTaskTime("9:30")), '{"hour":9,"minute":30}');
	for (const input of ["24:00", "09:60", "9:3", "tomorrow"]) assert.equal(parseTaskTime(input), undefined);
});
test("host settings reject invalid keys and insecure relay URLs", () => {
	const pair = keyPair(() => new Uint8Array(32).fill(7));
	const value = { version: 1, enabled: false, relay: "wss://example.test/tpa-relay/v1", room: "c".repeat(32), hostToken: "a".repeat(64), phoneToken: "b".repeat(64), hostPublicKey: encode(pair.publicKey), hostSecretKey: encode(pair.secretKey) };
	assert.equal(parseRemoteHostSettings(value).enabled, false);
	assert.throws(() => parseRemoteHostSettings({ ...value, relay: "ws://example.test" }));
	assert.throws(() => parseRemoteHostSettings({ ...value, hostPublicKey: encode(new Uint8Array(32)) }));
});
test("passive synchronization cannot restart a stopped desktop runtime", async () => {
	let activations = 0;
	let sent;
	const entry = { id: "s", projectId: "p", title: "Existing", updatedAt: 1 };
	const target = { sessionId: "s", agentId: "a", runtimeGeneration: 3 };
	const attention = { summaryFor: () => ({ sessionId: "s", running: false, pendingQuestionCount: 0, completionUnread: false }), subscribe: () => () => undefined };
	const gateway = createRemoteSessionGateway({
		catalog: { get: () => entry },
		projects: {},
		agents: {},
		attention,
		getDocuments: () => null,
		runtime: {
			getRuntimeMessages: () => undefined,
			getTarget: () => (activations > 0 ? target : undefined),
			listPendingUiRequests: () => [],
			activateRuntime: async () => {
				activations++;
				return { ok: true };
			},
			send: async (input) => {
				sent = input;
				return { accepted: true, delivery: "accepted" };
			},
		},
	});
	await gateway.snapshot("s");
	assert.equal(activations, 0, "查看历史不启动进程");
	await gateway.execute({ id: "read", method: "session.read", sessionId: "s" });
	assert.equal(activations, 0, "被动读取不启动进程");
	await gateway.snapshot("s");
	assert.equal(activations, 0);

	// 显式发送才激活，并在同一目标上派发。
	const response = await gateway.execute({ id: "send", method: "session.send", sessionId: "s", text: "继续" });
	assert.equal(response.ok, true);
	assert.equal(activations, 1);
	assert.equal(sent.expectedRuntime.agentId, "a");
	assert.equal(response.result.target.runtimeGeneration, 3);
});
