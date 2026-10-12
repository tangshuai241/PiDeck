/**
 * 租约占用的原子性：同一 runtime 上两件工作并发开始只能有一次绑定/批准。
 *
 * 为什么必须用「真实 service.start + 强制交错」：只断言「第二个被拒」在串行调用下
 * 永远成立，掩盖了 read→compare→write 之间的并发窗口。这里注入 barrier 让两次
 * acquire 必然在锁内交错：没有锁时两边都会读到 missing 并各自写入。
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createHarness, createWork, prepareCreate } from "./helpers/documentWorkServiceHarness.mjs";

const AUTHORIZATION = { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 };

function countBinds(harness) {
	return harness.state.dispatched.filter((message) => message.startsWith("/tpa-work bind ")).length;
}

function countApproves(harness) {
	return harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length;
}

test("barrier 强制交错：两件工作同 runtime 并发 start 只绑定一次、只批准一次", async () => {
	// barrier 在租约锁内触发：第一次进入后等第二个 acquire 也排到队上，再让两边继续。
	let entered = 0;
	let releaseBarrier;
	const barrierReady = new Promise((resolve) => {
		releaseBarrier = resolve;
	});
	const allEntered = new Promise((resolve) => {
		void (async () => {
			while (entered < 1) await new Promise((r) => setTimeout(r, 1));
			resolve(undefined);
		})();
	});
	const harness = createHarness({
		leaseAcquireBarrier: async () => {
			entered += 1;
			if (entered === 1) {
				// 第一个持有锁的调用等第二个到达队列后再继续。
				await Promise.race([barrierReady, new Promise((r) => setTimeout(r, 50))]);
			}
		},
	});
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);

		// 第二件工作：同一 runtime、不同 workId 与自己的准备记录。
		const other = { ...view, workId: "dw_second_work", revision: 1 };
		const now = Date.now();
		await harness.domain.store.createRecord({
			schemaVersion: 1,
			workId: other.workId,
			sessionId: view.sessionId,
			revision: 1,
			title: "第二件文稿",
			outputRootId: (await harness.domain.store.listOutputRoots())[0].outputRootId,
			workDirectory: `${view.workId}-other`,
			workFolder: "dw_second_work",
			sourceTurnIds: ["turn-1"],
			requirementsSummary: "",
			operationRequestIds: [],
			versionIds: [],
			consumedRevisionTurns: [],
			consumedRevisionTurnIds: [],
			createdAt: now,
			updatedAt: now,
		});
		await harness.domain.store.savePreparation({
			schemaVersion: 1,
			preparationId: "pr_second",
			digest: "b".repeat(64),
			workId: other.workId,
			workRevision: 1,
			kind: "create_document",
			requirements: { kind: "alignment", briefId: "brief-1", revision: 2 },
			requirementsSummary: "第二件",
			outputRootId: (await harness.domain.store.listOutputRoots())[0].outputRootId,
			stagingDirectory: `${view.workId}-other/staging/at_second`,
			materials: [],
			scope: { summary: "s", sections: [], preserve: [] },
			runtime: harness.runtime.target(),
			nativeSessionId: "pi-native-session-9",
			createdAt: now,
		});

		// 两个 start 同时进入租约锁（barrier 保证第一个不会早于第二个完成写入）。
		const first = harness.domain.service.start({
			requestId: "req-a",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		});
		await allEntered;
		const second = harness.domain.service.start({
			requestId: "req-b",
			workId: other.workId,
			expectedRevision: 1,
			preparation: { preparationId: "pr_second", digest: "b".repeat(64) },
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		});
		releaseBarrier(undefined);
		const results = await Promise.all([first, second]);
		const accepted = results.filter((result) => result.ok);
		const rejected = results.filter((result) => !result.ok);
		assert.equal(accepted.length, 1, `只允许一次成功，实际 ${JSON.stringify(results.map((r) => (r.ok ? "ok" : r.error.code)))}`);
		assert.equal(rejected.length, 1);
		assert.equal(rejected[0].error.code, "RUNTIME_BUSY", JSON.stringify(rejected[0].error));
		assert.equal(countBinds(harness), 1, "同一 runtime 只允许一次绑定");
		assert.equal(countApproves(harness), 1, "同一 runtime 只允许一次批准");
		// 运行时在绑定等待期间仍然是 idle（假运行时不置忙），排他靠租约而不是靠状态。
		assert.equal(harness.state.status, "idle");
	} finally {
		await harness.cleanup();
	}
});

test("租约损坏时 fail-closed：不当作 missing 放行，也不允许清除", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const leaseFile = join(harness.root, "userData", "document-work", "leases");
		// 先正常占一次，再破坏文件内容。
		assert.equal((await harness.domain.service.start({ requestId: "req-a", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: AUTHORIZATION })).ok, true);
		const name = readdirSync(leaseFile).find((entry) => entry.endsWith(".json"));
		writeFileSync(join(leaseFile, name), "{ not a lease", "utf8");
		const state = await harness.domain.store.readRuntimeLeaseState(view.sessionId);
		assert.equal(state.kind, "corrupt");
		const released = await harness.domain.store.clearRuntimeLease(view.sessionId, "req-a");
		assert.equal(released, false, "损坏租约不能被清除");
		assert.equal(readFileSync(join(leaseFile, name), "utf8"), "{ not a lease", "损坏原件必须保持原样");
		const blocked = await harness.domain.service.start({ requestId: "req-b", workId: view.workId, expectedRevision: prepared.value.workRevision + 1, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: AUTHORIZATION });
		assert.equal(blocked.ok, false, "损坏租约期间不得开放新请求");
	} finally {
		await harness.cleanup();
	}
});
