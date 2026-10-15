import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const load = createTsSandbox({
	globals: { URL, Buffer, Uint8Array },
	stubs: { electron: { safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`test-sealed:${text}`), decryptString: (bytes) => bytes.toString().slice("test-sealed:".length) } }, tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js") },
});
const { RemoteCompanionConfig } = load(resolve("src/main/config/RemoteCompanionConfig.ts"));
const { keyPair, encode } = load(resolve("packages/tpa-remote/src/crypto.ts"));
const pair = keyPair(() => new Uint8Array(32).fill(7));
const config = { version: 1, enabled: false, relay: "wss://example.test/tpa-relay/v1", room: "c".repeat(32), hostToken: "a".repeat(64), phoneToken: "b".repeat(64), hostPublicKey: encode(pair.publicKey), hostSecretKey: encode(pair.secretKey) };
async function harness(fn) {
	const directory = await mkdtemp(join(tmpdir(), "tpa-config-"));
	const path = join(directory, "remote-companion.bin");
	try {
		await fn(path, new RemoteCompanionConfig(path));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
test("first setup seals a disabled configuration then removes its fixed private inbox", async () =>
	harness(async (path, store) => {
		assert.equal(await store.read(), undefined);
		await writeFile(`${path}.provision.json`, JSON.stringify(config));
		const value = await store.read();
		assert.equal(value.enabled, false);
		assert.equal(value.phone, undefined);
		assert((await readFile(path)).toString().startsWith("test-sealed:"));
		await assert.rejects(stat(`${path}.provision.json`), { code: "ENOENT" });
	}));
test("provisioning cannot grant a device or enable access without pairing", async () =>
	harness(async (path, store) => {
		await writeFile(`${path}.provision.json`, JSON.stringify({ ...config, enabled: true }));
		await assert.rejects(store.read(), /INVALID_PROVISIONING/);
		await assert.rejects(stat(path), { code: "ENOENT" });
	}));
test("an existing sealed configuration is never replaced by a new provisioning inbox", async () =>
	harness(async (path, store) => {
		await store.write(config);
		await writeFile(`${path}.provision.json`, JSON.stringify({ ...config, room: "d".repeat(32) }));
		assert.equal((await store.read()).room, config.room);
		assert((await stat(`${path}.provision.json`)).isFile());
	}));
