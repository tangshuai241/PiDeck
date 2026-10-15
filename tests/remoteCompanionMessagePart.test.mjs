import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({
	globals: { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Buffer },
	stubs: { tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js"), "expo-crypto": { CryptoDigestAlgorithm: { SHA256: "SHA256" }, digest: async (_algorithm, bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()).buffer } },
});
const { readRemoteMessagePart } = load(resolve("src/main/remote/RemoteMessageGateway.ts"));
const { parseMessagePart, messagePartEnd } = load(resolve("packages/tpa-remote/src/messagePart.ts"));
const { parseRequest } = load(resolve("packages/tpa-remote/src/request.ts"));
const { projectRemoteMessages } = load(resolve("src/main/remote/remoteMessageProjection.ts"));
const { SessionHistoryReader } = load(resolve("src/main/pi/SessionHistoryReader.ts"));
const { downloadRemoteArtifact } = load(resolve("apps/android/src/downloadArtifact.ts"));
const { encode } = load(resolve("packages/tpa-remote/src/crypto.ts"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const command = (patch = {}) => ({ kind: "request", id: "read", issuedAt: Date.now(), challenge: "fresh", method: "message.read", sessionId: "s", messageId: "entry-assistant-a", entryId: "a", channel: "text", offset: 0, ...patch });
const row = (patch = {}) => ({ id: "live", role: "assistant", text: "", thinking: "", meta: { entryId: "a" }, timestamp: 1, ...patch });

test("full body and thinking reconstruct beyond the timeline limit without splitting emoji", async () => {
	const full = "汉".repeat(9999) + "🙂" + "字".repeat(15000);
	const message = row({ text: full, thinking: full + " end" });
	const deps = { runtime: { getTarget: () => ({ agentId: "agent" }) }, agents: { getDisplayMessages: () => [message] } };
	const projected = projectRemoteMessages([message])[0];
	assert.equal(projected.textTruncated, true);
	assert.equal(projected.thinkingTruncated, true);
	for (const channel of ["text", "thinking"]) {
		let offset = 0;
		let version;
		let restored = "";
		do {
			const input = command({ offset, channel, version });
			const part = parseMessagePart(await readRemoteMessagePart(deps, { id: "s" }, input), input.messageId, channel, offset, version);
			restored += part.text;
			version = part.version;
			offset = part.nextOffset;
		} while (offset !== null);
		assert.equal(restored, message[channel]);
	}
	assert.equal(messagePartEnd(full, 0), 9999);
});
test("full-content reads reject a changed version, hidden rows and foreign identity", async () => {
	let message = row({ text: "original" });
	const deps = { runtime: { getTarget: () => ({ agentId: "agent" }) }, agents: { getDisplayMessages: () => [message] } };
	const first = await readRemoteMessagePart(deps, { id: "s" }, command());
	message = row({ text: "rewritten" });
	await assert.rejects(readRemoteMessagePart(deps, { id: "s" }, command({ version: first.version })), /MESSAGE_CHANGED/);
	message = row({ meta: { entryId: "a", hidden: true } });
	await assert.rejects(readRemoteMessagePart(deps, { id: "s" }, command()), /MESSAGE_UNAVAILABLE/);
	await assert.rejects(readRemoteMessagePart(deps, { id: "s" }, command({ messageId: "entry-user-a" })), /MESSAGE_UNAVAILABLE/);
});
test("historical content reads use the catalog file and never activate a runtime", async () => {
	let args;
	const message = row({ text: "saved body", thinking: "saved reasoning" });
	const deps = {
		runtime: { getTarget: () => undefined },
		agents: {
			readDisplayMessagesForEntryFromFile: async (...input) => {
				args = input;
				return [message];
			},
		},
	};
	const part = await readRemoteMessagePart(deps, { id: "s", filePath: "catalog-owned.jsonl" }, command({ channel: "thinking" }));
	assert.equal(args[0], "catalog-owned.jsonl");
	assert.equal(args[2], "a");
	assert.equal(part.text, "saved reasoning");
});
test("message page decoder rejects mismatched, non-progressing and oversized responses", () => {
	const page = { messageId: "m", channel: "text", offset: 0, text: "abc", total: 3, nextOffset: null, version: hash("abc") };
	assert.equal(parseMessagePart(page, "m", "text", 0).text, "abc");
	for (const patch of [{ messageId: "other" }, { channel: "thinking" }, { nextOffset: 0 }, { text: "x".repeat(10001) }, { total: 4 }]) assert.throws(() => parseMessagePart({ ...page, ...patch }, "m", "text", 0));
	for (const patch of [{ channel: "metadata" }, { offset: -1 }, { version: "unsafe" }]) assert.throws(() => parseRequest(command(patch), "fresh"));
});
test("persisted full-entry reads respect active branches, context edits, reasoning and full tool output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tpa-entry-part-"));
	const path = join(directory, "session.jsonl");
	const full = "output".repeat(5000);
	const entry = (id, parentId, role, content) => ({ id, parentId, type: "message", message: { role, content } });
	try {
		await writeFile(
			path,
			[
				{ id: "s", type: "session" },
				entry("u", "s", "user", [{ type: "text", text: "old" }]),
				entry("a", "u", "assistant", [
					{ type: "thinking", thinking: "long reasoning" },
					{ type: "text", text: "answer" },
				]),
				entry("t", "a", "toolResult", [{ type: "text", text: full }]),
				entry("h", "t", "assistant", [{ type: "text", text: "removed" }]),
				entry("detached", "s", "assistant", [{ type: "text", text: "other branch" }]),
				{ id: "edit", parentId: "h", type: "context_edit", targetId: "u", replacement: { content: "new" } },
				{ id: "remove", parentId: "edit", type: "context_edit", targetId: "h", replacement: null },
			]
				.map(JSON.stringify)
				.join("\n"),
		);
		const reader = new SessionHistoryReader({
			toHostPath: (path) => path,
			trimMessages: (messages) => messages,
			translate: () => "",
			convertMessages: (agentId, messages, ids = []) =>
				messages.map((message, index) => ({
					id: `${agentId}-history-${ids[index]}`,
					agentId,
					role: message.role === "toolResult" ? "tool" : message.role,
					text:
						message.role === "toolResult"
							? "short tool preview"
							: message.content
									.filter((item) => item.type === "text")
									.map((item) => item.text)
									.join(""),
					thinking: message.content
						.filter((item) => item.type === "thinking")
						.map((item) => item.thinking)
						.join(""),
					timestamp: 1,
					meta: { entryId: ids[index] },
				})),
		});
		assert.equal((await reader.readDisplayMessagesForEntry(path, "live-u", "u"))[0].text, "new");
		assert.equal((await reader.readDisplayMessagesForEntry(path, "live-a", "a"))[0].thinking, "long reasoning");
		assert.equal((await reader.readDisplayMessagesForEntry(path, "live-t", "t"))[0].text, full);
		assert.equal((await reader.readDisplayMessagesForEntry(path, "live-h", "h")).length, 0);
		assert.equal((await reader.readDisplayMessagesForEntry(path, "live-detached", "detached")).length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("artifact chunks are bounded and verified before a complete file is returned", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const artifact = { id: "file", sessionId: "s", bytes: 4, digest: hash(bytes) };
	const file = await downloadRemoteArtifact(
		artifact,
		async ({ offset }) => ({ offset, data: encode(bytes.slice(offset, offset + 2)) }),
		() => {},
	);
	assert.deepEqual([...file], [...bytes]);
	await assert.rejects(
		downloadRemoteArtifact(
			{ ...artifact, digest: hash("different") },
			async ({ offset }) => ({ offset, data: encode(bytes) }),
			() => {},
		),
		/FILE_CHANGED/,
	);
	await assert.rejects(
		downloadRemoteArtifact(
			artifact,
			async () => ({ offset: 1, data: encode(bytes) }),
			() => {},
		),
		/INVALID_FILE/,
	);
});
