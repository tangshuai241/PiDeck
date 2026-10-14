// pi-deck-cloud-memory-sync-sender 长记录（chunk）协议针对性测试：完整链路、断点续传、单条冲突、
// 以及队列 16MiB envelope 上限的如实拒绝。真实临时 queue + fake fetch，不联网。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");
const outbox = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts");
const senderModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-sender.ts");
const batch = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-batch.ts");
const transport = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-transport.ts");

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

async function waitFor(predicate, timeoutMs = 5000) {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withState(run, options = {}) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-chunk-"));
	try {
		const queue = await outbox.createSyncOutbox({ stateDir: join(root, "state"), ...options }).open(SCOPE);
		await run(queue, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

function makeSender(queue, fetcher) {
	return senderModule.createSyncSender({ queue, scope: SCOPE, getConnection: () => CONNECTION, fetchImpl: fetcher, retryBaseMs: 5, retryMaxMs: 20, retrySlowPollMs: 10 });
}

function isMainReceiptGet(url, method) {
	return method === "GET" && url.includes("/api/cloud/conversation-imports/") && !url.includes("conversation-import-chunks");
}

function isChunkStatusGet(url, method) {
	return method === "GET" && url.includes("/api/cloud/conversation-import-chunks/");
}

test("长记录 chunk 完整链路：init → 逐片 PUT → complete → 逐字段回执确认", async () => {
	await withState(async (queue) => {
		const record = makeRecord({ identity: { entryId: "e-long" }, content: "x".repeat(60 * 1024) });
		assert.ok(transport.estimateRecordBytes(record) > transport.MAX_INLINE_RECORD_BYTES);
		await queue.register(record);
		const payload = batch.buildRecordPayload(record);
		const expectedChunks = batch.chunkCountFor(payload.byteLength);
		assert.ok(expectedChunks >= 2, "测试样本必须多片");
		const puts = [];
		let initBody = null;
		const fetcher = async (url, init) => {
			if (isMainReceiptGet(url, init.method)) return emptyResponse(404);
			if (isChunkStatusGet(url, init.method)) return emptyResponse(404);
			if (init.method === "POST" && url.endsWith("/api/cloud/conversation-import-chunks")) {
				initBody = JSON.parse(init.body);
				return jsonResponse(200, { ok: true });
			}
			if (init.method === "PUT") {
				puts.push({ index: Number(url.slice(url.lastIndexOf("/") + 1)), body: JSON.parse(init.body) });
				return jsonResponse(200, { ok: true });
			}
			if (init.method === "POST" && url.endsWith("/complete")) return jsonResponse(200, { ok: true, receipt: receiptFor(record) });
			return emptyResponse(500);
		};
		const sender = makeSender(queue, fetcher);
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1 && sender.getStatus().chunkCount === 1);
		assert.equal(await queue.readEntry(record.sourceId), null);
		assert.equal(initBody.totalBytes, payload.byteLength);
		assert.equal(initBody.chunkCount, expectedChunks);
		assert.equal(initBody.recordSha256.length, 64);
		assert.equal(puts.length, expectedChunks, "逐片上传");
		assert.deepEqual(
			puts.map((put) => put.index),
			Array.from({ length: expectedChunks }, (_, index) => index),
		);
		const reassembled = Buffer.concat(puts.map((put) => Buffer.from(put.body.data_base64, "base64")));
		assert.deepEqual(Array.from(reassembled), Array.from(payload), "分片重组与原始 payload 一致");
		assert.equal(sender.getStatus().chunkCount, 1);
		assert.equal(await queue.readOpenBatch(), null, "完成后 envelope 清除");
		await sender.stop();
	});
});

test("chunk 续传：GET 状态跳过已收片，只补缺片，不重复生成来源", async () => {
	await withState(async (queue) => {
		const record = makeRecord({ identity: { entryId: "e-resume" }, content: "y".repeat(60 * 1024) });
		await queue.register(record);
		const requestId = transport.requestIdForBatch([record]);
		// 模拟上一轮已 init 且第 0 片已收：envelope 落盘 + 条目 unknown。
		await queue.beginBatch({ requestId, mode: "chunk", items: [{ sourceId: record.sourceId, contentHash: record.contentHash, revision: 1 }] });
		await queue.markUnknown(record.sourceId, { reason: "send_started" });
		const payload = batch.buildRecordPayload(record);
		const chunkCount = batch.chunkCountFor(payload.byteLength);
		const puts = [];
		const fetcher = async (url, init) => {
			if (isMainReceiptGet(url, init.method)) return emptyResponse(404);
			if (isChunkStatusGet(url, init.method)) return jsonResponse(200, { ok: true, received: [0], completed: false });
			if (init.method === "PUT") {
				puts.push(Number(url.slice(url.lastIndexOf("/") + 1)));
				return jsonResponse(200, { ok: true });
			}
			if (init.method === "POST" && url.endsWith("/complete")) return jsonResponse(200, { ok: true, receipt: receiptFor(record) });
			return emptyResponse(500);
		};
		const sender = makeSender(queue, fetcher);
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(await queue.readEntry(record.sourceId), null);
		assert.deepEqual(
			puts,
			Array.from({ length: chunkCount - 1 }, (_, index) => index + 1),
			"只补缺片",
		);
		await sender.stop();
	});
});

test("chunk 单条 409：标该条冲突并跳过，不重试死循环", async () => {
	await withState(async (queue) => {
		const record = makeRecord({ identity: { entryId: "e-conflict" }, content: "z".repeat(60 * 1024) });
		await queue.register(record);
		let puts = 0;
		const fetcher = async (url, init) => {
			if (isMainReceiptGet(url, init.method)) return emptyResponse(404);
			if (isChunkStatusGet(url, init.method)) return emptyResponse(404);
			if (init.method === "POST" && url.endsWith("/api/cloud/conversation-import-chunks")) return jsonResponse(200, { ok: true });
			if (init.method === "PUT") {
				puts += 1;
				return jsonResponse(409, { ok: false, source_ids: [record.sourceId] });
			}
			return emptyResponse(500);
		};
		const sender = makeSender(queue, fetcher);
		await sender.start();
		await waitFor(async () => (await queue.readEntry(record.sourceId))?.state === "conflict");
		await sleep(30);
		assert.equal(puts, 1, "409 后不重试该条");
		assert.equal(await queue.readOpenBatch(), null);
		await sender.stop();
	});
});

test("chunk complete 返回 ALREADY_COMPLETED：取回执确认，不标内容冲突", async () => {
	await withState(async (queue) => {
		const record = makeRecord({ identity: { entryId: "e-already" }, content: "w".repeat(60 * 1024) });
		await queue.register(record);
		const requestId = transport.requestIdForBatch([record]);
		const fetcher = async (url, init) => {
			if (isMainReceiptGet(url, init.method)) return jsonResponse(200, { ok: true, request_id: requestId, records: [receiptFor(record)] });
			if (isChunkStatusGet(url, init.method)) return jsonResponse(200, { ok: true, request_id: requestId, received: [0, 1], missing: [], completed: false, receipt: null });
			if (init.method === "POST" && url.endsWith("/complete")) return jsonResponse(409, { ok: false, code: "ALREADY_COMPLETED" });
			return emptyResponse(500);
		};
		const sender = makeSender(queue, fetcher);
		await sender.start();
		await waitFor(() => sender.getStatus().confirmedCount === 1);
		assert.equal(await queue.readEntry(record.sourceId), null, "已完成后取回执确认");
		assert.equal(sender.getStatus().conflictCount, 0);
		await sender.stop();
	});
});

test("chunk complete 返回 UPLOAD_INCOMPLETE：保留 unknown 退避，不标冲突", async () => {
	await withState(async (queue) => {
		const record = makeRecord({ identity: { entryId: "e-incomplete" }, content: "v".repeat(60 * 1024) });
		await queue.register(record);
		const fetcher = async (url, init) => {
			if (isChunkStatusGet(url, init.method)) return emptyResponse(404);
			if (init.method === "POST" && url.endsWith("/api/cloud/conversation-import-chunks")) return jsonResponse(200, { ok: true });
			if (init.method === "PUT") return jsonResponse(200, { ok: true, duplicate: false, completed: false });
			if (init.method === "POST" && url.endsWith("/complete")) return jsonResponse(409, { ok: false, code: "UPLOAD_INCOMPLETE" });
			return emptyResponse(500);
		};
		const sender = makeSender(queue, fetcher);
		await sender.start();
		await waitFor(() => sender.getStatus().lastError === "chunk_incomplete");
		await sleep(20);
		const entry = await queue.readEntry(record.sourceId);
		assert.equal(entry?.state, "unknown", "缺块不是内容冲突，保留重试");
		assert.equal(entry?.state === "conflict", false);
		await sender.stop();
	});
});

test("队列 16MiB envelope 上限：超限登记如实拒绝；已存在超大文件保留为 invalid 证据", async () => {
	await withState(
		async (queue) => {
			const oversized = makeRecord({ identity: { entryId: "e-queue-limit" }, content: "q".repeat(4 * 1024) });
			await assert.rejects(queue.register(oversized), (error) => error.code === "entry_too_large");
			assert.equal((await queue.listPending()).entries.length, 0, "拒绝后不落盘");
			// 手工放入一个超过 maxEntryBytes 的文件：list 如实报 too_large 并保留字节。
			const file = join(queue.dir, "pending", `${identity.buildSourceId(makeIdentity({ entryId: "e-existing" }))}.json`);
			const garbage = `{"big":"${"b".repeat(4 * 1024)}"}`;
			await fs.writeFile(file, garbage, "utf8");
			const listed = await queue.listPending();
			assert.equal(listed.entries.length, 0);
			assert.equal(listed.invalid[0].reason, "too_large");
			assert.equal(await fs.readFile(file, "utf8"), garbage);
		},
		{ maxEntryBytes: 1024 },
	);
});
