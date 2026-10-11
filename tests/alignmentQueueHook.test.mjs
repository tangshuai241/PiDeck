import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Production queue hook and atoms; only React mounting is replaced for deterministic enqueue/cleanup checks. */
function harness() {
	const store = createStore();
	const atoms = {};
	const cleanups = [];
	const load = createTsSandbox({
		stubs: {
			jotai: { atom },
			react: {
				useRef: (initial) => ({ current: initial }),
				useCallback: (fn) => fn,
				useState: (initial) => [initial, () => {}],
				useEffect: (fn) => {
					const cleanup = fn();
					if (cleanup) cleanups.push(cleanup);
				},
			},
			"../atoms": atoms,
			"../i18n": { t: (key) => key },
		},
	});
	Object.assign(atoms, load("src/renderer/src/atoms/session-atoms.ts"), load("src/renderer/src/atoms/composer-atoms.ts"), load("src/renderer/src/atoms/alignment-atoms.ts"));
	const { useQueuedPrompt } = load("src/renderer/src/hooks/useQueuedPrompt.ts");
	const hook = useQueuedPrompt({
		store,
		displayAgentsRef: { current: [] },
		queueFlushBySessionRef: { current: new Set() },
		composerTextareaRef: { current: null },
		pendingComposerCaretRef: { current: null },
		setComposerCursor: () => {},
		showToast: () => {},
		dispatchPromptSnapshot: async () => {
			throw new Error("unexpected dispatch");
		},
	});
	return { hook, count: (id) => store.get(atoms.alignmentQueuedCountAtomFamily(id)), unmount: () => cleanups.forEach((fn) => fn()) };
}
const prompt = (id, status = "queued") => ({ id, displayText: "修改要求", message: "修改要求", agentMode: "alignment", behavior: "followUp", status, createdAt: 0 });

test("enqueue retires confirmation synchronously; retraction restores count without touching another session", () => {
	const h = harness();
	assert.equal(h.count("s1"), 0);
	assert.equal(h.hook.enqueueQueuedPrompt("s1", prompt("p1")), true);
	assert.equal(h.count("s1"), 1);
	assert.equal(h.count("s2"), 0);
	h.hook.enqueueQueuedPrompt("s2", prompt("p2"));
	h.hook.retractQueuedPrompt("s1", "p1");
	assert.equal(h.count("s1"), 0);
	assert.equal(h.count("s2"), 1);
	h.unmount();
	assert.equal(h.count("s2"), 0);
});
test("unknown delivery continues to block confirmation until the user acknowledges/discards it", () => {
	const h = harness();
	h.hook.enqueueQueuedPrompt("s1", prompt("p1", "unknown"));
	assert.equal(h.count("s1"), 1);
	h.hook.discardQueuedPrompt("s1", "p1");
	assert.equal(h.count("s1"), 0);
	h.unmount();
});
