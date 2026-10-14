// pi-deck-cloud-memory-sync-sender 的针对性测试：成功回执、未知查询去重、网络恢复、401 恢复、
// 换账号拒绝、冲突不阻塞、stop/租约。真实临时 outbox + fake fetch，不联网、不起真实 pi。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");
const outbox = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts");
const senderModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-sender.ts");

const SCOPE = { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1" };
const CONNECTION = { enabled: true, syncEnabled: true, baseUrl: "https://cloud.test", token: "tok-1", accountId: "acct-1", cloudInstanceId: "cloud-1" };

function makeIdentity(overrides = {}) {
	return { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", sessionId: "sess-1", entryId: "entry-1", revision: 1, ...overrides };
}

function makeRecord(overrides = {}) {
	return identity.createSyncRecord({ identity: makeIdentity(overrides.identity), role: "user", content: overrides.content ?? "原话", occurredAt: "2026-10-13T12:00:00.000Z" });
}

function receiptFor(record, overrides = {}) {
	return { stored: true, accountId: record.identity.accountId, cloudInstanceId: record.identity.cloudInstanceId, sourceId: record.sourceId, revision: record.identity.revision, contentHash: record.contentHash, textSha256: record.textSha256, ...overrides };
}

function bodyOf(text) {
	const bytes = new TextEncoder().encode(text);
	let sent = false;
	return {
		read: async () => {
			if (sent) return { done: true };
			sent = true;
			return { done: false, value: bytes };
		},
		cancel: async () => {},
	};
}

function jsonResponse(status, payload) {
	return { ok: status >= 200 && status < 300, status, body: bodyOf(JSON.stringify(payload)) };
}

function emptyResponse(status) {
	return { ok: status >= 200 && status < 300, status, body: null };
}

async function waitFor(predicate, timeoutMs = 3000) {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withQueue(run) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-sender-"));
	try {
		const queue = await outbox.createSyncOutbox({ stateDir: join(root, "state") }).open(SCOPE);
		await run(queue, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

function makeSender(queue, options = {}) {
	return senderModule.createSyncSender({
		queue,
		scope: SCOPE,
		getConnection: options.getConnection ?? (() => CONNECTION),
		fetchImpl: options.fetcher,
		onStatus: options.onStatus,
		retryBaseMs: options.retryBaseMs ?? 5,
		retryMaxMs: options.retryMaxMs ?? 20,
		leaseTtlMs: 60_000,
	});
}

test("成功回执：POST 逐字段核对后清空待传，status 计数真实", async () => {
	await withQueue(async (queue) => {
		const first = makeRecord({ identity: { entryId: "e-1" } });
		const second = makeRecord({ identity: { entryId: "e-2" } });
		await queue.register(first);
		await queue.register(second);
		const calls = [];
		const fetcher = async (url, init) => {
			calls.push({ url, method: init.method, redirect: init.redirect });
			const body = JSON.parse(init.body);
			assert.match(body.request_id, /^req_[0-9a-f]{64}$/);
			assert.equal(body.records.length, 2);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 2 && sender.getStatus().pendingTotal === 0);
		const status = sender.getStatus();
		assert.equal(status.pendingBytes, 0);
		assert.equal(status.batchesSent, 1);
		assert.ok(status.lastReceiptAt, "核对通过才更新时间");
		assert.ok(status.hasLease);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "POST");
		assert.equal(calls[0].redirect, "error");
		assert.equal((await queue.listPending()).entries.length, 0);
		await sender.stop();
	});
});

test("未知结果：先查原 request_id 回执，查到就不重发", async () => {
	await withQueue(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const posts = [];
		const gets = [];
		const fetcher = async (url, init) => {
			if (init.method === "GET") {
				gets.push(url);
				return jsonResponse(200, { ok: true, request_id: posts[0], records: [receiptFor(record)] });
			}
			const body = JSON.parse(init.body);
			posts.push(body.request_id);
			throw new Error("network down");
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(posts.length, 1, "查询已确认则不重发");
		assert.equal(gets.length, 1);
		assert.ok(gets[0].endsWith(posts[0]), "查询使用原 request_id");
		assert.equal((await queue.listPending()).entries.length, 0);
		await sender.stop();
	});
});

test("未知结果：查询 404 后用相同 request_id 重发，不新建第二身份", async () => {
	await withQueue(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const posts = [];
		let gets = 0;
		const fetcher = async (url, init) => {
			if (init.method === "GET") {
				gets += 1;
				return emptyResponse(404);
			}
			const body = JSON.parse(init.body);
			posts.push(body.request_id);
			if (posts.length === 1) throw new Error("network down");
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(posts.length, 2);
		assert.equal(posts[0], posts[1], "重发沿用同一稳定 request_id");
		assert.equal(gets, 1);
		await sender.stop();
	});
});

test("网络恢复：失败期间记录保持 unknown，恢复后确认", async () => {
	await withQueue(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		let failures = 2;
		const fetcher = async (url, init) => {
			if (init.method === "GET") return emptyResponse(404);
			const body = JSON.parse(init.body);
			if (failures > 0) {
				failures -= 1;
				throw new Error("network down");
			}
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, retryBaseMs: 1000 });
		await sender.start();
		await waitFor(async () => (await queue.readEntry(record.sourceId))?.state === "unknown");
		assert.equal((await queue.readEntry(record.sourceId))?.state, "unknown", "未核对前不出队");
		sender.wake();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal((await queue.listPending()).entries.length, 0);
		await sender.stop();
	});
});

test("401 暂停：同 scope 新 token 才恢复；同 token 期间不再发", async () => {
	await withQueue(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		let token = "tok-1";
		let postAttempts = 0;
		const fetcher = async (url, init) => {
			if (init.method === "GET") return emptyResponse(404);
			postAttempts += 1;
			if (token === "tok-1") return emptyResponse(401);
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, getConnection: () => ({ ...CONNECTION, token }) });
		await sender.start();
		await waitFor(() => sender.getStatus().phase === "auth_blocked");
		await waitFor(() => queue.isAuthBlocked());
		const attemptsAfterPause = postAttempts;
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(postAttempts, attemptsAfterPause, "旧 token 不重试");
		token = "tok-2";
		sender.wake();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(await queue.isAuthBlocked(), false);
		await sender.stop();
	});
});

test("换账号：停旧 sender 不发新 token，队列保留", async () => {
	await withQueue(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		let connection = { ...CONNECTION, accountId: "acct-2", token: "tok-acc2" };
		let calls = 0;
		const fetcher = async (url, init) => {
			calls += 1;
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, getConnection: () => connection });
		await sender.start();
		await waitFor(() => sender.getStatus().phase === "scope_mismatch");
		assert.equal(calls, 0, "换账号不发新 token");
		assert.equal((await queue.listPending()).entries.length, 1);
		connection = { ...CONNECTION };
		sender.wake();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(calls, 1);
		await sender.stop();
	});
});

test("冲突保留并跳过：一条 mismatch 不阻塞同批与后续正常条", async () => {
	await withQueue(async (queue) => {
		const good = makeRecord({ identity: { entryId: "e-good" } });
		const bad = makeRecord({ identity: { entryId: "e-bad" } });
		await queue.register(good);
		await queue.register(bad);
		let posts = 0;
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			posts += 1;
			if (posts === 1) {
				return jsonResponse(200, {
					ok: true,
					request_id: body.request_id,
					records: body.records.map((entry) => (entry.sourceId === bad.sourceId ? receiptFor(entry, { contentHash: "0".repeat(64) }) : receiptFor(entry))),
				});
			}
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(async () => (await queue.readEntry(bad.sourceId))?.state === "conflict" && sender.getStatus().conflictCount >= 1);
		await waitFor(async () => (await queue.readEntry(good.sourceId)) === null && sender.getStatus().pendingTotal === 1);
		assert.equal(sender.getStatus().pendingTotal, 1, "冲突条计入积压，已确认条出队");
		const later = makeRecord({ identity: { entryId: "e-later" } });
		await queue.register(later);
		sender.wake();
		await waitFor(async () => (await queue.readEntry(later.sourceId)) === null);
		assert.equal((await queue.readEntry(bad.sourceId))?.state, "conflict", "冲突条仍保留");
		assert.equal(posts, 2, "冲突条不重发，也不阻塞新条");
		await sender.stop();
	});
});

test("stop/租约：活跃 owner 不抢；stop 取消失在途 HTTP 并按 token 释放，未核对记录保留", async () => {
	await withQueue(async (queue, root) => {
		const record = makeRecord();
		await queue.register(record);
		let aborted = false;
		let fetchStarted = false;
		const hangingFetch = (url, init) =>
			new Promise((resolve, reject) => {
				fetchStarted = true;
				init.signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		const sender = makeSender(queue, { fetcher: hangingFetch, retryBaseMs: 1000 });
		await sender.start();
		await waitFor(() => sender.getStatus().hasLease);
		await waitFor(() => fetchStarted, 2000);

		const queue2 = await outbox.createSyncOutbox({ stateDir: join(root, "state") }).open(SCOPE);
		let secondCalls = 0;
		const sender2 = senderModule.createSyncSender({
			queue: queue2,
			scope: SCOPE,
			getConnection: () => CONNECTION,
			fetchImpl: async (url, init) => {
				secondCalls += 1;
				const body = JSON.parse(init.body);
				return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
			},
			retryBaseMs: 5,
			retryMaxMs: 20,
		});
		await sender2.start();
		await waitFor(() => sender2.getStatus().phase === "owner_blocked");
		assert.equal(sender2.getStatus().hasLease, false, "活跃 owner 的租约不能被抢");
		assert.equal(secondCalls, 0);

		await sender.stop();
		assert.equal(aborted, true, "stop 取消自己的在途 HTTP");
		assert.equal(sender.getStatus().phase, "stopped");
		const entry = await queue.readEntry(record.sourceId);
		assert.equal(entry?.state, "unknown", "未核对记录保留");
		const claim = await queue2.claimSender(60_000);
		assert.equal(claim.status, "claimed", "stop 按 token 释放租约");
		await queue2.releaseSender(claim.lease.token);
		await sender2.stop();
	});
});
