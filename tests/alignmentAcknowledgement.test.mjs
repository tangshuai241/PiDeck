import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { waitForAlignmentAcknowledgement } = loadTsCommonJs(resolve("src/renderer/src/utils/alignmentAcknowledgement.ts"));
function harness() {
	let state;
	let current = true;
	const listeners = new Set();
	const options = {
		read: () => state,
		isCurrent: () => current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		matches: (snapshot) => snapshot.briefId === "brief-1" && snapshot.revision === 2 && snapshot.phase === "approved",
		timeoutMs: 50,
	};
	return {
		options,
		listeners,
		update: (next) => {
			state = next;
			for (const fn of listeners) fn();
		},
		replace: () => {
			current = false;
			for (const fn of listeners) fn();
		},
	};
}
test("delivered or wrong-version states do not acknowledge approval; exact authoritative state releases the listener", async () => {
	const h = harness();
	let settled = false;
	const pending = waitForAlignmentAcknowledgement(h.options).then(() => {
		settled = true;
	});
	h.update({ briefId: "brief-1", revision: 2, phase: "ready" });
	h.update({ briefId: "brief-1", revision: 3, phase: "approved" });
	await Promise.resolve();
	assert.equal(settled, false);
	h.update({ briefId: "brief-1", revision: 2, phase: "approved" });
	await pending;
	assert.equal(h.listeners.size, 0);
});
test("missing acknowledgement times out instead of leaving confirmation pending forever", async () => {
	const h = harness();
	await assert.rejects(waitForAlignmentAcknowledgement({ ...h.options, timeoutMs: 2 }), /notAcknowledged/);
	assert.equal(h.listeners.size, 0);
});
test("replacement runtime cancels the wait and removes its listener", async () => {
	const h = harness();
	const pending = waitForAlignmentAcknowledgement(h.options);
	h.replace();
	await assert.rejects(pending, /runtimeChanged/);
	assert.equal(h.listeners.size, 0);
});
test("an acknowledgement that arrives before registration is still observed and cleaned up", async () => {
	const h = harness();
	h.update({ briefId: "brief-1", revision: 2, phase: "approved" });
	await waitForAlignmentAcknowledgement(h.options);
	assert.equal(h.listeners.size, 0);
});
