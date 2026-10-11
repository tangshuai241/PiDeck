import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", { stubs: { electron: {} } });
const state = { schemaVersion: 1, briefId: "brief", revision: 1, phase: "clarifying" };
const message = (alignment = state) => ({ type: "message_end", message: { role: "custom", customType: "pi-deck-alignment-state", display: false, content: "", details: { alignment } } });

/** Wire ordinary process events through AgentManager with mocked RPC dependencies. */
function fixture({ alignmentEnabled = true } = {}) {
	const manager = new AgentManager(
		() => ({ id: "project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const outputs = [];
	manager.onOutput((channel, payload) => outputs.push({ channel, payload }));
	const process = new EventEmitter();
	process.client = { request: async (input) => ({ success: true, data: input.type === "get_commands" ? { commands: alignmentEnabled ? [{ name: "align", source: "extension" }] : [] } : {} }) };
	process.stop = () => undefined;
	process.isRunning = () => true;
	const runtime = { tab: { id: "a", projectId: "project", cwd: "C:/project", title: "Session", deckSessionId: "session", runtimeGeneration: 1, status: "idle", createdAt: 1 }, process };
	manager.agents.set("a", runtime);
	manager.attachPiProcessLifecycle("a", process, { onExit: () => undefined });
	const patches = () => outputs.filter((item) => item.channel === "agents:runtime-state");
	return { manager, process, runtime, outputs, patches };
}

test("registered extension commands and user bash cannot bypass alignment confirmation", async () => {
	for (const command of ["/unsafe-write", "  /commit all", "!echo changed > report.md"]) {
		const { manager, process } = fixture();
		const requests = [];
		process.client.request = async (input) => {
			requests.push(input);
			return {
				success: true,
				data: {
					commands: [
						{ name: "unsafe-write", source: "extension" },
						{ name: "align", source: "extension" },
					],
				},
			};
		};
		process.emit("event", message());
		const result = await manager.sendPrompt({ agentId: "a", message: command });
		assert.equal(result.accepted, false, command);
		assert.equal(requests.length, 0, "Must reject before command handlers or bash RPC");
	}
});

test("first alignment submission blocks commands before an active snapshot exists", async () => {
	const { manager, process } = fixture();
	const requests = [];
	process.client.request = async (input) => {
		requests.push(input);
		return { success: true, data: {} };
	};
	const result = await manager.sendPrompt({ agentId: "a", message: "/unsafe-write", agentMessage: "__PI_DECK_ALIGNMENT_MODE__\n/unsafe-write" });
	assert.equal(result.accepted, false);
	assert.equal(requests.length, 0);
});

test("disabled alignment extension never revives a historical ready card", async () => {
	const { manager, runtime } = fixture({ alignmentEnabled: false });
	runtime.tab.sessionPath = "session.jsonl";
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	manager.sessionHistoryReader.readAlignmentState = async () => ({ ...state, phase: "ready", brief: { goal: "goal", scope: [], materials: [], deliverable: "report", preserve: [], acceptance: ["verified"], questions: [] } });
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
});

test("unloaded controls and first alignment input never fall through to a model prompt", async () => {
	for (const input of [{ message: "/align off" }, { message: "requirements", agentMessage: "__PI_DECK_ALIGNMENT_MODE__\nrequirements" }]) {
		const { manager, process } = fixture({ alignmentEnabled: false });
		const requests = [];
		process.client.request = async (payload) => {
			requests.push(payload.type);
			return { success: true, data: { commands: [{ name: "align", source: "prompt" }] } };
		};
		assert.equal((await manager.sendPrompt({ agentId: "a", ...input })).accepted, false);
		assert.deepEqual(requests, ["get_commands"]);
	}
});

test("capability discovery cannot dispatch to a replaced or rebound runtime", async () => {
	for (const rebind of [
		(runtime) => {
			runtime.tab.runtimeGeneration = 2;
		},
		(runtime) => {
			runtime.tab.deckSessionId = "other-session";
		},
		(runtime) => {
			runtime.tab.sessionPath = "other-session.jsonl";
		},
		(runtime) => {
			runtime.process = new EventEmitter();
		},
	]) {
		const { manager, process, runtime } = fixture();
		const requests = [];
		let resolve;
		process.client.request = (payload) => {
			requests.push(payload.type);
			if (requests.length > 1) return Promise.resolve({ success: false, error: "Unexpected dispatch after rebind", data: {} });
			return new Promise((done) => {
				resolve = done;
			});
		};
		const pending = manager.sendPrompt({ agentId: "a", message: "/align on" });
		assert.deepEqual(requests, ["get_commands"]);
		rebind(runtime);
		resolve({ success: true, data: { commands: [{ name: "align", source: "extension" }] } });
		assert.equal((await pending).accepted, false);
		assert.deepEqual(requests, ["get_commands"]);
	}
});

test("empty historical alignment does not emit an unsolicited partial patch in normal conversations", async () => {
	const { manager, runtime, patches } = fixture();
	runtime.tab.sessionPath = "session.jsonl";
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	manager.sessionHistoryReader.readAlignmentState = async () => null;
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
	assert.equal(patches().length, 0);
});

test("invalid history still explicitly clears a previously projected live alignment", async () => {
	const dir = await mkdtemp(join(tmpdir(), "alignment-clear-"));
	try {
		const file = join(dir, "session.jsonl");
		await writeFile(file, JSON.stringify({ type: "message", id: "bad", parentId: null, message: { ...message().message, details: { alignment: { ...state, schemaVersion: 2 } } } }) + "\n");
		const { manager, process, runtime, patches } = fixture();
		runtime.tab.sessionPath = file;
		process.emit("event", message());
		await manager.loadMessages("a", true);
		assert.equal((await manager.getRuntimeState("a")).alignment, null);
		const explicitClears = patches().filter((item) => item.payload.state.alignment === null && Object.keys(item.payload.state).length === 1);
		assert.equal(explicitClears.length, 1);
		assert.equal(explicitClears[0].payload.sessionId, "session");
		assert.equal(explicitClears[0].payload.runtimeGeneration, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ordinary hidden custom message_end immediately updates runtime state and emits identity-bound patch", async () => {
	const { manager, process, patches } = fixture();
	process.emit("event", message());
	assert.equal((await manager.getRuntimeState("a")).alignment.briefId, "brief");
	assert.equal(patches()[0].payload.sessionId, "session");
	assert.equal(patches()[0].payload.runtimeGeneration, 1);
	assert.equal(patches()[0].payload.agentId, "a");
	assert.equal(manager.getMessages("a").length, 0);
});

test("live clear and invalid state explicitly publish null while generic custom messages are ignored", async () => {
	const { manager, process, patches } = fixture();
	process.emit("event", message());
	process.emit("event", message(null));
	assert.equal(patches().at(-1).payload.state.alignment, null);
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
	process.emit("event", message({ ...state, schemaVersion: 2 }));
	assert.equal(patches().at(-1).payload.state.alignment, null);
	const count = patches().length;
	process.emit("event", { ...message(), message: { ...message().message, customType: "other" } });
	assert.equal(patches().length, count);
});

test("stop cleanup cannot leak alignment into another agent or resurrect it from late transport events", async () => {
	const { manager, process, runtime, patches } = fixture();
	process.emit("event", message());
	manager.agents.set("b", { tab: { ...runtime.tab, id: "b", deckSessionId: "other" }, process: runtime.process });
	assert.equal((await manager.getRuntimeState("b")).alignment, null);
	await manager.stop("a");
	const count = patches().length;
	process.emit("event", message());
	assert.equal(patches().length, count);
	manager.agents.set("a", runtime);
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
});

test("async history hydration cannot overwrite a newer live clear", async () => {
	const { manager, process, runtime } = fixture();
	runtime.tab.sessionPath = "session.jsonl";
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	let resolve;
	manager.sessionHistoryReader.readAlignmentState = () =>
		new Promise((done) => {
			resolve = done;
		});
	const pending = manager.getRuntimeState("a");
	await Promise.resolve();
	process.emit("event", message(null));
	resolve(state);
	assert.equal((await pending).alignment, null);
});

test("replaced processes and generation/session changes reject stale alignment events and hydration", async () => {
	const { manager, process, runtime, patches } = fixture();
	runtime.process = { client: { request: async () => ({ data: {} }) } };
	process.emit("event", message());
	assert.equal(patches().length, 0);
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
	runtime.process = process;
	process.emit("event", message());
	runtime.tab.runtimeGeneration = 2;
	runtime.tab.deckSessionId = "new-session";
	assert.equal((await manager.getRuntimeState("a")).alignment, null);
});

test("bridge unregister, runtime retirement and quit all explicitly clear projected state", async () => {
	for (const cleanup of [(manager) => manager.unregisterBridgeSession("a"), (manager) => manager.clearAgentState("a"), (manager) => manager.stopAll()]) {
		const { manager, process, runtime, patches } = fixture();
		process.emit("event", message());
		cleanup(manager);
		assert.equal(patches().at(-1).payload.state.alignment, null);
		assert.equal(patches().at(-1).payload.sessionId, "session");
		assert.equal(patches().at(-1).payload.runtimeGeneration, 1);
		manager.agents.set("a", runtime);
		assert.equal((await manager.getRuntimeState("a")).alignment, null);
	}
});

test("approved history is projected for display without sending an execution command", async () => {
	const { manager, process, runtime } = fixture();
	runtime.tab.sessionPath = "session.jsonl";
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	const calls = [];
	process.client.request = async (payload) => {
		calls.push(payload.type);
		return { data: payload.type === "get_commands" ? { commands: [{ name: "align", source: "extension" }] } : {} };
	};
	manager.sessionHistoryReader.readAlignmentState = async () => ({ ...state, phase: "approved", brief: { goal: "goal", scope: [], materials: [], deliverable: "report", preserve: [], acceptance: ["verified"], questions: [] } });
	assert.equal((await manager.getRuntimeState("a")).alignment.phase, "approved");
	assert.deepEqual(calls, ["get_state", "get_session_stats", "get_commands"]);
});

test("async history hydration cannot overwrite a newer live snapshot or survive stop", async () => {
	for (const stop of [false, true]) {
		const { manager, process, runtime, patches } = fixture();
		runtime.tab.sessionPath = "session.jsonl";
		manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
		let resolve;
		manager.sessionHistoryReader.readAlignmentState = () =>
			new Promise((done) => {
				resolve = done;
			});
		const pending = manager.getRuntimeState("a");
		await Promise.resolve();
		if (stop) await manager.stop("a");
		else process.emit("event", message({ ...state, revision: 2 }));
		const count = patches().length;
		resolve(state);
		if (stop) await assert.rejects(pending, /runtime changed/);
		else assert.equal((await pending).alignment.revision, 2);
		assert.equal(patches().length, count);
	}
});

test("async hydration rejects a changed Session generation and transport triple mismatch", async () => {
	const { manager, process, runtime, patches } = fixture();
	process.emit("event", { ...message(), sessionId: "other", runtimeGeneration: 1 });
	process.emit("event", { ...message(), sessionId: "session", runtimeGeneration: 0 });
	assert.equal(patches().length, 0);
	runtime.tab.sessionPath = "session.jsonl";
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	let resolve;
	manager.sessionHistoryReader.readAlignmentState = () =>
		new Promise((done) => {
			resolve = done;
		});
	const pending = manager.getRuntimeState("a");
	await Promise.resolve();
	runtime.tab.runtimeGeneration = 2;
	resolve(state);
	await assert.rejects(pending, /runtime changed/);
	assert.equal(patches().length, 0);
});

test("loadMessages restores hidden alignment outside its window and preserves a newer live clear during reload", async () => {
	const { manager, process, runtime } = fixture();
	const directory = await mkdtemp(join(tmpdir(), "pideck-alignment-load-"));
	const path = join(directory, "session.jsonl");
	try {
		const records = [
			{ type: "session", id: "root" },
			{ type: "custom_message", id: "alignment", parentId: "root", ...message().message },
		];
		let parentId = "alignment";
		for (let index = 0; index < 100; index++) {
			const id = `m${index}`;
			records.push({ type: "message", id, parentId, message: { role: index % 2 === 0 ? "user" : "assistant", content: id } });
			parentId = id;
		}
		await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		runtime.tab.sessionPath = path;
		await manager.loadMessages("a");
		assert.equal((await manager.getRuntimeState("a")).alignment.briefId, "brief");
		assert.ok(manager.getMessages("a").length < 100);
		assert.ok(manager.getMessages("a").every((item) => item.meta?.customType !== "pi-deck-alignment-state"));
		let resolve;
		manager.sessionHistoryReader.readAlignmentState = () =>
			new Promise((done) => {
				resolve = done;
			});
		const reload = manager.loadMessages("a");
		await Promise.resolve();
		process.emit("event", message(null));
		resolve(state);
		await reload;
		assert.equal((await manager.getRuntimeState("a")).alignment, null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
