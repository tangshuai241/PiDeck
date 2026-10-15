import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const { ChatViewport, outputChanged, processIsOpen } = createTsSandbox()(resolve("apps/android/src/chatViewport.ts"));

test("opening details preserves follow and only holds the disclosure layout", () => {
	const view = new ChatViewport();
	view.disclose();
	assert.equal(view.resize(), false);
	assert.equal(view.following, true);
	view.output();
	assert.equal(view.resize(), true);
});
test("user scroll pauses following, layout scroll cannot resume it, and bottom restores it", () => {
	const view = new ChatViewport();
	view.scroll(300, true);
	view.scroll(0, false);
	view.output();
	assert.equal(view.resize(), false);
	assert.equal(view.unread, true);
	view.scroll(0, true);
	assert.equal(view.resize(), true);
	assert.equal(view.unread, false);
});
test("loading history pauses follow until latest is explicitly requested", () => {
	const view = new ChatViewport();
	view.pause();
	view.output();
	assert.equal(view.resize(), false);
	view.latest();
	assert.equal(view.resize(), true);
});
test("metadata and reconnect clones do not invent unread output", () => {
	const before = [{ id: "a", text: "text", thinking: "reason", timestamp: 1 }];
	assert.equal(outputChanged(before, [{ ...before[0], timestamp: 2 }]), false);
	assert.equal(outputChanged(before, [{ ...before[0], text: "more" }]), true);
});
test("process defaults open but an explicit collapse survives output updates", () => {
	assert.equal(processIsOpen("turn", new Map()), true);
	assert.equal(processIsOpen("turn", new Map([["turn", false]])), false);
});
