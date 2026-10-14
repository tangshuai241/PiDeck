// pi-deck-cloud-memory-sync-outbox 的针对性测试：登记幂等/冲突、重启、写失败与损坏证据、
// 逐字段回执核对、跨账号拒绝、认证暂停与路径安全。只走本地文件系统，不联网、不起真实 pi。
import assert from "node:assert/strict";
import { constants as fsConstants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");
const outbox = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts");

const SCOPE = { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1" };

/** 用 node:fs 替身让 link 报 ENOTSUP，验证不支持原子硬链接的文件系统上的失败语义。 */
function loadOutboxOnNoLinkFs() {
	const fsStub = {
		constants: fsConstants,
		promises: new Proxy(fs, {
			get(target, prop) {
				if (prop === "link") {
					return async () => {
						const error = new Error("hard link unsupported");
						error.code = "ENOTSUP";
						throw error;
					};
				}
				const value = target[prop];
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
	return loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts", { stubs: { "node:fs": fsStub } });
}

function makeIdentity(overrides = {}) {
	return { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", sessionId: "sess-1", entryId: "entry-1", revision: 1, ...overrides };
}

function makeRecord(overrides = {}) {
	return identity.createSyncRecord({ identity: makeIdentity(overrides.identity), role: overrides.role ?? "user", content: overrides.content ?? "第一行\n第二行", occurredAt: overrides.occurredAt ?? "2026-10-13T12:00:00.000Z", project: overrides.project ?? "TPA", ...overrides.extra });
}

function makeReceipt(record, overrides = {}) {
	return { stored: true, accountId: record.identity.accountId, cloudInstanceId: record.identity.cloudInstanceId, sourceId: record.sourceId, revision: record.identity.revision, contentHash: record.contentHash, textSha256: record.textSha256, ...overrides };
}

async function withQueue(setup, run) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-outbox-"));
	try {
		const stateDir = join(root, "state");
		const factory = outbox.createSyncOutbox({ stateDir, ...setup });
		const queue = await factory.open(SCOPE);
		await run(queue, factory, stateDir, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

test("register：同身份同内容幂等；异内容保留待传原件并把新内容存冲突证据", async () => {
	await withQueue({}, async (queue) => {
		const first = makeRecord();
		const queued = await queue.register(first);
		assert.equal(queued.status, "queued");
		assert.equal(queued.entry.state, "pending");

		const duplicate = await queue.register(first);
		assert.equal(duplicate.status, "duplicate");
		assert.equal(duplicate.existing, "pending");
		assert.equal(duplicate.entry.record.sourceId, first.sourceId);

		const divergent = makeRecord({ content: "不同内容" });
		assert.equal(divergent.sourceId, first.sourceId, "同身份同 revision");
		assert.notEqual(divergent.contentHash, first.contentHash, "内容哈希不同");
		const conflict = await queue.register(divergent);
		assert.equal(conflict.status, "conflict");
		assert.equal(conflict.existing, "pending");
		assert.ok(conflict.conflictFile, "冲突内容有独立落点");

		const pending = await queue.listPending();
		assert.equal(pending.entries.length, 1, "原条目不被覆盖");
		assert.equal(pending.entries[0].record.visibleText, first.visibleText);
		const evidence = JSON.parse(await fs.readFile(conflict.conflictFile, "utf8"));
		assert.equal(evidence.record.contentHash, divergent.contentHash, "冲突证据保留传入内容");
	});
});

test("重启恢复：新实例读到未确认条目；确认前不移除待传副本", async () => {
	await withQueue({}, async (queue, factory, stateDir) => {
		const record = makeRecord();
		assert.equal((await queue.register(record)).status, "queued");
		const restarted = await factory.open(SCOPE);
		const pending = await restarted.listPending();
		assert.equal(pending.entries.length, 1);
		assert.equal(pending.entries[0].state, "pending");
		assert.equal(pending.entries[0].record.sourceId, record.sourceId);
		assert.equal(pending.entries[0].record.textSha256, record.textSha256, "重启后原文哈希可核对");
	});
});

test("未知发送：markUnknown 保留；逐字段核对回执通过才移除待传副本并留回执墓碑", async () => {
	await withQueue({}, async (queue) => {
		const record = makeRecord();
		await queue.register(record);

		const unknown = await queue.markUnknown(record.sourceId, { reason: "network_timeout" });
		assert.equal(unknown.state, "unknown");
		assert.equal(unknown.attempts, 1);
		assert.equal(unknown.lastError, "network_timeout");

		const notStored = await queue.applyReceipt(record.sourceId, makeReceipt(record, { stored: false }));
		assert.equal(notStored.status, "not_stored");
		assert.ok(await queue.readEntry(record.sourceId), "stored 不为 true 不移除");

		const mismatch = await queue.applyReceipt(record.sourceId, makeReceipt(record, { textSha256: "0".repeat(64) }));
		assert.equal(mismatch.status, "mismatch");
		assert.deepEqual(Array.from(mismatch.mismatches), ["textSha256"]);
		assert.equal(mismatch.entry.state, "conflict", "字段不符升级为冲突而非删除");
		assert.ok(await queue.readEntry(record.sourceId));

		const confirmed = await queue.applyReceipt(record.sourceId, makeReceipt(record));
		assert.equal(confirmed.status, "confirmed");
		assert.equal(await queue.readEntry(record.sourceId), null, "确认只移除待传副本");
		assert.ok(await queue.readReceipt(record.sourceId), "回执墓碑保留证据");
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record))).status, "confirmed", "重复回执幂等");
		assert.equal((await queue.register(record)).status, "duplicate", "已确认条目重登记不重复排队");
		assert.equal((await queue.register(record)).existing, "confirmed");
	});
});

test("跨账号/实例拒绝：身份与队列绑定不符不落盘；他人账号回执不删除本条目", async () => {
	await withQueue({}, async (queue) => {
		const foreign = makeRecord({ identity: { accountId: "acct-2" } });
		await assert.rejects(queue.register(foreign), (error) => error.code === "scope_mismatch");
		const foreignInstance = makeRecord({ identity: { cloudInstanceId: "cloud-2" } });
		await assert.rejects(queue.register(foreignInstance), (error) => error.code === "scope_mismatch");
		assert.equal((await queue.listPending()).entries.length, 0, "拒绝后不落盘");

		const record = makeRecord();
		await queue.register(record);
		const wrongAccount = await queue.applyReceipt(record.sourceId, makeReceipt(record, { accountId: "acct-2" }));
		assert.equal(wrongAccount.status, "mismatch");
		assert.ok(Array.from(wrongAccount.mismatches).includes("accountId"));
		assert.ok(await queue.readEntry(record.sourceId), "跨账号回执不移除本账号条目");
	});
});

test("写失败不静默：stateDir 父路径不可用则 open 失败，不报登记成功", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-fail-"));
	try {
		const blocker = join(root, "blocker");
		await fs.writeFile(blocker, "not a directory");
		const factory = outbox.createSyncOutbox({ stateDir: join(blocker, "state") });
		await assert.rejects(factory.open(SCOPE), (error) => typeof error.code === "string");
		await assert.rejects(factory.open({ ...SCOPE, accountId: "" }), (error) => error.code === "invalid_input");
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
});

test("损坏文件保留证据：list 报 invalid、register 报错、原字节不被删除", async () => {
	await withQueue({}, async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const file = join(queue.dir, "pending", `${record.sourceId}.json`);
		const garbage = '{"不是合法条目":';
		await fs.writeFile(file, garbage, "utf8");

		const listed = await queue.listPending();
		assert.equal(listed.entries.length, 0);
		assert.equal(listed.invalid.length, 1);
		assert.equal(listed.invalid[0].reason, "entry_invalid_json");
		await assert.rejects(queue.readEntry(record.sourceId), (error) => error.code === "existing_corrupt");
		await assert.rejects(queue.register(record), (error) => error.code === "existing_corrupt");
		assert.equal(await fs.readFile(file, "utf8"), garbage, "损坏证据原地保留，不静默删除");
	});
});

test("认证暂停：flag 权威（不逐条改写正文）；新登记按 flag 拦，恢复分页还原旧状态", async () => {
	await withQueue({}, async (queue) => {
		const first = makeRecord();
		await queue.register(first);
		assert.equal(await queue.setAuthBlocked(true, "token_expired", "hash-1"), 0, "blocked 只写标志，O(1)");
		assert.equal(await queue.isAuthBlocked(), true);
		const auth = await queue.getAuthState();
		assert.equal(auth.blocked, true);
		assert.equal(auth.tokenHash, "hash-1", "只存 token hash 指纹");
		assert.equal((await queue.readEntry(first.sourceId)).state, "pending", "既有条目不再被逐条改写");

		const second = makeRecord({ identity: { entryId: "entry-2" } });
		const queued = await queue.register(second);
		assert.equal(queued.entry.state, "auth_blocked", "暂停期间新登记不发");

		assert.equal(await queue.setAuthBlocked(false), 1, "恢复只分页还原 per-entry auth_blocked");
		assert.equal(await queue.isAuthBlocked(), false);
		const restored = await queue.listPending();
		assert.deepEqual(new Set(restored.entries.map((entry) => entry.state)), new Set(["pending"]));
	});
});

test("路径安全：scope 中的逃逸字符被编码在 stateDir 内；非法 sourceId 拒绝", async () => {
	await withQueue({}, async (queue, factory, stateDir) => {
		const escaped = await factory.open({ accountId: "../../evil", cloudInstanceId: "..", deviceId: "dev-1" });
		const root = resolve(stateDir);
		assert.ok(resolve(escaped.dir).startsWith(root), "编码后的目录仍在 stateDir 内");
		assert.equal((await escaped.listPending()).entries.length, 0);
		await assert.rejects(factory.open({ ...SCOPE, accountId: "bad\u0000id" }), (error) => error.code === "invalid_input");
		await assert.rejects(factory.open({ ...SCOPE, accountId: "x".repeat(257) }), (error) => error.code === "invalid_input");
		await assert.rejects(queue.readEntry("../../etc/passwd"), (error) => error.code === "invalid_input");
	});
});

test("markConflict：云端冲突原因落盘且不得被 markUnknown 降级", async () => {
	await withQueue({}, async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const marked = await queue.markConflict(record.sourceId, "cloud_409_conflict");
		assert.equal(marked.state, "conflict");
		assert.equal(marked.conflictReason, "cloud_409_conflict");
		const afterUnknown = await queue.markUnknown(record.sourceId, { reason: "retry" });
		assert.equal(afterUnknown.state, "conflict", "冲突保留，不因未知结果被降级");
		assert.equal((await queue.listPending()).entries[0].conflictReason, "cloud_409_conflict");
	});
});

test("非原子文件系统：硬链接失败必须报 fs_unsupported，不覆盖也不留半成品", async () => {
	const noLinkOutbox = loadOutboxOnNoLinkFs();
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-nolink-"));
	try {
		const stateDir = join(root, "state");
		const queue = await noLinkOutbox.createSyncOutbox({ stateDir }).open(SCOPE);
		await assert.rejects(queue.register(makeRecord()), (error) => error.code === "fs_unsupported");
		const pendingDir = join(stateDir, "acct-1", "cloud-1", "pending");
		assert.deepEqual(await fs.readdir(pendingDir), [], "不得留下半成品或临时文件");
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
});

test("回执墓碑冲突/损坏时不删除待传副本", async () => {
	await withQueue({}, async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		const receiptFile = join(queue.dir, "receipts", `${record.sourceId}.json`);
		const divergent = makeRecord({ content: "另一版原话" });
		await fs.writeFile(receiptFile, JSON.stringify({ schema: "pi-deck-cloud-memory-sync-outbox-receipt", version: 1, sourceId: record.sourceId, confirmedAt: new Date().toISOString(), receipt: makeReceipt(divergent) }), "utf8");
		const conflict = await queue.applyReceipt(record.sourceId, makeReceipt(record));
		assert.equal(conflict.status, "mismatch", "已有回执与输入冲突不得确认");
		assert.equal((await queue.listPending()).entries.length, 1, "冲突回执不清待传副本");

		await fs.writeFile(receiptFile, "{broken", "utf8");
		const corrupt = await queue.applyReceipt(record.sourceId, makeReceipt(record));
		assert.equal(corrupt.status, "invalid");
		assert.equal((await queue.listPending()).entries.length, 1, "损坏回执不清待传副本");
		assert.equal(await fs.readFile(receiptFile, "utf8"), "{broken", "损坏回执保留证据");
	});
});

test("待传副本缺失：applyReceipt 必须核对输入与已验证回执，错误输入不得 confirmed", async () => {
	await withQueue({}, async (queue) => {
		const record = makeRecord();
		await queue.register(record);
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record))).status, "confirmed");
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record, { contentHash: "0".repeat(64) }))).status, "mismatch");
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record, { stored: false }))).status, "not_stored");
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record, { accountId: "acct-2" }))).status, "mismatch");
		assert.equal((await queue.applyReceipt(record.sourceId, { stored: true })).status, "invalid");

		const receiptFile = join(queue.dir, "receipts", `${record.sourceId}.json`);
		await fs.writeFile(receiptFile, JSON.stringify({ schema: "pi-deck-cloud-memory-sync-outbox-receipt", version: 1, sourceId: record.sourceId, confirmedAt: new Date().toISOString(), receipt: makeReceipt(record, { accountId: "acct-2" }) }), "utf8");
		assert.equal(await queue.readReceipt(record.sourceId), null, "scope 不符的回执不算已验证本地回执");
		assert.equal((await queue.applyReceipt(record.sourceId, makeReceipt(record))).status, "invalid");
	});
});
