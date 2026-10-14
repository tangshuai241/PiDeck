// pi-deck-cloud-memory-sync-sender 恢复/冲突/租约/调度缺陷的针对性测试（真临时 queue + fake fetch）。
// 覆盖：未知回执部分确认后继续、disabled/idle 慢轮询自恢复、envelope 原 requestId 恢复、
// 409 有/无 sourceIds、stored=false 退避、重启 auth 指纹、stop 竞态、扫描游标、计数错误如实上抛。
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

async function waitFor(predicate, timeoutMs = 4000) {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withState(run) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-rec-"));
	try {
		const stateDir = join(root, "state");
		const factory = outbox.createSyncOutbox({ stateDir });
		await run(await factory.open(SCOPE), factory, stateDir);
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
		retryBaseMs: options.retryBaseMs ?? 5,
		retryMaxMs: options.retryMaxMs ?? 20,
		retrySlowPollMs: options.retrySlowPollMs ?? 10,
		maxBatchRecords: options.maxBatchRecords,
		leaseTtlMs: 60_000,
	});
}

test("未知回执只确认部分条目时必须继续发送剩余，而不是 handled 停摆", async () => {
	await withState(async (queue) => {
		const first = makeRecord({ identity: { entryId: "e-a" } });
		const second = makeRecord({ identity: { entryId: "e-b" } });
		await queue.register(first);
		await queue.register(second);
		let postedId = null;
		let gets = 0;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				postedId = JSON.parse(init.body).request_id;
				throw new Error("network down");
			}
			gets += 1;
			const records = gets === 1 ? [receiptFor(first)] : [receiptFor(second)];
			return jsonResponse(200, { ok: true, request_id: postedId, records });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 2);
		assert.equal(await queue.readEntry(first.sourceId), null);
		assert.equal(await queue.readEntry(second.sourceId), null);
		assert.equal(gets, 2);
		assert.equal((await queue.readOpenBatch()) === null, true, "全部结算后 envelope 清除");
		await sender.stop();
	});
});

test("disabled 状态有慢轮询：恢复 enabled 后无需 wake 也会发送", async () => {
	await withState(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		let enabled = false;
		let posts = 0;
		const fetcher = async (url, init) => {
			posts += 1;
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, getConnection: () => ({ ...CONNECTION, enabled }) });
		await sender.start();
		await waitFor(() => sender.getStatus().phase === "disabled");
		enabled = true;
		await waitFor(() => sender.getStatus().confirmedCount === 1, 2000);
		assert.equal(posts, 1);
		await sender.stop();
	});
});

test("idle 状态有慢轮询：之后新增队列无需 wake 也会发送", async () => {
	await withState(async (queue) => {
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().phase === "idle");
		await queue.register(makeRecord());
		await waitFor(() => sender.getStatus().confirmedCount === 1, 2000);
		await sender.stop();
	});
});

test("重启恢复按 envelope 原 requestId 与原集合；期间新增条目不改变原请求", async () => {
	await withState(async (queue) => {
		const first = makeRecord({ identity: { entryId: "e-a" } });
		await queue.register(first);
		let postedId = null;
		let getUrl = null;
		const fetcher = async (url, init) => {
			if (init.method === "POST") {
				const body = JSON.parse(init.body);
				postedId = body.request_id;
				throw new Error("network down");
			}
			getUrl = url;
			return jsonResponse(200, { ok: true, request_id: postedId, records: [receiptFor(first)] });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(async () => (await queue.readOpenBatch()) !== null && postedId !== null);
		const envelope = await queue.readOpenBatch();
		assert.equal(envelope.requestId, postedId, "发送前已落盘原 requestId");
		assert.deepEqual(
			Array.from(envelope.items, (item) => item.sourceId),
			[first.sourceId],
		);
		// 恢复前新增条目：不得改变原批次集合/请求号
		const added = makeRecord({ identity: { entryId: "e-new" } });
		await queue.register(added);
		await waitFor(async () => (await queue.readEntry(first.sourceId)) === null);
		assert.ok(getUrl.endsWith(postedId), "按原 requestId 查询");
		assert.equal(postedId, envelope.requestId);
		await sender.stop();
	});
});

test("unknown 查询 404 时用原 requestId 重发原集合，不重新组批", async () => {
	await withState(async (queue) => {
		const first = makeRecord({ identity: { entryId: "e-a" } });
		await queue.register(first);
		const posts = [];
		const fetcher = async (url, init) => {
			if (init.method === "GET") return emptyResponse(404);
			const body = JSON.parse(init.body);
			posts.push({ requestId: body.request_id, sourceIds: body.records.map((record) => record.sourceId) });
			if (posts.length === 1) throw new Error("network down");
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		await sender.stop();
		assert.ok(posts.length >= 2);
		assert.equal(posts[1].requestId, posts[0].requestId, "404 后沿用同一 requestId");
		assert.deepEqual(posts[1].sourceIds, [first.sourceId], "重发原集合而非新组批");
	});
});

test("409 带 sourceIds：只把该条标冲突，其余正常条继续", async () => {
	await withState(async (queue) => {
		const bad = makeRecord({ identity: { entryId: "e-bad" } });
		const good = makeRecord({ identity: { entryId: "e-good" } });
		await queue.register(bad);
		await queue.register(good);
		let posts = 0;
		const fetcher = async (url, init) => {
			if (init.method === "GET") return emptyResponse(404);
			posts += 1;
			const body = JSON.parse(init.body);
			if (posts === 1) return jsonResponse(409, { ok: false, source_ids: [bad.sourceId] });
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(async () => (await queue.readEntry(good.sourceId)) === null);
		assert.equal((await queue.readEntry(bad.sourceId))?.state, "conflict", "仅冲突条被标记");
		assert.equal(posts, 2, "其余条目在后续批次发出");
		await sender.stop();
	});
});

test("409 无 sourceIds：拆单条定位，不把整批合法条目判冲突", async () => {
	await withState(async (queue) => {
		const bad = makeRecord({ identity: { entryId: "e-bad" } });
		const good = makeRecord({ identity: { entryId: "e-good" } });
		await queue.register(bad);
		await queue.register(good);
		const posts = [];
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			const ids = body.records.map((record) => record.sourceId);
			posts.push({ count: ids.length, ids });
			if (ids.includes(bad.sourceId)) return jsonResponse(409, { ok: false });
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
		};
		const sender = makeSender(queue, { fetcher });
		await sender.start();
		await waitFor(async () => (await queue.readEntry(good.sourceId)) === null);
		assert.equal((await queue.readEntry(bad.sourceId))?.state, "conflict", "定位到单条冲突");
		assert.ok(
			posts.some((post) => post.count === 1),
			"无列表时拆单条",
		);
		await sender.stop();
	});
});

test("stored=false：保留原件并退避，不热循环也不阻塞已确认条", async () => {
	await withState(async (queue) => {
		const ok = makeRecord({ identity: { entryId: "e-ok" } });
		const failing = makeRecord({ identity: { entryId: "e-store-false" } });
		await queue.register(ok);
		await queue.register(failing);
		let posts = 0;
		const fetcher = async (url, init) => {
			if (init.method === "GET") return emptyResponse(404);
			posts += 1;
			const body = JSON.parse(init.body);
			return jsonResponse(200, {
				ok: true,
				request_id: body.request_id,
				records: body.records.map((record) => (record.sourceId === failing.sourceId ? receiptFor(record, { stored: false }) : receiptFor(record))),
			});
		};
		const sender = makeSender(queue, { fetcher, retryBaseMs: 5000, retryMaxMs: 5000 });
		await sender.start();
		await waitFor(async () => (await queue.readEntry(ok.sourceId)) === null);
		await sleep(60);
		assert.ok(posts <= 3, `stored=false 不得热循环（posts=${posts}）`);
		assert.ok((await queue.readEntry(failing.sourceId)) !== null, "stored=false 保留待传副本");
		assert.ok(sender.getStatus().notStoredCount >= 1);
		await sender.stop();
	});
});

test("重启 auth：同 token 指纹保持暂停，同 scope 新 token 才恢复", async () => {
	await withState(async (queue, factory, stateDir) => {
		const record = makeRecord();
		await queue.register(record);
		let token = "tok-1";
		let firstCalls = 0;
		const first = makeSender(queue, {
			fetcher: async () => {
				firstCalls += 1;
				return emptyResponse(401);
			},
			getConnection: () => ({ ...CONNECTION, token }),
		});
		await first.start();
		await waitFor(() => first.getStatus().phase === "auth_blocked");
		await first.stop();
		assert.equal(firstCalls, 1);
		const state = await queue.getAuthState();
		assert.equal(state.blocked, true);
		assert.ok(state.tokenHash && state.tokenHash !== token, "只存 hash 指纹，不存明文");

		const queue2 = await factory.open(SCOPE);
		let restartedCalls = 0;
		const restarted = senderModule.createSyncSender({
			queue: queue2,
			scope: SCOPE,
			getConnection: () => ({ ...CONNECTION, token }),
			fetchImpl: async (url, init) => {
				restartedCalls += 1;
				if (token === "tok-1") return emptyResponse(401);
				if (init.method === "GET") return emptyResponse(404);
				const body = JSON.parse(init.body);
				return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
			},
			retryBaseMs: 5,
			retryMaxMs: 20,
			retrySlowPollMs: 10,
		});
		await restarted.start();
		await waitFor(() => restarted.getStatus().phase === "auth_blocked");
		await sleep(40);
		assert.equal(restartedCalls, 0, "重启后同 token 不发送");
		token = "tok-2";
		restarted.wake();
		await waitFor(() => restarted.getStatus().confirmedCount === 1);
		assert.ok(restartedCalls >= 1);
		assert.equal(await queue2.isAuthBlocked(), false);
		await restarted.stop();
	});
});

test("getConnection 支持异步快照：await 后使用当前 token 发送", async () => {
	await withState(async (queue) => {
		await queue.register(makeRecord());
		let calls = 0;
		const fetcher = async (url, init) => {
			calls += 1;
			assert.equal(init.headers.authorization, "Bearer tok-async");
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, getConnection: async () => ({ ...CONNECTION, token: "tok-async" }) });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(calls, 1);
		await sender.stop();
	});
});

test("stop 在 claim await 期间：不产生 HTTP，且刚拿到的租约立即释放", async () => {
	await withState(async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const slowQueue = {
			...queue,
			claimSender: async (ttl) => {
				await sleep(40);
				return await queue.claimSender(ttl);
			},
		};
		let calls = 0;
		const sender = makeSender(slowQueue, {
			fetcher: async () => {
				calls += 1;
				return emptyResponse(500);
			},
		});
		await sender.start();
		await sleep(10);
		await sender.stop();
		await sleep(70);
		assert.equal(calls, 0, "stop 后不得再开 HTTP");
		const claim = await queue.claimSender(60_000);
		assert.equal(claim.status, "claimed", "stop 竞态留下的租约已释放");
		await queue.releaseSender(claim.lease.token);
	});
});

test("扫描游标跨 tick：前部冲突/超大不饿死后面的正常条", async () => {
	await withState(async (queue) => {
		for (let index = 0; index < 6; index += 1) {
			const blocked = makeRecord({ identity: { entryId: `e-conflict-${index}` } });
			await queue.register(blocked);
			await queue.markConflict(blocked.sourceId, "server_409");
		}
		const normal = [makeRecord({ identity: { entryId: "e-n1" } }), makeRecord({ identity: { entryId: "e-n2" } })];
		for (const record of normal) await queue.register(record);
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((entry) => receiptFor(entry)) });
		};
		const sender = makeSender(queue, { fetcher, maxBatchRecords: 2 });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 2);
		for (const record of normal) assert.equal(await queue.readEntry(record.sourceId), null);
		await sender.stop();
	});
});

test("listPending 扫描上界含 invalid；countPending 的 readdir 错误如实上抛且状态置 unknown", async () => {
	await withState(async (queue) => {
		for (let index = 0; index < 3; index += 1) await queue.register(makeRecord({ identity: { entryId: `e-${index}` } }));
		const names = await fs.readdir(join(queue.dir, "pending"));
		await fs.writeFile(join(queue.dir, "pending", names[0]), "{broken", "utf8");
		const page = await queue.listPending({ limit: 10, maxScan: 1 });
		assert.equal(page.scanned, 1, "扫描上界限制的是扫描文件数");
		assert.ok(page.hasMore);
		assert.ok(page.nextCursor, "nextCursor 指向已扫描文件");
		let cursor = page.nextCursor;
		let guard = 0;
		while (cursor && guard < 10) {
			const nextPage = await queue.listPending({ limit: 10, maxScan: 1, cursor });
			cursor = nextPage.nextCursor;
			guard += 1;
		}
		assert.ok(guard < 10, "游标单调前进，不会原地打转");
	});
});

test("countPending readdir 失败不得冒充 0：sender 状态 pendingTotal=null + 错误字段", async () => {
	const realFs = await import("node:fs");
	const fsStub = {
		constants: realFs.constants,
		promises: new Proxy(realFs.promises, {
			get(target, prop) {
				if (prop === "readdir") {
					return async () => {
						const error = new Error("permission denied");
						error.code = "EACCES";
						throw error;
					};
				}
				const value = target[prop];
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
	const outboxStub = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts", { stubs: { "node:fs": fsStub } });
	const senderStub = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-sender.ts", { stubs: { "node:fs": fsStub } });
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-count-"));
	try {
		const queue = await outboxStub.createSyncOutbox({ stateDir: join(root, "state") }).open(SCOPE);
		await assert.rejects(queue.countPending(), (error) => error.code === "EACCES");
		const sender = senderStub.createSyncSender({ queue, scope: SCOPE, getConnection: () => CONNECTION, fetchImpl: async () => emptyResponse(500), retryBaseMs: 1000, retryMaxMs: 1000, retrySlowPollMs: 1000 });
		await sender.start();
		await waitFor(() => sender.getStatus().pendingCountError === "queue_count_failed");
		assert.equal(sender.getStatus().pendingTotal, null, "计数失败不冒充 0");
		await sender.stop();
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
});
