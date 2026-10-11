import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const target = { sessionId: "session", agentId: "agent", runtimeGeneration: 1 };
const prompt = (overrides = {}) => ({ sessionId: "session", requestId: "request", message: "/align approve brief 1", expectedRuntime: target, ...overrides });

/** Bind a native runtime without invoking startup or real model dispatch. */
function fixture() {
	const tab = { id: "agent", projectId: "project", cwd: "C:/project", status: "idle", createdAt: 1 };
	const record = { id: "session", projectId: "project", title: "Session", status: "active", source: "pi", environment: "native", createdAt: 1, updatedAt: 1 };
	const calls = [];
	const agents = { list: () => [tab] };
	const catalog = { get: (id) => (id === record.id ? record : undefined) };
	const coordinator = new SessionRuntimeCoordinator(catalog, agents, async (input) => {
		calls.push(input);
		return { accepted: true };
	});
	coordinator.bind("session", "agent");
	return { coordinator, tab, calls };
}

test("alignment command rejects stale generation, wrong session, and absent binding before activation", async () => {
	for (const expected of [
		{ ...target, runtimeGeneration: 0 },
		{ ...target, sessionId: "other" },
		{ ...target, agentId: "missing" },
	]) {
		const { coordinator, calls } = fixture();
		let activations = 0;
		coordinator.ensureRuntime = async () => {
			activations++;
			throw new Error("must not activate");
		};
		const result = await coordinator.send(prompt({ expectedRuntime: expected }));
		assert.equal(result.accepted, false);
		assert.equal(result.delivery, "rejected");
		assert.equal(activations, 0);
		assert.equal(calls.length, 0);
	}
});

test("alignment command refuses a stopped target without spawning its replacement", async () => {
	const { coordinator, tab, calls } = fixture();
	tab.status = "closed";
	let activations = 0;
	coordinator.ensureRuntime = async () => {
		activations++;
		return tab;
	};
	const result = await coordinator.send(prompt());
	assert.equal(result.delivery, "rejected");
	assert.equal(activations, 0);
	assert.equal(calls.length, 0);
});

test("alignment command rechecks the runtime after asynchronous activation before dispatch", async () => {
	const { coordinator, tab, calls } = fixture();
	coordinator.ensureRuntime = async () => {
		coordinator.unbindAgent("agent");
		coordinator.bind("session", "agent");
		return tab;
	};
	const result = await coordinator.send(prompt());
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "rejected");
	assert.equal(calls.length, 0);
});

test("alignment command sends once to its exact live target and ordinary sends remain compatible", async () => {
	const { coordinator, tab, calls } = fixture();
	coordinator.ensureRuntime = async () => tab;
	assert.equal((await coordinator.send(prompt())).accepted, true);
	assert.equal(calls[0].agentId, "agent");
	coordinator.unbindAgent("agent");
	coordinator.bind("session", "agent");
	assert.equal((await coordinator.send(prompt({ expectedRuntime: undefined, requestId: "ordinary", message: "hello" }))).accepted, true);
	assert.equal(calls.length, 2);
});

/** Invoke the production IPC handler; malformed targets must never reach the coordinator. */
function ipcFixture() {
	const handlers = new Map();
	const calls = [];
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } } });
	registerSessionIpc({
		sessionRuntimeCoordinator: {
			send: async (input) => {
				calls.push(input);
				return { accepted: false, delivery: "rejected" };
			},
		},
		appLogger: { info() {}, warn() {} },
		agentManager: { list: () => [] },
	});
	return { calls, send: (input) => handlers.get("sessions:send-prompt")({}, input) };
}

test("session prompt IPC rejects malformed and cross-session expected targets before the coordinator", async () => {
	const { calls, send } = ipcFixture();
	for (const expectedRuntime of [null, [], {}, { ...target, sessionId: "other" }, { ...target, agentId: "" }, { ...target, agentId: "a\n" }, { ...target, runtimeGeneration: -1 }, { ...target, runtimeGeneration: 0.5 }, { ...target, runtimeGeneration: Infinity }]) {
		const result = await send(prompt({ expectedRuntime }));
		assert.equal(result.accepted, false);
		assert.equal(result.delivery, "rejected");
	}
	assert.equal(calls.length, 0);
});

test("session prompt IPC forwards valid targets and accepts existing ordinary prompts", async () => {
	const { calls, send } = ipcFixture();
	await send(prompt());
	await send(prompt({ expectedRuntime: undefined, requestId: "ordinary", message: "hello" }));
	assert.equal(calls.length, 2);
	assert.equal(calls[0].expectedRuntime, target);
	assert.equal(calls[1].expectedRuntime, undefined);
});
