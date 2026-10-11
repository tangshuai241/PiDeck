import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const extension = loadTsCommonJs("resources/extensions/pi-deck-alignment-mode.ts", { stubs: { typebox: require("typebox") } }).default;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ORIGINAL = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp_delete", "custom_tool", "alignment_brief"];

function brief(overrides = {}) {
	return { goal: "Revise the supplied report", scope: ["Chapter one"], materials: ["report.md"], deliverable: "A revised copy", preserve: ["Preserve original facts"], acceptance: ["The copy satisfies the supplied outline"], questions: [], ...overrides };
}

/** Exercise registered pi boundaries with branch-specific history and no UI/bridge/model process. */
function harness({ entries = [], allEntries = [], tools = ORIGINAL, session = "session-a" } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const registeredTools = new Map();
	const messages = [];
	const snapshots = [];
	const notifications = [];
	let active = [...tools];
	let branch = clone(entries);
	let currentSession = session;
	let idle = true;
	let pending = false;
	let failPersistence = false;
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionId: () => currentSession, getBranch: () => clone(branch), getEntries: () => clone(allEntries) },
	};
	extension({
		on: (event, callback) => handlers.set(event, callback),
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: (value) => registeredTools.set(value.name, value),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		appendEntry: (customType, data) => {
			if (failPersistence) throw new Error("persistence unavailable");
			const entry = clone({ type: "custom", customType, data });
			branch.push(entry);
			snapshots.push(entry);
		},
		sendMessage: (message, options) => {
			messages.push(clone({ message, options }));
			branch.push(clone({ type: "custom_message", ...message }));
		},
	});
	const fire = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const command = (args) => commands.get("align").handler(args, ctx);
	const publishBrief = (value = brief()) => registeredTools.get("alignment_brief").execute("call-1", value, undefined, undefined, ctx);
	const state = () => messages.filter((item) => item.message.customType === "pi-deck-alignment-state").at(-1)?.message.details.alignment;
	return {
		ctx,
		fire,
		command,
		publishBrief,
		state,
		messages,
		snapshots,
		notifications,
		active: () => [...active],
		history: () => clone(branch),
		input: (text, source = "rpc", images) => fire("input", { text, source, images }),
		gate: (toolName) => fire("tool_call", { toolName, input: {} }),
		approve: () => command(`approve ${state().briefId} ${state().revision}`),
		setIdle: (value) => {
			idle = value;
		},
		setPending: (value) => {
			pending = value;
		},
		setActive: (value) => {
			active = [...value];
		},
		failPersistence: () => {
			failPersistence = true;
		},
		switch: async (id, entries = []) => {
			currentSession = id;
			branch = clone(entries);
			await fire("session_start");
		},
		branch: async (entries) => {
			branch = clone(entries);
			await fire("session_tree");
		},
	};
}

test("hidden marker enables read-only alignment and preserves visible text and images", async () => {
	const h = harness();
	const visible = "  请分析材料\n保留我的格式  ";
	const images = [{ type: "image", data: "test", mimeType: "image/png" }];
	const result = await h.input(`__PI_DECK_ALIGNMENT_MODE__\n${visible}`, "rpc", images);
	assert.equal(result.text, visible);
	assert.deepEqual(result.images, images);
	assert.equal(h.state().phase, "clarifying");
	assert.equal(await h.input(visible), undefined);
	assert.equal(h.state().revision, 0);
	assert.deepEqual(h.active(), ["read", "grep", "find", "ls", "alignment_brief"]);
});

test("on captures original tools, gate rejects execution/unknown MCP despite external tool reactivation", async () => {
	const h = harness();
	await h.command("on");
	h.setActive(ORIGINAL);
	for (const name of ["bash", "write", "edit", "mcp_delete", "mcp_read", "custom_tool", "codemode", "todo", "ask_question"]) assert.equal((await h.gate(name)).block, true, name);
	for (const name of ["read", "grep", "find", "ls", "alignment_brief"]) assert.equal(await h.gate(name), undefined, name);
	assert.equal((await h.fire("user_bash", { command: "echo x" })).result.exitCode, 1);
	await h.fire("before_agent_start");
	assert.equal(h.active().includes("bash"), false);
	await h.command("off");
	assert.deepEqual(h.active(), ORIGINAL);
	assert.equal(await h.gate("write"), undefined);
});

test("brief tool publishes full standard custom state snapshots and revisions", async () => {
	const h = harness();
	await h.command("on");
	const initial = h.state();
	await h.publishBrief();
	assert.equal(h.state().phase, "ready");
	assert.equal(h.state().revision, initial.revision + 1);
	assert.deepEqual(h.state().brief, brief());
	await h.publishBrief(brief({ deliverable: "A PDF copy" }));
	assert.equal(h.state().revision, initial.revision + 2);
	assert.equal(h.state().brief.deliverable, "A PDF copy");
	for (const { message, options } of h.messages) {
		assert.equal(message.customType, "pi-deck-alignment-state");
		assert.equal(message.display, false);
		assert.deepEqual(Object.keys(message.details), ["alignment"]);
		assert.equal(message.details.alignment.schemaVersion, 1);
		assert.match(message.details.alignment.briefId, /^[a-zA-Z0-9_-]{1,80}$/);
		assert.equal(options.triggerTurn, false);
	}
});

test("unanswered questions and placeholder requirements remain clarifying", async () => {
	for (const overrides of [{ questions: ["Which outline?"] }, { goal: "TBD" }, { deliverable: "待定" }, { acceptance: [] }, { acceptance: ["?"] }]) {
		const h = harness();
		await h.command("on");
		await h.publishBrief(brief(overrides));
		assert.equal(h.state().phase, "clarifying");
		await h.approve();
		assert.equal(
			h.messages.some((item) => item.options.triggerTurn),
			false,
		);
	}
});

test("complete bounded fields required and model tool cannot approve", async () => {
	const h = harness();
	await assert.rejects(h.publishBrief(), /not clarifying/);
	await h.command("on");
	for (const invalid of [brief({ materials: undefined }), brief({ phase: "approved" }), brief({ goal: "x".repeat(4001) }), brief({ scope: Array(41).fill("x") }), brief({ scope: Array(32).fill("x".repeat(2000)) })]) await assert.rejects(h.publishBrief(invalid), /bounded/);
	assert.equal(h.state().revision, 0);
});

test("stale identities/revisions, busy and queued runtimes reject approval without execution", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	const ready = h.state();
	for (const args of [`approve wrong ${ready.revision}`, `approve ${ready.briefId} 0`, `approve ${ready.briefId} 01`, `approve ${ready.briefId} ${ready.revision} extra`]) await h.command(args);
	h.setIdle(false);
	await h.approve();
	h.setIdle(true);
	h.setPending(true);
	await h.approve();
	h.setPending(false);
	await h.fire("agent_start");
	await h.approve();
	assert.equal(h.state().phase, "ready");
	assert.equal(
		h.messages.some((item) => item.options.triggerTurn),
		false,
	);
	assert.equal(h.active().includes("write"), false);
});

test("new user input or exact revise invalidates readiness while keeping original constraints", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	const ready = h.state();
	assert.equal(await h.input("新增约束：保留原文"), undefined);
	assert.equal(h.state().phase, "clarifying");
	assert.equal(h.state().revision, ready.revision + 1);
	assert.deepEqual(h.state().brief.preserve, brief().preserve);
	await h.command(`approve ${ready.briefId} ${ready.revision}`);
	assert.equal(
		h.messages.some((item) => item.options.triggerTurn),
		false,
	);
	await h.publishBrief();
	const updated = h.state();
	await h.command(`revise ${updated.briefId} ${updated.revision}`);
	assert.equal(h.state().phase, "clarifying");
	assert.equal(h.state().revision, updated.revision + 1);
	const clarifying = h.state();
	await h.command(`revise ${clarifying.briefId} ${clarifying.revision}`);
	assert.equal(h.state().revision, clarifying.revision + 1);
});

test("only explicit exact idle approval dispatches same-conversation execution under existing tools", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "APPROVED" }] }] });
	assert.equal(h.state().phase, "ready");
	await h.approve();
	assert.equal(h.state().phase, "approved");
	assert.deepEqual(h.active(), ORIGINAL);
	const execution = h.messages.filter((item) => item.options.triggerTurn);
	assert.equal(execution.length, 1);
	assert.equal(execution[0].message.customType, "pi-deck-alignment-execute");
	assert.ok(execution[0].message.content.includes(JSON.stringify(brief())));
	assert.ok(execution[0].message.content.includes("EXISTING permissions"));
	await h.approve();
	assert.equal(h.messages.filter((item) => item.options.triggerTurn).length, 1);
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(h.state().phase, "complete");
	assert.deepEqual(h.active(), ORIGINAL);
});

test("cancel and clear publish durable tombstones and restore a deliberately empty loadout", async () => {
	const h = harness({ tools: [] });
	await h.command("on");
	await h.publishBrief();
	await h.command("off");
	assert.equal(h.state().phase, "cancelled");
	assert.deepEqual(h.active(), []);
	const restored = harness({ entries: h.history(), tools: [] });
	await restored.fire("session_start");
	assert.equal(restored.state().phase, "cancelled");
	assert.deepEqual(restored.active(), []);
	await h.command("on");
	await h.publishBrief();
	await h.command("clear");
	assert.equal(h.state().brief, undefined);
});

test("restore selected branch only, restore tools on session switch and never inherit foreign session", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	const history = h.history();
	const reopened = harness({ entries: history, allEntries: [{ type: "custom", customType: "pi-deck-alignment-snapshot", data: { alignment: { ...h.state(), phase: "cancelled" } } }] });
	await reopened.fire("session_start");
	assert.equal(reopened.state().phase, "ready");
	assert.equal(reopened.active().includes("write"), false);
	await reopened.switch("session-b", history);
	assert.deepEqual(reopened.active(), ORIGINAL);
	assert.equal(await reopened.gate("write"), undefined);
	await reopened.switch("session-a", history);
	assert.equal(reopened.state().phase, "ready");
	await reopened.branch([]);
	assert.deepEqual(reopened.active(), ORIGINAL);
	assert.equal(await reopened.gate("write"), undefined);
});

test("approved reopened or interrupted session requires fresh confirmation and cannot auto-run", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	await h.approve();
	const history = h.history();
	const reopened = harness({ entries: history });
	await reopened.fire("session_start");
	assert.equal(reopened.state().phase, "clarifying");
	assert.equal(reopened.state().revision, h.state().revision + 1);
	assert.equal(
		reopened.messages.some((item) => item.options.triggerTurn),
		false,
	);
	assert.equal((await reopened.gate("write")).block, true);
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	assert.equal(h.state().phase, "clarifying");
	assert.equal((await h.gate("bash")).block, true);
});

test("private authoritative snapshot outranks delayed public messages and bad snapshot fails closed", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	const ready = h.messages.at(-1).message;
	await h.input("change it");
	const history = [...h.history(), { type: "custom_message", ...ready }];
	const restored = harness({ entries: history });
	await restored.fire("session_start");
	assert.equal(restored.state().phase, "clarifying");
	const malformed = { type: "custom", customType: "pi-deck-alignment-snapshot", data: { sessionId: "session-a", alignment: { ...h.state(), revision: -1 }, toolsBeforeAlignment: ["write"] } };
	const corrupt = harness({ entries: [...history, malformed] });
	await corrupt.fire("session_start");
	assert.equal(corrupt.state().phase, "clarifying");
	assert.equal((await corrupt.gate("write")).block, true);
	await corrupt.command("off");
	assert.deepEqual(corrupt.active(), []);
});

test("standard public history alone restores alignment without private snapshot or GUI bridge", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	const restored = harness({ entries: h.history().filter((entry) => entry.type === "custom_message") });
	await restored.fire("session_start");
	assert.equal(restored.state().phase, "ready");
	assert.equal((await restored.gate("write")).block, true);
	assert.equal(
		restored.messages.some((item) => item.options.triggerTurn),
		false,
	);
});

test("malformed latest public/private snapshots fail closed instead of falling back to prior approval", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	for (const latest of [
		{ type: "custom_message", customType: "pi-deck-alignment-state", details: null },
		{ type: "custom_message", customType: "pi-deck-alignment-state", details: { alignment: { ...h.state(), revision: -1 } } },
		{ type: "custom", customType: "pi-deck-alignment-snapshot", data: null },
	]) {
		const entries = [...h.history().filter((entry) => entry.type === "custom_message"), latest];
		const restored = harness({ entries });
		await restored.fire("session_start");
		assert.equal(restored.state().phase, "clarifying");
		assert.equal((await restored.gate("write")).block, true);
		assert.equal(
			restored.messages.some((item) => item.options.triggerTurn),
			false,
		);
	}
});

test("persistence failure keeps read-only gate; shutdown restores exact original loadout", async () => {
	const h = harness();
	await h.command("on");
	h.failPersistence();
	await assert.rejects(h.publishBrief(), /persistence unavailable/);
	assert.equal(h.state().phase, "clarifying");
	assert.equal((await h.gate("write")).block, true);
	await h.fire("session_shutdown", { reason: "reload" });
	assert.deepEqual(h.active(), ORIGINAL);
});

test("failed approval persistence never restores write tools or dispatches execution", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	h.failPersistence();
	await assert.rejects(h.approve(), /persistence unavailable/);
	assert.equal(h.state().phase, "ready");
	assert.equal((await h.gate("write")).block, true);
	assert.equal(h.active().includes("write"), false);
	assert.equal(
		h.messages.some((item) => item.options.triggerTurn),
		false,
	);
});

test("busy cancellation cannot restore write tools underneath an in-flight alignment round", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	h.setIdle(false);
	await h.command("off");
	assert.equal(h.state().phase, "ready");
	assert.equal(h.active().includes("write"), false);
	assert.equal((await h.gate("write")).block, true);
});

test("failed cancellation persistence keeps the previous state and read-only tools", async () => {
	const h = harness();
	await h.command("on");
	await h.publishBrief();
	h.failPersistence();
	await assert.rejects(h.command("off"), /persistence unavailable/);
	assert.equal(h.state().phase, "ready");
	assert.equal(h.active().includes("write"), false);
	assert.equal((await h.gate("write")).block, true);
});

test("alignment instructions require actual material reads, preserve facts and avoid implicit approval", async () => {
	const h = harness();
	await h.command("on");
	const prompt = (await h.fire("before_agent_start")).message.content;
	assert.match(prompt, /successful read occurred/);
	assert.match(prompt, /invent nothing/);
	assert.match(prompt, /only for missing information/);
	assert.match(prompt, /model prose is never approval/);
	const current = { role: "custom", customType: "pi-deck-alignment-context", content: prompt };
	const messages = [{ role: "custom", customType: "pi-deck-alignment-context", content: "old" }, { role: "custom", customType: "pi-deck-alignment-execute" }, { role: "custom", customType: "pi-deck-alignment-state" }, { role: "user", content: "original" }, current];
	const context = await h.fire("context", { messages });
	assert.deepEqual(clone(context.messages), [{ role: "user", content: "original" }, current]);
	await h.command("off");
	assert.deepEqual(clone((await h.fire("context", { messages })).messages), [{ role: "user", content: "original" }]);
});
