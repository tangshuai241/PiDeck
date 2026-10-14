// pi-deck-cloud-memory-sync-outbox 的单发送者租约与多写者测试：token ownership、pid 存活校验、
// 过期不得抢活锁、死亡接管、迟到释放不删新租约、并发登记不互相覆盖。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");
const outbox = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-outbox.ts");

const SCOPE = { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1" };

function makeIdentity(overrides = {}) {
	return { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", sessionId: "sess-1", entryId: "entry-1", revision: 1, ...overrides };
}

function makeRecord(overrides = {}) {
	return identity.createSyncRecord({ identity: makeIdentity(overrides.identity), role: "user", content: overrides.content ?? "原话", occurredAt: "2026-10-13T12:00:00.000Z" });
}

async function withRoot(run) {
	const root = await fs.mkdtemp(join(tmpdir(), "tpa-cloud-sync-lease-"));
	try {
		await run(root, join(root, "state"));
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

test("claim：首个实例取得租约，同进程第二个 claim 不得抢活跃锁", async () => {
	await withRoot(async (root, stateDir) => {
		const first = await outbox.createSyncOutbox({ stateDir }).open(SCOPE);
		const claimed = await first.claimSender(60_000);
		assert.equal(claimed.status, "claimed");
		assert.equal(claimed.lease.pid, process.pid);
		assert.ok(claimed.lease.token);

		const second = await outbox.createSyncOutbox({ stateDir }).open(SCOPE);
		const blocked = await second.claimSender(60_000);
		assert.equal(blocked.status, "blocked");
		assert.equal(blocked.reason, "active_owner");
		assert.equal(blocked.owner.token, claimed.lease.token);
		assert.equal(await first.renewSender(claimed.lease.token), true, "持有者可续租");
		assert.equal(await first.releaseSender(claimed.lease.token), true, "持 token 者释放成功");
		assert.equal((await second.claimSender(60_000)).status, "claimed", "释放后可再竞选");
	});
});

test("不能仅凭超时抢仍活跃锁：租约过期但 pid 存活时拒绝接管", async () => {
	await withRoot(async (root, stateDir) => {
		let clock = Date.parse("2026-10-13T12:00:00.000Z");
		const make = () => outbox.createSyncOutbox({ stateDir, now: () => clock });
		const first = await make().open(SCOPE);
		const claimed = await first.claimSender(1_000);
		assert.equal(claimed.status, "claimed");

		clock += 60 * 60 * 1000; // 远超租约 TTL
		const second = await make().open(SCOPE);
		const blocked = await second.claimSender(1_000);
		assert.equal(blocked.status, "blocked", "超时不是接管依据");
		assert.equal(blocked.reason, "active_owner");
		assert.equal(blocked.owner.token, claimed.lease.token);
	});
});

test("死亡接管：旧 owner 进程已死才可抢；迟到 release 不影响新租约", async () => {
	await withRoot(async (root, stateDir) => {
		const factoryA = outbox.createSyncOutbox({ stateDir, processId: 1111, isPidAlive: () => false, makeToken: () => "token-a" });
		const queueA = await factoryA.open(SCOPE);
		const leaseA = await queueA.claimSender(60_000);
		assert.equal(leaseA.status, "claimed");

		const factoryB = outbox.createSyncOutbox({ stateDir, processId: 2222, isPidAlive: () => false, makeToken: () => "token-b" });
		const queueB = await factoryB.open(SCOPE);
		const leaseB = await queueB.claimSender(60_000);
		assert.equal(leaseB.status, "claimed", "证实的死进程可以被接管");
		assert.notEqual(leaseB.lease.token, leaseA.lease.token);

		assert.equal(await queueA.releaseSender(leaseA.lease.token), false, "旧 owner 释放只认自己的 token");
		assert.equal(await queueA.renewSender(leaseA.lease.token), false);
		assert.equal(await queueB.renewSender(leaseB.lease.token), true, "新租约未被旧 token 删除");
	});
});

test("未知 owner：pid 缺失或租约损坏时一律不抢", async () => {
	await withRoot(async (root, stateDir) => {
		const queue = await outbox.createSyncOutbox({ stateDir }).open(SCOPE);
		const leaseFile = join(stateDir, "acct-1", "cloud-1", "sender-lease.json");
		await fs.mkdir(join(stateDir, "acct-1", "cloud-1"), { recursive: true });
		await fs.writeFile(leaseFile, "{broken", "utf8");
		const blocked = await queue.claimSender(1_000);
		assert.equal(blocked.status, "blocked");
		assert.equal(blocked.reason, "unreadable_lease");
		assert.equal(await fs.readFile(leaseFile, "utf8"), "{broken", "损坏租约保留证据不删除");

		const noPid = { token: "t", accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", pid: 0, processStartedAt: "x", createdAt: "x", heartbeatAt: "x", expiresAt: "x" };
		await fs.writeFile(leaseFile, JSON.stringify(noPid), "utf8");
		const unknown = await queue.claimSender(1_000);
		assert.equal(unknown.status, "blocked", "无法证实身份的 owner 不抢");
	});
});

test("多发送者并发竞选：同一时刻只有一个 claimed", async () => {
	await withRoot(async (root, stateDir) => {
		const queues = await Promise.all([1, 2, 3].map((index) => outbox.createSyncOutbox({ stateDir, makeToken: () => `token-${index}` }).open(SCOPE)));
		const claims = await Promise.all(queues.map((queue) => queue.claimSender(60_000)));
		const claimed = claims.filter((claim) => claim.status === "claimed");
		assert.equal(claimed.length, 1, "同一时刻只能有一个发送者");
		for (const blocked of claims.filter((claim) => claim.status === "blocked")) {
			assert.equal(blocked.reason, "active_owner");
		}
	});
});

test("多写者并发登记：同身份异内容一方保留原件、另一方进冲突证据，互不覆盖", async () => {
	await withRoot(async (root, stateDir) => {
		const factory = outbox.createSyncOutbox({ stateDir });
		const queueA = await factory.open(SCOPE);
		const queueB = await factory.open(SCOPE);
		const recordA = makeRecord({ content: "A 的内容" });
		const recordB = makeRecord({ content: "B 的内容" });
		assert.equal(recordA.sourceId, recordB.sourceId);
		const results = await Promise.all([queueA.register(recordA), queueB.register(recordB)]);
		const statuses = results.map((result) => result.status).sort();
		assert.deepEqual(statuses, ["conflict", "queued"], "恰好一方登记、一方冲突");
		const pending = await queueA.listPending();
		assert.equal(pending.entries.length, 1, "待传目录只有一条");
		const winnerText = pending.entries[0].record.visibleText;
		const conflictFile = join(stateDir, "acct-1", "cloud-1", "conflicts", `${recordA.sourceId}.${winnerText === recordA.visibleText ? recordB.contentHash : recordA.contentHash}.json`);
		assert.ok(await fs.stat(conflictFile), "落败内容保留在冲突证据");
		const evidence = JSON.parse(await fs.readFile(conflictFile, "utf8"));
		assert.notEqual(evidence.record.visibleText, winnerText);
	});
});

test("多写者并发登记不同身份：两条都在，互不覆盖", async () => {
	await withRoot(async (root, stateDir) => {
		const factory = outbox.createSyncOutbox({ stateDir });
		const queueA = await factory.open(SCOPE);
		const queueB = await factory.open(SCOPE);
		const recordA = makeRecord({ identity: { entryId: "entry-a" } });
		const recordB = makeRecord({ identity: { entryId: "entry-b" } });
		const results = await Promise.all([queueA.register(recordA), queueB.register(recordB)]);
		assert.deepEqual(
			results.map((result) => result.status),
			["queued", "queued"],
		);
		const pending = await queueA.listPending();
		assert.deepEqual(new Set(pending.entries.map((entry) => entry.record.sourceId)), new Set([recordA.sourceId, recordB.sourceId]));
		assert.equal(pending.invalid.length, 0);
	});
});
