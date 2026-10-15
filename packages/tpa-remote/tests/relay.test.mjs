import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "../../../tests/helpers/loadTsCommonJs.mjs";
const require = createRequire(import.meta.url);
const wsModule = require("ws");
const { createRelay } = loadTsCommonJs(fileURLToPath(new URL("../src/relay.ts", import.meta.url)), { stubs: { ws: wsModule } });
const hostToken = "a".repeat(64);
const phoneToken = "b".repeat(64);
const id = "c".repeat(32);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function harness(fn, options = {}) {
	const relay = createRelay({ rooms: [{ id, hostHash: hash(hostToken), phoneHash: hash(phoneToken) }], ...options });
	relay.server.listen(0, "127.0.0.1");
	await once(relay.server, "listening");
	const url = `ws://127.0.0.1:${relay.server.address().port}/tpa-relay/v1/${id}`;
	try {
		await fn(url);
	} finally {
		await relay.dispose();
	}
}
function connect(url, role, token) {
	return new wsModule.WebSocket(`${url}/${role}`, ["tpa-v1", token]);
}
test("relay rejects wrong credentials before accepting a socket", async () =>
	harness(async (url) => {
		const socket = connect(url, "phone", hostToken);
		const [error] = await once(socket, "error");
		assert.match(error.message, /401/);
	}));
test("relay forwards opaque frames between authenticated peers", async () =>
	harness(async (url) => {
		const host = connect(url, "host", hostToken);
		await once(host, "open");
		const phone = connect(url, "phone", phoneToken);
		await once(phone, "open");
		const received = new Promise((done) =>
			phone.on("message", (data) => {
				if (data.toString() === "opaque-ciphertext") done(data.toString());
			}),
		);
		host.send("opaque-ciphertext");
		assert.equal(await received, "opaque-ciphertext");
	}));
test("new phone replaces the old socket without allowing its late frames", async () =>
	harness(async (url) => {
		const first = connect(url, "phone", phoneToken);
		await once(first, "open");
		const closed = once(first, "close");
		const second = connect(url, "phone", phoneToken);
		await once(second, "open");
		assert.equal((await closed)[0], 4001);
	}));
test("host-only route rotation persists before rejecting the previous phone token", async () => {
	const saved = [];
	const next = "d".repeat(64);
	await harness(
		async (url) => {
			const endpoint = `${url.replace("ws:", "http:")}/route`;
			const first = connect(url, "phone", phoneToken);
			await once(first, "open");
			const headers = { Authorization: `Bearer ${phoneToken}`, "Content-Type": "application/json" };
			assert.equal((await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify({ phoneHash: hash(next) }) })).status, 401);
			assert.equal(saved.length, 0);
			const closed = once(first, "close");
			assert.equal((await fetch(endpoint, { method: "PUT", headers: { ...headers, Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ phoneHash: hash(next) }) })).status, 204);
			assert.equal((await closed)[0], 4003);
			assert.equal(saved[0], hash(next));
			const old = connect(url, "phone", phoneToken);
			assert.match((await once(old, "error"))[0].message, /401/);
			const second = connect(url, "phone", next);
			await once(second, "open");
		},
		{
			persistRotation: async (_room, hash) => {
				saved.push(hash);
			},
		},
	);
});
test("failed route persistence keeps the existing phone credential valid", async () =>
	harness(
		async (url) => {
			const response = await fetch(`${url.replace("ws:", "http:")}/route`, { method: "PUT", headers: { Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ phoneHash: hash("d".repeat(64)) }) });
			assert.equal(response.status, 400);
			const phone = connect(url, "phone", phoneToken);
			await once(phone, "open");
		},
		{
			persistRotation: async () => {
				throw new Error("disk unavailable");
			},
		},
	));
