import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function snapshot(revision = 2) {
	return { schemaVersion: 1, briefId: "brief-123", revision, phase: "ready", brief: { goal: "整理记录", scope: [], materials: [], deliverable: "Markdown", preserve: [], acceptance: ["范围准确"], questions: [] } };
}
function runtime(generation = 1, alignment = snapshot()) {
	return { agentId: `a${generation}`, runtimeGeneration: generation, status: "idle", state: { alignment } };
}
function deferred() {
	let resolveValue;
	const promise = new Promise((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}
function harness({ initialRuntime = runtime(), backend = "pi", send = async () => ({ accepted: true }), autoAcknowledge = true } = {}) {
	const store = createStore();
	const runtimes = atom({ s1: initialRuntime });
	const keyed = new Map();
	const keyAtom = (key) => {
		if (!keyed.has(key)) keyed.set(key, key.startsWith("runtime:") ? atom((get) => get(runtimes)[key.slice(8)]) : atom(key.startsWith("mode:") ? "normal" : undefined));
		return keyed.get(key);
	};
	const values = {
		get: (key) => store.get(keyAtom(key)),
		set: (key, value) => (key.startsWith("runtime:") ? store.set(runtimes, { ...store.get(runtimes), [key.slice(8)]: value }) : store.set(keyAtom(key), value)),
	};
	const requests = [];
	const notices = [];
	const setMode = atom(null, (_get, _set, value) => values.set(`mode:${value.sessionId}`, value.mode));
	const setSend = atom(null, (_get, _set, value) => values.set(`send:${value.sessionId}`, value.state));
	const bind = atom(null, (_get, _set, value) => values.set(`runtime:${value.sessionId}`, { ...values.get(`runtime:${value.sessionId}`), ...value }));
	let familyIndex = 0;
	const module = loadTsCommonJs(resolve("src/renderer/src/hooks/useSessionAlignmentControls.ts"), {
		globals: { crypto: { randomUUID: () => "request-123" } },
		stubs: {
			jotai: { atom, useStore: () => store, useAtomValue: (key) => store.get(key) },
			"jotai/utils": {
				atomFamily: (initialize) => {
					const prefix = ["pending", "error", "submission", "queue"][familyIndex++];
					return (id) => {
						const key = `${prefix}:${id}`;
						if (!keyed.has(key)) keyed.set(key, initialize(id));
						return keyed.get(key);
					};
				},
			},
			react: { useCallback: (fn) => fn, useEffect: (fn) => fn() },
			"../atoms/composer-atoms": { sessionComposerModeBySessionIdAtomFamily: (id) => keyAtom(`mode:${id}`), sessionSendStateBySessionIdAtomFamily: (id) => keyAtom(`send:${id}`), setSessionComposerModeAtom: setMode, setSessionSendStateAtom: setSend },
			"./session-atoms": { sessionRuntimeByIdAtom: runtimes },
			"../atoms/session-atoms": { bindSessionRuntimeAtom: bind },
			"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => keyAtom(`runtime:${id}`) },
			"../desktopApi": {
				desktopApi: {
					sessions: {
						sendPrompt: async (input) => {
							requests.push(JSON.parse(JSON.stringify(input)));
							const result = await send(input);
							const current = values.get(`runtime:${input.sessionId}`);
							if (autoAcknowledge && result.accepted && current?.runtimeGeneration === input.expectedRuntime.runtimeGeneration) {
								if (input.message.startsWith("/align")) values.set(`runtime:${input.sessionId}`, { ...current, state: { alignment: { ...current.state.alignment, phase: input.message.startsWith("/align approve") ? "approved" : input.message === "/align off" ? "cancelled" : "clarifying" } } });
							}
							return result;
						},
					},
				},
			},
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"./useSessionTimelineController": { isSessionRuntimeBusy: (status, state) => status === "running" || Boolean(state?.isStreaming) },
		},
	});
	// Load the same atom module graph through the hook; its exports are captured via the shared atomFamily implementation.
	return { values, requests, notices, store, render: (id = "s1") => module.useSessionAlignmentControls(id, backend) };
}

test("draft selection and cancellation need no runtime or background request", () => {
	const h = harness({ initialRuntime: undefined });
	h.values.set("runtime:s1", undefined);
	assert.equal(h.render().changeMode("alignment", "normal"), true);
	assert.equal(h.values.get("mode:s1"), "alignment");
	h.render().cancel();
	assert.equal(h.values.get("mode:s1"), "normal");
	assert.equal(h.requests.length, 0);
});

test("approval sends the exact brief revision and runtime target before returning to ordinary mode", async () => {
	const h = harness();
	h.render().approve();
	await setImmediate();
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].message, "/align approve brief-123 2");
	assert.deepEqual(h.requests[0].expectedRuntime, { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 });
	assert.equal(h.values.get("mode:s1"), "normal");
	assert.equal(h.values.get("pending:s1"), false);
});

test("stale cards fail before RPC when requirements have changed", () => {
	const h = harness();
	const card = h.render();
	h.values.set("runtime:s1", runtime(1, snapshot(3)));
	card.approve();
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.notices, ["alignment.requirementsChanged"]);
});

test("late approval acceptance cannot reset the replacement runtime's selected mode", async () => {
	const wait = deferred();
	const h = harness({ send: () => wait.promise });
	h.render().approve();
	h.values.set("runtime:s1", runtime(2));
	h.values.set("mode:s1", "alignment");
	wait.resolve({ accepted: true });
	await setImmediate();
	assert.equal(h.values.get("mode:s1"), "alignment");
	assert.equal(h.requests[0].expectedRuntime.runtimeGeneration, 1);
});

test("split views share one pending control and cannot send duplicate approval", async () => {
	const wait = deferred();
	const h = harness({ send: () => wait.promise });
	h.render().approve();
	h.render().approve();
	assert.equal(h.requests.length, 1);
	assert.deepEqual(h.notices, ["alignment.busy"]);
	wait.resolve({ accepted: true });
	await setImmediate();
	assert.equal(h.values.get("pending:s1"), false);
});

test("failed cancellation preserves alignment instead of pretending it was stopped", async () => {
	const h = harness({ send: async () => ({ accepted: false, error: "unavailable" }) });
	h.render().cancel();
	await setImmediate();
	assert.equal(h.values.get("mode:s1"), "alignment");
	assert.deepEqual(h.notices, ["alignment.actionFailed"]);
});

test("delivery acceptance keeps alignment pending until the exact authoritative approval arrives", async () => {
	const h = harness({ autoAcknowledge: false });
	h.render().approve();
	await setImmediate();
	assert.equal(h.values.get("mode:s1"), "alignment");
	assert.equal(h.values.get("pending:s1"), true);
	assert.equal(h.render().presentation.kind, "confirming");
	h.values.set("runtime:s1", runtime(1, { ...snapshot(), phase: "approved" }));
	await setImmediate();
	assert.equal(h.values.get("mode:s1"), "normal");
	assert.equal(h.values.get("pending:s1"), false);
});

test("captured confirmation cannot approve while a revision is sending or queued", () => {
	for (const key of ["send:s1", "queue:s1"]) {
		const h = harness();
		const card = h.render();
		h.values.set(key, key.startsWith("send") ? { status: "sending" } : 1);
		card.approve();
		assert.equal(h.requests.length, 0);
		assert.equal(h.render().presentation.canApprove, false);
	}
});

test("an old version failure does not poison a newly published complete brief", async () => {
	const h = harness({ send: async () => ({ accepted: false, error: "rejected" }) });
	h.render().approve();
	await setImmediate();
	assert.equal(h.render().presentation.kind, "failed");
	h.values.set("runtime:s1", runtime(1, snapshot(3)));
	assert.equal(h.render().presentation.kind, "ready");
	assert.equal(h.render().controlError, undefined);
});

test("resuming an interrupted round uses the ordinary read-only marker and invalidates its old version", async () => {
	const h = harness({ initialRuntime: runtime(1, { ...snapshot(), phase: "clarifying", lastStopReason: "aborted" }) });
	assert.equal(h.render().presentation.kind, "interrupted");
	h.values.set("send:s1", { status: "error" });
	h.render().resume();
	await setImmediate();
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].message, "alignment.resumeRequest");
	assert.equal(h.requests[0].agentMessage, "__PI_DECK_ALIGNMENT_MODE__\nalignment.resumeRequest");
	assert.equal(h.requests[0].expectedRuntime.runtimeGeneration, 1);
	assert.equal(h.values.get("mode:s1"), "alignment");
	assert.equal(h.values.get("submission:s1").revision, 2);
	assert.equal(h.values.get("send:s1").status, "idle");
});

test("a late resume response cannot settle a replacement runtime's new send request", async () => {
	const wait = deferred();
	const h = harness({ send: () => wait.promise, autoAcknowledge: false, initialRuntime: runtime(1, { ...snapshot(), phase: "clarifying", lastStopReason: "aborted" }) });
	h.render().resume();
	h.values.set("runtime:s1", runtime(2));
	h.values.set("send:s1", { status: "sending", requestId: "replacement-request" });
	wait.resolve({ accepted: true });
	await setImmediate();
	assert.equal(h.values.get("send:s1").requestId, "replacement-request");
	assert.equal(h.values.get("send:s1").status, "sending");
	assert.equal(h.values.get("runtime:s1").status, "idle");
});

test("another session's delivery and pending control do not affect this session's ready sheet", () => {
	const h = harness();
	h.values.set("runtime:s2", runtime(2, snapshot(8)));
	h.render("s2");
	h.values.set("send:s1", { status: "sending" });
	h.values.set("pending:s1", true);
	assert.equal(h.render("s1").presentation.canApprove, false);
	assert.equal(h.render("s2").presentation.canApprove, true);
});

test("non-pi sessions reject every alignment action without sending text to another backend", async () => {
	const h = harness({ backend: "acp" });
	h.render().approve();
	await setImmediate();
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.notices, ["alignment.unavailable"]);
});
