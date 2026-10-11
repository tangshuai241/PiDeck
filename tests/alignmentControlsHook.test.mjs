import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
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
function harness({ initialRuntime = runtime(), backend = "pi", send = async () => ({ accepted: true }) } = {}) {
	const values = new Map([
		["runtime:s1", initialRuntime],
		["mode:s1", "normal"],
	]);
	const requests = [];
	const notices = [];
	const store = {
		get: (key) => values.get(key),
		set: (key, value) => {
			if (key === "set-mode") values.set(`mode:${value.sessionId}`, value.mode);
			else values.set(key, value);
		},
	};
	const module = loadTsCommonJs(resolve("src/renderer/src/hooks/useSessionAlignmentControls.ts"), {
		globals: { crypto: { randomUUID: () => "request-123" } },
		stubs: {
			jotai: { useStore: () => store, useAtomValue: (key) => store.get(key) },
			react: { useCallback: (fn) => fn, useEffect: (fn) => fn() },
			"../atoms/composer-atoms": { sessionComposerModeBySessionIdAtomFamily: (id) => `mode:${id}`, setSessionComposerModeAtom: "set-mode" },
			"../atoms/alignment-atoms": { alignmentControlPendingAtomFamily: (id) => `pending:${id}` },
			"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => `runtime:${id}` },
			"../desktopApi": {
				desktopApi: {
					sessions: {
						sendPrompt: (input) => {
							requests.push(JSON.parse(JSON.stringify(input)));
							return send(input);
						},
					},
				},
			},
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"./useSessionTimelineController": { isSessionRuntimeBusy: (status, state) => status === "running" || Boolean(state?.isStreaming) },
		},
	});
	return { values, requests, notices, render: () => module.useSessionAlignmentControls("s1", backend) };
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

test("non-pi sessions reject every alignment action without sending text to another backend", async () => {
	const h = harness({ backend: "acp" });
	h.render().approve();
	await setImmediate();
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.notices, ["alignment.unavailable"]);
});
