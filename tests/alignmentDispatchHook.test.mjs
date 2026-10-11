import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Queue dispatch uses the real submission builder and session atoms; delivery alone cannot republish the brief. */
function harness() {
	const store = createStore();
	const atoms = {};
	const requests = [];
	let resolveDelivery;
	const delivery = new Promise((resolve) => {
		resolveDelivery = resolve;
	});
	const load = createTsSandbox({
		globals: { crypto: { randomUUID: () => "queued-request" } },
		stubs: {
			jotai: { atom, useStore: () => store },
			react: { useCallback: (fn) => fn, useRef: (value) => ({ current: value }) },
			"../../atoms": atoms,
			"../../i18n": { t: (key) => key, translateI18nDescriptor: (_value, fallback) => fallback },
			"../../desktopApi": {
				desktopApi: {
					sessions: {
						sendPrompt: (input) => {
							requests.push(input);
							return delivery;
						},
					},
				},
			},
		},
	});
	Object.assign(atoms, load("src/renderer/src/atoms/session-atoms.ts"), load("src/renderer/src/atoms/composer-atoms.ts"), load("src/renderer/src/atoms/session-selectors.ts"), load("src/renderer/src/atoms/alignment-atoms.ts"));
	const { useSessionPromptDispatch } = load("src/renderer/src/hooks/session/useSessionPromptDispatch.ts");
	const hook = useSessionPromptDispatch({ store, setSessionDraft: () => {}, currentSessionId: "s1", currentSessionIdRef: { current: "s1" }, activeAgentIdRef: { current: "a1" }, showToast: () => {} });
	return { store, atoms, hook, requests, resolveDelivery };
}
test("queued alignment dispatch synchronously records the old version and sends its hidden marker separately from visible text", async () => {
	const h = harness();
	h.store.set(h.atoms.sessionRuntimeByIdAtom, {
		s1: {
			agentId: "a1",
			runtimeGeneration: 1,
			status: "idle",
			updatedAt: 0,
			state: { alignment: { schemaVersion: 1, briefId: "brief-123", revision: 2, briefRevision: 2, phase: "ready", brief: { goal: "整理术语", scope: [], materials: [], deliverable: "Word", preserve: [], acceptance: ["内容准确"], questions: [] } } },
		},
	});
	const pending = h.hook.dispatchPromptSnapshot("s1", "改为 Excel", undefined, "followUp", "alignment");
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].message, "改为 Excel");
	assert.equal(h.requests[0].agentMessage, "__PI_DECK_ALIGNMENT_MODE__\n改为 Excel");
	assert.equal(h.store.get(h.atoms.alignmentSubmissionAtomFamily("s1")).revision, 2);
	assert.equal(h.store.get(h.atoms.alignmentSubmissionAtomFamily("s2")), undefined);
	h.resolveDelivery({ accepted: true });
	await pending;
	assert.equal(h.store.get(h.atoms.alignmentSubmissionAtomFamily("s1")).requestId, "queued-request");
});
test("ordinary chat dispatch neither adds alignment markers nor invalidates requirements", async () => {
	const h = harness();
	const pending = h.hook.dispatchPromptSnapshot("s1", "普通聊天", undefined, undefined, "normal");
	assert.equal(h.requests[0].agentMessage, undefined);
	assert.equal(h.store.get(h.atoms.alignmentSubmissionAtomFamily("s1")), undefined);
	h.resolveDelivery({ accepted: true });
	await pending;
});
