import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const ws = requireRemote("ws");
const appStateListeners = new Set();
const load = createTsSandbox({
	globals: { WebSocket: ws.WebSocket, Uint8Array, ArrayBuffer, fetch },
	stubs: {
		tweetnacl: requireRemote("tweetnacl"),
		"base64-js": requireRemote("base64-js"),
		ws,
		"expo-crypto": { getRandomBytes: (length) => new Uint8Array(randomBytes(length)), CryptoDigestAlgorithm: { SHA256: "SHA256" }, digestStringAsync: async (_algorithm, text) => createHash("sha256").update(text).digest("hex") },
		"react-native": {
			AppState: {
				addEventListener: (_name, listener) => {
					appStateListeners.add(listener);
					return { remove: () => appStateListeners.delete(listener) };
				},
			},
		},
	},
});
const { createRelay } = load(resolve("packages/tpa-remote/src/relay.ts"));
const { encode, keyPair } = load(resolve("packages/tpa-remote/src/crypto.ts"));
const { RemoteCommandLedger } = load(resolve("src/main/remote/RemoteCommandLedger.ts"));
const { RemoteCompanionService } = load(resolve("src/main/remote/RemoteCompanionService.ts"));
const { PhoneClient } = load(resolve("apps/android/src/phoneClient.ts"));
const { readRemoteMessagePart } = load(resolve("src/main/remote/RemoteMessageGateway.ts"));
const random = (length) => new Uint8Array(randomBytes(length));
async function until(predicate) {
	const end = Date.now() + 8000;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("timed out");
		await delay(20);
	}
}

async function harness(confirmDevice, action, persist = async () => {}) {
	const temp = await mkdtemp(join(tmpdir(), "tpa-channel-"));
	const hostKey = keyPair(random);
	const phoneKey = keyPair(random);
	const hostToken = "a".repeat(64);
	const phoneToken = "b".repeat(64);
	const room = "c".repeat(32);
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const relay = createRelay({ rooms: [{ id: room, hostHash: hash(hostToken), phoneHash: hash(phoneToken) }] });
	relay.server.listen(0, "127.0.0.1");
	await once(relay.server, "listening");
	let config = { version: 1, enabled: true, relay: `ws://127.0.0.1:${relay.server.address().port}/tpa-relay/v1`, room, hostToken, phoneToken, hostPublicKey: encode(hostKey.publicKey), hostSecretKey: encode(hostKey.secretKey), invite: { key: encode(random(32)), expiresAt: Date.now() + 60_000 } };
	const credentials = { pairing: { v: 1, relay: config.relay, room, token: phoneToken, key: config.invite.key, hostKey: config.hostPublicKey, expiresAt: config.invite.expiresAt }, publicKey: encode(phoneKey.publicKey), secretKey: encode(phoneKey.secretKey), paired: false };
	let commands = 0;
	let state = "unpaired";
	let snapshot;
	const receipts = [];
	const changes = new Set();
	let disconnectOnSend = false;
	const target = { sessionId: "session", agentId: "agent", runtimeGeneration: 1 };
	const messages = [{ id: "first", role: "assistant", text: "original history", timestamp: 1 }];
	const gateway = {
		subscribe: (listener) => {
			changes.add(listener);
			return () => changes.delete(listener);
		},
		list: () => [{ id: "session", title: "test", project: "test", backend: "pi", updatedAt: 1, active: true }],
		snapshot: async () => ({ sessionId: "session", target, messages: [...messages], questions: [], busy: false, revision: messages.length, hasOlder: false }),
		execute: async (request) => {
			if (request.method === "session.read") return { kind: "response", id: request.id, ok: true, result: await gateway.snapshot() };
			if (request.method === "session.send") {
				commands++;
				messages.push({ id: "user", role: "user", text: request.text, timestamp: 2 });
				for (const listener of changes) listener("session");
				if (disconnectOnSend) for (const listener of appStateListeners) listener("background");
			}
			return { kind: "response", id: request.id, ok: true };
		},
	};
	const host = new RemoteCompanionService({
		config: {
			read: async () => config,
			write: async (next) => {
				config = next;
			},
		},
		ledger: new RemoteCommandLedger(join(temp, "receipts.json")),
		gateway,
		confirmDevice,
		log() {},
	});
	const phone = new PhoneClient(persist);
	phone.subscribe((event) => {
		if (event.kind === "state") state = event.state;
		if (event.kind === "snapshot") snapshot = event.snapshot;
		if (event.kind === "receipt") receipts.push(event);
	});
	try {
		await host.start();
		await phone.restore(credentials);
		await action({
			host,
			phone,
			gateway,
			state: () => state,
			snapshot: () => snapshot,
			commands: () => commands,
			config: () => config,
			receipts,
			update: (patch) => {
				messages[0] = { ...messages[0], ...patch };
				for (const listener of changes) listener("session");
			},
			pause: () => {
				for (const listener of appStateListeners) listener("background");
			},
			resume: () => {
				for (const listener of appStateListeners) listener("active");
			},
			loseNextReceipt: () => {
				disconnectOnSend = true;
			},
		});
	} finally {
		phone.dispose();
		host.dispose();
		await relay.dispose();
		await rm(temp, { recursive: true, force: true });
	}
}
test("real local sockets pair, encrypt, read and send through the host gateway", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			assert(h.config().phone);
			assert.equal(h.config().invite, undefined);
			await h.phone.select("session");
			assert.equal(h.snapshot().messages[0].text, "original history");
			await h.phone.send(h.snapshot(), "remote instruction");
			await until(() => h.snapshot().messages.some((message) => message.text === "remote instruction"));
			assert.equal(h.commands(), 1);
			await h.host.revoke();
			await until(() => h.state() !== "connected");
			await assert.rejects(h.phone.send(h.snapshot(), "blocked"));
			assert.equal(h.commands(), 1);
		},
	),
);

test("phone-selected model survives encrypted transport and its durable command identity", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			await h.phone.select("session");
			const execute = h.gateway.execute;
			let received;
			h.gateway.execute = async (request) => {
				if (request.method === "session.send") received = request.model;
				return execute(request);
			};
			await h.phone.send(h.snapshot(), "model-specific instruction", { provider: "provider", modelId: "chosen" });
			assert.equal(received.provider, "provider");
			assert.equal(received.modelId, "chosen");
			assert.equal(h.commands(), 1);
		},
	),
);
test("revoking while the pairing prompt is open prevents late approval", { timeout: 15_000 }, async () => {
	let accept;
	let prompted = false;
	const decision = new Promise((done) => {
		accept = done;
	});
	await harness(
		async () => {
			prompted = true;
			return decision;
		},
		async (h) => {
			await until(() => prompted);
			await h.host.revoke();
			accept(true);
			await delay(100);
			assert.equal(h.config().phone, undefined);
			assert.equal(h.config().enabled, false);
			assert.notEqual(h.state(), "connected");
		},
	);
});
test("live body and thinking reach the phone, including events emitted while it is backgrounded", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			await h.phone.select("session");
			h.update({ text: "partial answer", thinking: "checking sources", thinkingStartedAt: 1, thinkingEndedAt: 0 });
			await until(() => h.snapshot().messages[0].thinking === "checking sources");
			assert.equal(h.snapshot().messages[0].text, "partial answer");
			const cursor = h.snapshot().cursor.sequence;
			h.pause();
			await until(() => h.state() === "offline");
			h.update({ text: "completed answer", thinking: "checking sources, done", thinkingEndedAt: 2 });
			await delay(100);
			h.resume();
			await until(() => h.state() === "connected" && h.snapshot().messages[0].text === "completed answer");
			assert(h.snapshot().cursor.sequence > cursor);
			assert.equal(h.snapshot().messages[0].thinking, "checking sources, done");
			assert.equal(h.commands(), 0);
		},
	),
);
test("lost mutation acknowledgements reconcile from durable receipts without resending", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			await h.phone.select("session");
			h.loseNextReceipt();
			await assert.rejects(h.phone.send(h.snapshot(), "only once"), /DELIVERY_UNKNOWN/);
			await delay(100);
			h.resume();
			await until(() => h.receipts.length === 1);
			assert.equal(h.receipts[0].ok, true);
			assert.equal(h.commands(), 1);
			await delay(100);
			assert.equal(h.commands(), 1);
		},
	),
);
test("forgetting a device during credential persistence cannot revive its old connection", { timeout: 15_000 }, async () => {
	let release;
	let saving = false;
	const hold = new Promise((done) => {
		release = done;
	});
	await harness(
		async () => true,
		async (h) => {
			await until(() => saving);
			await h.phone.forget();
			release();
			await delay(100);
			assert.equal(h.state(), "unpaired");
			assert.equal(h.commands(), 0);
		},
		async (credentials) => {
			if (credentials?.paired) {
				saving = true;
				await hold;
			}
		},
	);
});
test("successful creation remains successful when its following catalog refresh fails", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			let creations = 0;
			h.gateway.execute = async (request) => {
				if (request.method === "session.create") {
					creations++;
					return { kind: "response", id: request.id, ok: true, result: { sessionId: "created", accepted: true } };
				}
				return { kind: "response", id: request.id, ok: false, error: "REQUEST_FAILED" };
			};
			const result = await h.phone.createSession("project", "first prompt");
			assert.equal(result.sessionId, "created");
			assert.equal(result.accepted, true);
			await delay(80);
			assert.equal(creations, 1);
		},
	),
);
test("full long messages page through the encrypted phone channel without another command", { timeout: 15_000 }, async () =>
	harness(
		async () => true,
		async (h) => {
			await until(() => h.state() === "connected");
			const full = "🙂内容".repeat(8000);
			h.gateway.execute = async (request) => ({
				kind: "response",
				id: request.id,
				ok: true,
				result: await readRemoteMessagePart({ runtime: { getTarget: () => ({ agentId: "agent" }) }, agents: { getDisplayMessages: () => [{ id: "live", role: "assistant", text: full, timestamp: 1, meta: { entryId: "a" } }] } }, { id: "session" }, request),
			});
			let offset = 0;
			let version;
			let restored = "";
			do {
				const part = await h.phone.messagePart("session", "entry-assistant-a", "text", offset, "a", version);
				restored += part.text;
				version = part.version;
				offset = part.nextOffset;
			} while (offset !== null);
			assert.equal(restored, full);
			assert.equal(h.commands(), 0);
		},
	),
);
