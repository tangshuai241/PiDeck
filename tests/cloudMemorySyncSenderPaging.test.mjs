// pi-deck-cloud-memory-sync-sender 的资源侧测试：listPending 分页/字节预算、countPending 计数、
// sender 20 条与 512KiB 组包、48KiB inline 单条上限（超限等待 chunk，不丢弃）。真实临时 outbox + fake fetch。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");
const outbox = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts");
const senderModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-sender.ts");
const transport = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-transport.ts");

const SCOPE = { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1" };
const CONNECTION = { enabled: true, syncEnabled: true, baseUrl: "https://cloud.test", token: "tok-1", accountId: "acct-1", cloudInstanceId: "cloud-1" };

function makeIdentity(overrides = {}) {
	return { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", sessionId: "sess-1", entryId: "entry-1", revision: 1, ...overrides };
}

function makeRecord(overrides = {}) {
	return identity.createSyncRecord({ identity: makeIdentity(overrides.identity), role: "user", content: overrides.content ?? "原话", occurredAt: "2026-10-13T12:00:00.000Z" });
}

function receiptFor(record) {
	return { stored: true, accountId: record.identity.accountId, cloudInstanceId: record.identity.cloudInstanceId, sourceId: record.sourceId, revision: record.identity.revision, contentHash: record.contentHash, textSha256: record.textSha256 };
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

async function waitFor(predicate, timeoutMs = 5000) {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withQueue(run) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-paging-"));
	try {
		const queue = await outbox.createSyncOutbox({ stateDir: join(root, "state") }).open(SCOPE);
		await run(queue, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

test("listPending：默认最多 100 条并可游标翻页；countPending 读元信息统计总数", async () => {
	await withQueue(async (queue) => {
		for (let index = 0; index < 120; index += 1) {
			await queue.register(makeRecord({ identity: { entryId: `e-${String(index).padStart(3, "0")}`, revision: 1 } }));
		}
		const counts = await queue.countPending();
		assert.equal(counts.count, 120, "计数不把一页长度当总积压数");
		assert.ok(counts.bytes > 0);
		const first = await queue.listPending();
		assert.equal(first.entries.length, 100);
		assert.equal(first.hasMore, true);
		assert.ok(first.nextCursor);
		assert.equal(first.scanned, 100);
		const second = await queue.listPending({ cursor: first.nextCursor });
		assert.equal(second.entries.length, 20);
		assert.equal(second.hasMore, false);
		const ids = new Set([...first.entries, ...second.entries].map((entry) => entry.record.sourceId));
		assert.equal(ids.size, 120, "两页覆盖全部条目且不重复");
		assert.equal(first.invalid.length + second.invalid.length, 0);
	});
});

test("listPending：maxBytes 按文件字节预算截断，临时文件不计数", async () => {
	await withQueue(async (queue) => {
		for (let index = 0; index < 5; index += 1) {
			await queue.register(makeRecord({ identity: { entryId: `e-${index}` }, content: "x".repeat(2000) }));
		}
		await fs.writeFile(join(queue.dir, "pending", ".tmp-unfinished"), "half written", "utf8");
		const firstPage = await queue.listPending({ maxBytes: 1 }); // 至少返回第一条，之后按预算停止
		const firstSize = (await fs.stat(join(queue.dir, "pending", `${firstPage.entries[0].record.sourceId}.json`))).size;
		assert.equal(firstPage.entries.length, 1, "第一条总是返回，后续超预算即停");
		assert.equal(firstPage.hasMore, true);
		const page = await queue.listPending({ maxBytes: firstSize * 2 });
		assert.equal(page.entries.length, 2, "第一条 + 预算内可容纳的第二条；第三条超预算");
		assert.equal(page.hasMore, true);
		let total = 0;
		for (const entry of page.entries) {
			const info = await fs.stat(join(queue.dir, "pending", `${entry.record.sourceId}.json`));
			total += info.size;
		}
		assert.ok(total <= firstSize * 2, `本页文件字节 ${total} 不得超过预算`);
		const counts = await queue.countPending();
		assert.equal(counts.count, 5, "临时文件不计入积压");
		await assert.rejects(queue.listPending({ limit: 0 }), (error) => error.code === "invalid_input");
		await assert.rejects(queue.listPending({ cursor: "../../etc" }), (error) => error.code === "invalid_input");
	});
});

test("sender 组包：每批最多 20 条且正文 ≤512KiB", async () => {
	await withQueue(async (queue) => {
		for (let index = 0; index < 25; index += 1) {
			await queue.register(makeRecord({ identity: { entryId: `e-${index}` } }));
		}
		const batches = [];
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			batches.push({ count: body.records.length, bytes: Buffer.byteLength(init.body, "utf8") });
			return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
		};
		const sender = senderModule.createSyncSender({ queue, scope: SCOPE, getConnection: () => CONNECTION, fetchImpl: fetcher, retryBaseMs: 5, retryMaxMs: 20 });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 25 && sender.getStatus().pendingTotal === 0);
		assert.ok(batches.length >= 2);
		for (const batch of batches) {
			assert.ok(batch.count <= 20, `单批 ${batch.count} 条超过 20`);
			assert.ok(batch.bytes <= transport.MAX_BATCH_BYTES, `单批正文 ${batch.bytes} 字节超过 ${transport.MAX_BATCH_BYTES}`);
		}
		assert.equal(sender.getStatus().batchesSent, batches.length);
		assert.equal(sender.getStatus().pendingTotal, 0);
		await sender.stop();
	});
});

test("inline 单条上限 48KiB：超限条目不进 inline 包，转入 chunk 队列", async () => {
	await withQueue(async (queue) => {
		const big = makeRecord({ identity: { entryId: "e-big" }, content: "x".repeat(60 * 1024) });
		const small = makeRecord({ identity: { entryId: "e-small" } });
		assert.ok(transport.estimateRecordBytes(big) > transport.MAX_INLINE_RECORD_BYTES);
		await queue.register(big);
		await queue.register(small);
		const sentRecords = [];
		const fetcher = async (url, init) => {
			if (init.method === "POST" && url.endsWith("/api/cloud/conversation-imports")) {
				const body = JSON.parse(init.body);
				for (const record of body.records) sentRecords.push(record.sourceId);
				return jsonResponse(200, { ok: true, request_id: body.request_id, records: body.records.map((record) => receiptFor(record)) });
			}
			return jsonResponse(404, { ok: false });
		};
		const sender = senderModule.createSyncSender({ queue, scope: SCOPE, getConnection: () => CONNECTION, fetchImpl: fetcher, retryBaseMs: 5, retryMaxMs: 20 });
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.deepEqual(Array.from(sentRecords), [small.sourceId], "超限条目不进入 inline 包");
		assert.ok(sender.getStatus().oversizedCount >= 1, "长记录已登记待 chunk");
		assert.equal(sender.getStatus().oversized[0].sourceId, big.sourceId);
		await sender.stop();
	});
});
