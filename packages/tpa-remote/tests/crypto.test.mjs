import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "../../../tests/helpers/loadTsCommonJs.mjs";
const require = createRequire(import.meta.url);
const { encode, decode, seal, open, keyPair, sharedKey, parsePairing } = loadTsCommonJs(fileURLToPath(new URL("../src/crypto.ts", import.meta.url)), { stubs: { tweetnacl: require("tweetnacl"), "base64-js": require("base64-js") } });

const random = (length) => new Uint8Array(randomBytes(length));
test("encrypted packets round-trip without exposing message text", () => {
	const key = random(32);
	const packet = seal({ kind: "test", text: "私有对话" }, key, random);
	assert(!packet.includes("私有对话"));
	assert.equal(open(packet, key).text, "私有对话");
});
test("wrong keys and tampered ciphertext are rejected", () => {
	const key = random(32);
	const packet = seal({ kind: "test" }, key, random);
	assert.throws(() => open(packet, random(32)));
	const parsed = JSON.parse(packet);
	parsed.box = encode(random(decode(parsed.box).length));
	assert.throws(() => open(JSON.stringify(parsed), key));
});
test("phone and host derive the same authenticated box key", () => {
	const host = keyPair(random);
	const phone = keyPair(random);
	assert.equal(encode(sharedKey(host.publicKey, phone.secretKey)), encode(sharedKey(phone.publicKey, host.secretKey)));
});
test("malformed and oversized packets fail before decryption", () => {
	for (const value of ["null", "[]", "{bad", JSON.stringify({ v: 2 }), "x".repeat(2_000_001)]) assert.throws(() => open(value, random(32)));
});
test("pairing accepts only bounded secure relay URLs and valid secrets", () => {
	const pair = { v: 1, relay: "wss://workbench.starveiled.cn/tpa-relay/v1", room: "a".repeat(32), token: "b".repeat(64), key: encode(random(32)), hostKey: encode(random(32)), expiresAt: Date.now() + 60_000 };
	assert.equal(parsePairing(JSON.stringify(pair)).room, pair.room);
	for (const invalid of [
		{ ...pair, relay: "ws://evil.test" },
		{ ...pair, relay: "wss://user:pass@evil.test" },
		{ ...pair, key: "bad" },
		{ ...pair, expiresAt: 0 },
	])
		assert.throws(() => parsePairing(JSON.stringify(invalid)));
});
