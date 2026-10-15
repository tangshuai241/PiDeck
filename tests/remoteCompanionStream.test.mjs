import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({ globals: { Buffer, TextEncoder, Uint8Array, ArrayBuffer }, stubs: { tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js") } });
const { projectLiveMessageView } = load(resolve("src/main/pi/liveMessageView.ts"));
const { projectRemoteMessages } = load(resolve("src/main/remote/remoteMessageProjection.ts"));
const { diffSnapshots, applyPatch, parsePatch } = load(resolve("packages/tpa-remote/src/stream.ts"));
const { RemoteSessionFeed } = load(resolve("src/main/remote/RemoteSessionFeed.ts"));
const row = (patch = {}) => ({ id: "assistant", agentId: "agent", role: "assistant", text: "", timestamp: 1, ...patch });
const snapshot = (messages = [{ id: "a", role: "assistant", text: "hello", timestamp: 1 }], patch = {}) => ({
	sessionId: "session",
	target: { sessionId: "session", agentId: "agent", runtimeGeneration: 1 },
	messages,
	questions: [],
	busy: true,
	revision: 1,
	hasOlder: false,
	cursor: { epoch: "epoch", sequence: 1 },
	...patch,
});

test("live display overlays both channels without mutating history or other messages", () => {
	const history = [row(), row({ id: "other", text: "original" })];
	const view = projectLiveMessageView(history, "assistant", "partial answer", "partial reasoning", { assistantMessageId: "assistant", startedAt: 1, endedAt: 0 });
	assert.equal(view[0].text, "partial answer");
	assert.equal(view[0].thinking, "partial reasoning");
	assert.equal(history[0].text, "");
	assert.equal(view[1], history[1]);
});
test("remote rows retain thinking and tool output while excluding hidden controls and raw metadata", () => {
	const projected = projectRemoteMessages([
		row({ meta: { hidden: true }, text: "internal control" }),
		row({ id: "visible", thinking: "reasoning", meta: { token: "private" } }),
		row({ id: "tool", role: "tool", text: "▶ read", meta: { toolName: "read", status: "running", detailText: "partial output", token: "private" } }),
	]);
	assert.equal(projected.length, 2);
	assert.equal(projected[0].thinking, "reasoning");
	assert.equal(projected[1].tool.detail, "partial output");
	assert.equal(projected[1].tool.status, "running");
	assert(!JSON.stringify(projected).includes("private"));
});
test("append deltas reconstruct body and reasoning; duplicates do not duplicate tokens", () => {
	const before = snapshot();
	const next = snapshot([{ ...before.messages[0], text: "hello world", thinking: "checked sources" }]);
	const patch = parsePatch(diffSnapshots(before, next, { epoch: "epoch", sequence: 2 }));
	assert.equal(patch.upserts.length, 0);
	assert.equal(patch.deltas[0].text, " world");
	const result = applyPatch(before, patch);
	assert.equal(result.messages[0].text, "hello world");
	assert.equal(result.messages[0].thinking, "checked sources");
	assert.equal(applyPatch(result, patch), result);
	assert.throws(() => applyPatch(before, { ...patch, previous: 2, cursor: { epoch: "epoch", sequence: 3 } }), /STREAM_GAP/);
	assert.throws(() => applyPatch(before, { ...patch, sessionId: "other" }), /STREAM_RESET_REQUIRED/);
});
test("rewrites and tool status changes replace the authoritative row instead of appending", () => {
	const before = snapshot([{ id: "t", role: "tool", text: "read", timestamp: 1, tool: { name: "read", status: "running", detail: "half" } }]);
	const next = snapshot([{ id: "t", role: "tool", text: "done", timestamp: 2, tool: { name: "read", status: "done", detail: "full" } }]);
	const patch = parsePatch(diffSnapshots(before, next, { epoch: "epoch", sequence: 2 }));
	assert.equal(patch.upserts.length, 1);
	assert.equal(applyPatch(before, patch).messages[0].tool.status, "done");
	assert.throws(() => parsePatch({ ...patch, deltas: [{ id: "t", timestamp: 2, thinking: "x".repeat(12001) }] }));
});
test("feed replays missed work and uses a full baseline for unknown cursors", async () => {
	let current = snapshot();
	const emitted = [];
	const feed = new RemoteSessionFeed(
		async () => current,
		(patch) => emitted.push(patch),
		() => {},
	);
	try {
		const first = await feed.synchronize("session");
		assert(first.snapshot);
		const cursor = first.snapshot.cursor;
		current = snapshot([{ id: "a", role: "assistant", text: "hello world", thinking: "live reasoning", timestamp: 2 }]);
		feed.invalidate("session");
		await delay(80);
		assert.equal(emitted.length, 1);
		const resumed = await feed.synchronize("session", cursor);
		assert.equal(resumed.snapshot, undefined);
		assert.equal(resumed.patches.length, 1);
		assert.equal(applyPatch(first.snapshot, resumed.patches[0]).messages[0].thinking, "live reasoning");
		const reset = await feed.synchronize("session", { epoch: "lost", sequence: 0 });
		assert(reset.snapshot);
		assert.equal(reset.patches.length, 0);
	} finally {
		feed.dispose();
	}
});
test("disposing the feed cancels pending refreshes and ignores late reads", async () => {
	let finish;
	let calls = 0;
	const feed = new RemoteSessionFeed(
		() => {
			calls++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
		() => {
			throw new Error("must not publish");
		},
		() => {},
	);
	const pending = feed.synchronize("session");
	feed.dispose();
	finish(snapshot());
	await assert.rejects(pending);
	assert.equal(calls, 1);
});
