import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const requireRemote = createRequire(resolve("packages/tpa-remote/package.json"));
const stubs = { tweetnacl: requireRemote("tweetnacl"), "base64-js": requireRemote("base64-js") };
const { RemoteCommandLedger } = loadTsCommonJs(resolve("src/main/remote/RemoteCommandLedger.ts"), { stubs });
const { parseRequest } = loadTsCommonJs(resolve("packages/tpa-remote/src/request.ts"), { stubs });

function command(patch = {}) {
	return { kind: "request", id: "command-1", challenge: "fresh", issuedAt: Date.now(), method: "session.send", sessionId: "session-1", text: "hello", target: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 }, ...patch };
}
async function harness(action) {
	const directory = await mkdtemp(join(tmpdir(), "tpa-remote-"));
	try {
		await action(join(directory, "receipts.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("remote commands reject expired challenges, timestamps and foreign runtimes", () => {
	for (const patch of [{ challenge: "old" }, { issuedAt: 0 }, { method: "terminal.exec" }, { text: " " }, { target: { sessionId: "other", agentId: "agent-1", runtimeGeneration: 1 } }]) assert.throws(() => parseRequest(command(patch), "fresh"));
	assert.equal(parseRequest(command(), "fresh").sessionId, "session-1");
});
test("concurrent retries dispatch once and detect conflicting payloads", async () =>
	harness(async (path) => {
		const ledger = new RemoteCommandLedger(path);
		await ledger.load();
		let calls = 0;
		const action = async () => {
			calls++;
			return { kind: "response", id: "command-1", ok: true };
		};
		const first = ledger.run(command(), action);
		const second = ledger.run(command(), action);
		assert.equal((await ledger.run(command({ text: "different" }), action)).error, "REQUEST_ID_CONFLICT");
		assert.equal((await first).ok, true);
		assert.equal((await second).ok, true);
		assert.equal(calls, 1);
	}));
test("restart returns the durable receipt without redispatching", async () =>
	harness(async (path) => {
		const original = new RemoteCommandLedger(path);
		await original.load();
		await original.run(command(), async () => ({ kind: "response", id: "command-1", ok: true }));
		const restored = new RemoteCommandLedger(path);
		await restored.load();
		let calls = 0;
		const response = await restored.run(command({ challenge: "new", issuedAt: Date.now() + 1 }), async () => {
			calls++;
			return { kind: "response", id: "command-1", ok: true };
		});
		assert.equal(response.ok, true);
		assert.equal(calls, 0);
	}));
test("crash after write-ahead receipt stays unknown and is never replayed", async () =>
	harness(async (path) => {
		const ledger = new RemoteCommandLedger(path);
		await ledger.load();
		await ledger.run(command(), async () => ({ kind: "response", id: "command-1", ok: true }));
		const disk = JSON.parse(await readFile(path, "utf8"));
		delete disk.entries[0][1].reply;
		disk.entries[0][1].state = "unknown";
		await writeFile(path, JSON.stringify(disk));
		const restored = new RemoteCommandLedger(path);
		await restored.load();
		const response = await restored.run(command(), async () => {
			throw new Error("must not dispatch");
		});
		assert.equal(response.error, "DELIVERY_UNKNOWN");
	}));
test("write-ahead persistence failure prevents dispatch", async () =>
	harness(async (path) => {
		const ledger = new RemoteCommandLedger(path);
		await ledger.load();
		await writeFile(join(path, "..", "blocking"), "file");
		const broken = new RemoteCommandLedger(join(path, "..", "blocking", "receipts.json"));
		// A not-ready or unreadable ledger fails closed before any domain command.
		let calls = 0;
		await assert.rejects(
			broken.run(command(), async () => {
				calls++;
				return { kind: "response", id: "command-1", ok: true };
			}),
		);
		assert.equal(calls, 0);
	}));
test("new-session and scheduled-task receipts bind all creation fields", async () =>
	harness(async (path) => {
		const ledger = new RemoteCommandLedger(path);
		await ledger.load();
		const request = command({ method: "session.create", projectId: "project", text: "first prompt" });
		await ledger.run(request, async () => ({ kind: "response", id: request.id, ok: true, result: { sessionId: "created" } }));
		assert.equal(
			(
				await ledger.run({ ...request, projectId: "other" }, async () => {
					throw new Error("must not execute");
				})
			).error,
			"REQUEST_ID_CONFLICT",
		);
		assert.equal(ledger.status(request.id).reply.result.sessionId, "created");
		assert.equal(ledger.status("missing").state, "missing");
	}));
test("an unacknowledged result survives receipt aging and is never mistaken for an unreceived command", async () =>
	harness(async (path) => {
		const original = new RemoteCommandLedger(path);
		await original.load();
		await original.run(command(), async () => ({ kind: "response", id: "command-1", ok: true }));
		const disk = JSON.parse(await readFile(path, "utf8"));
		disk.entries[0][1].at = 0;
		await writeFile(path, JSON.stringify(disk));
		const restored = new RemoteCommandLedger(path);
		await restored.load();
		await restored.run(command({ id: "new-command" }), async () => ({ kind: "response", id: "new-command", ok: true }));
		assert.equal(restored.status("command-1").state, "done");
		await restored.run(command(), async () => {
			assert.fail("must not execute the aged command again");
		});
	}));
test("only durably acknowledged known results are eligible for bounded cleanup", async () =>
	harness(async (path) => {
		const ledger = new RemoteCommandLedger(path);
		await ledger.load();
		await ledger.run(command(), async () => ({ kind: "response", id: "command-1", ok: true }));
		await ledger.acknowledge("command-1");
		await ledger.run(command({ id: "uncertain" }), async () => ({ kind: "response", id: "uncertain", ok: false, error: "DELIVERY_UNKNOWN" }));
		await ledger.acknowledge("uncertain");
		const disk = JSON.parse(await readFile(path, "utf8"));
		for (const [, value] of disk.entries) value.at = 0;
		await writeFile(path, JSON.stringify(disk));
		const restored = new RemoteCommandLedger(path);
		await restored.load();
		await restored.run(command({ id: "new-command" }), async () => ({ kind: "response", id: "new-command", ok: true }));
		assert.equal(restored.status("command-1").state, "missing");
		assert.equal(restored.status("uncertain").state, "done");
	}));
