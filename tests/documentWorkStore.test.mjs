/**
 * 文稿元数据存储：乐观并发、请求去重、崩溃恢复与原子写回退。
 *
 * 从公开接口断言行为，不读内部字段：CAS 冲突必须带 currentRevision，
 * 同 requestId 不同载荷必须显式失败，损坏的主文件必须能回退到 .bak。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
/** 被加载模块在 vm 里有独立原型链：结构比较前先 JSON 归一。 */
const hashText = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const { DocumentWorkStore } = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentWorkStore.ts`);

function makeStore() {
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-store-"));
	const store = new DocumentWorkStore(join(root, "document-work"));
	return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function record(overrides = {}) {
	const now = Date.now();
	return {
		schemaVersion: 1,
		workId: "dw_test",
		sessionId: "session-a",
		revision: 1,
		title: "报告",
		outputRootId: "or_test",
		workDirectory: "C:\\out\\dw_test",
		workFolder: "dw_test-报告",
		sourceTurnIds: ["turn-1"],
		requirementsSummary: "",
		operationRequestIds: [],
		versionIds: [],
		consumedRevisionTurns: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("工作记录可写入并读回；同一工作重复创建返回既有记录", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		const created = await context.store.createRecord(record());
		assert.equal(created.ok, true);
		const again = await context.store.createRecord(record({ title: "另一个标题" }));
		assert.equal(again.ok, true);
		assert.equal(again.value.title, "报告", "重复创建不得覆盖既有工作");
		assert.equal((await context.store.listWorkIdsForSession("session-a")).length, 1);
		assert.deepEqual(plain(await context.store.listWorkIdsForSession("session-b")), [], "会话索引不得互相串台");
	} finally {
		context.cleanup();
	}
});

test("CAS 冲突返回最新版本，成功写入则版本递增", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.createRecord(record());
		const conflicted = await context.store.mutateRecord("dw_test", 99, (current) => current);
		assert.equal(conflicted.ok, false);
		assert.equal(conflicted.error.code, "REVISION_CONFLICT");
		assert.equal(conflicted.error.currentRevision, 1, "冲突必须回填最新版本供调用方重试");
		const updated = await context.store.mutateRecord("dw_test", 1, (current) => ({ ...current, title: "第二版" }));
		assert.equal(updated.ok, true);
		assert.equal(updated.value.revision, 2);
		assert.equal((await context.store.getRecord("dw_test")).title, "第二版");
	} finally {
		context.cleanup();
	}
});

test("请求去重：同载荷重放命中，不同载荷显式冲突", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		assert.equal((await context.store.readIdempotent("req-1", "digest-a")).kind, "miss");
		await context.store.writeIdempotent("req-1", "digest-a", { workId: "dw_test" });
		assert.deepEqual(plain(await context.store.readIdempotent("req-1", "digest-a")), { kind: "hit", payload: { workId: "dw_test" } });
		assert.equal((await context.store.readIdempotent("req-1", "digest-b")).kind, "conflict");
	} finally {
		context.cleanup();
	}
});

test("崩溃恢复只改状态：进行中与未知分发分别落 interrupted / unknown，且不重放", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		const base = {
			schemaVersion: 1,
			workId: "dw_test",
			attemptId: "at_1",
			kind: "create_document",
			preparation: { preparationId: "pr_1", digest: "a".repeat(64) },
			preparedWorkRevision: 2,
			runtime: { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1 },
			authorization: { kind: "alignment_confirmation", briefId: "b1", revision: 2 },
			authorizationState: "pending",
			extensionBound: true,
			dispatchAccepted: true,
			dispatchUnknown: false,
			createdAt: 1,
			updatedAt: 1,
		};
		const interrupted = await context.store.recoverInterruptedOperation({ ...base, requestId: "req-run", phase: "running" });
		assert.equal(interrupted.phase, "interrupted");
		assert.equal(interrupted.error.code, "IO_ERROR");
		const unknown = await context.store.recoverInterruptedOperation({ ...base, requestId: "req-unknown", phase: "dispatching", dispatchUnknown: true });
		assert.equal(unknown.phase, "unknown");
		assert.equal(unknown.error.code, "DISPATCH_UNKNOWN");
		const archived = await context.store.recoverInterruptedOperation({ ...base, requestId: "req-done", phase: "archived" });
		assert.equal(archived.phase, "archived", "已归档操作不得被改写成失败");
		// 恢复结果必须落盘：进程二次启动不能又看到 running。
		await context.store.saveOperation({ ...base, requestId: "req-run", phase: "running" });
		const again = await context.store.recoverInterruptedOperation(await context.store.getOperation("dw_test", "req-run"));
		assert.equal(again.phase, "interrupted");
	} finally {
		context.cleanup();
	}
});

test("主文件损坏时优先用 .bak 作证据；两份都坏则只剩 corrupt，不复活旧状态", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.createRecord(record());
		await context.store.mutateRecord("dw_test", 1, (current) => ({ ...current, title: "第二版" }));
		const workFile = join(context.store.directory, "works", "dw_test", "work.json");
		writeFileSync(workFile, "{ this is not json", "utf8");
		const recovered = await context.store.getRecord("dw_test");
		assert.equal(recovered?.title, "报告", "损坏的主文件必须回退到上一份可用快照");
		writeFileSync(`${workFile}.bak`, "also broken", "utf8");
		const state = await context.store.readRecordState("dw_test");
		assert.equal(state.kind, "corrupt", "两份都坏时仍然是 corrupt，而不是 missing");
		assert.equal(state.recovered, undefined);
		assert.equal(await context.store.getRecord("dw_test"), undefined, "没有可用证据时 fail-closed");
	} finally {
		context.cleanup();
	}
});

test("输出根按真实路径去重，重复选择不产生第二个 ID", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		const first = await context.store.registerOutputRoot("C:\\out\\docs", "docs");
		const second = await context.store.registerOutputRoot("c:\\out\\docs", "docs");
		assert.equal(first.outputRootId, second.outputRootId);
		assert.equal((await context.store.listOutputRoots()).length, 1);
		assert.equal((await context.store.getOutputRoot(first.outputRootId)).label, "docs");
		const raw = readFileSync(join(context.store.directory, "output-roots.json"), "utf8");
		assert.equal(JSON.parse(raw).length, 1);
	} finally {
		context.cleanup();
	}
});

test("主档损坏时旧备份只能当只读证据：不改写、不重建、不再授予写入", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.createRecord(record());
		await context.store.mutateRecord("dw_test", 1, (current) => ({ ...current, title: "第二版" }));
		const workFile = join(context.store.directory, "works", "dw_test", "work.json");
		writeFileSync(workFile, "{ not json", "utf8");

		// 读取路径：健康度明确是 corrupt，但备份可作恢复证据展示。
		const state = await context.store.readRecordState("dw_test");
		assert.equal(state.kind, "corrupt");
		assert.equal(state.recovered?.title, "报告");
		assert.equal((await context.store.getRecord("dw_test"))?.title, "报告", "只读展示可用备份");

		// 写入路径：不能拿旧备份继续 CAS，也不能覆写损坏原件。
		const mutated = await context.store.mutateRecord("dw_test", 1, (current) => ({ ...current, title: "第三版" }));
		assert.equal(mutated.ok, false);
		assert.equal(mutated.error.code, "IO_ERROR");
		assert.equal(mutated.error.detail, "record_corrupt");
		assert.equal(readFileSync(workFile, "utf8"), "{ not json", "损坏原件必须保持原样");

		// 损坏 ≠ 不存在：重建会丢掉恢复入口。
		const recreated = await context.store.createRecord(record());
		assert.equal(recreated.ok, false);
		assert.equal(recreated.error.detail, "record_corrupt");
		assert.equal(readFileSync(workFile, "utf8"), "{ not json");
	} finally {
		context.cleanup();
	}
});

test("去重槽损坏时 fail-closed：既不重放也不覆盖损坏原件", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.writeIdempotent("req-9", "digest-a", { workId: "dw_test" });
		const file = join(context.store.directory, "idempotency", "req-9.json");
		writeFileSync(file, "{ broken", "utf8");
		assert.equal((await context.store.readIdempotent("req-9", "digest-a")).kind, "conflict", "损坏时不能当成 miss 而重放");
		assert.equal(await context.store.writeIdempotent("req-9", "digest-b", { workId: "dw_other" }), false);
		assert.equal(readFileSync(file, "utf8"), "{ broken", "损坏原件必须保持原样");
	} finally {
		context.cleanup();
	}
});

test("同一会话多件工作都保留恢复入口，旧格式索引仍读得懂", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.createRecord(record({ workId: "dw_first" }));
		await context.store.createRecord(record({ workId: "dw_second" }));
		const ids = await context.store.listWorkIdsForSession("session-a");
		assert.deepEqual(plain([...ids].sort()), ["dw_first", "dw_second"], "索引不得只留最后一件");
		// 旧格式（只有 workId）仍然可读。
		writeFileSync(join(context.store.directory, "sessions", `${hashText("session-a")}.json`), JSON.stringify({ sessionId: "session-a", workId: "dw_legacy" }));
		assert.deepEqual(plain(await context.store.listWorkIdsForSession("session-a")), ["dw_legacy"]);
		assert.deepEqual(plain(await context.store.listWorkIdsForSession("session-b")), []);
	} finally {
		context.cleanup();
	}
});

test("并发 CAS 只有一次成功：串行锁覆盖读取→动作→回执", async () => {
	const context = makeStore();
	try {
		await context.store.initialize();
		await context.store.createRecord(record());
		const attempts = await Promise.all(Array.from({ length: 5 }, (_, index) => context.store.mutateRecord("dw_test", 1, (current) => ({ ...current, title: `第 ${index} 次` }))));
		assert.equal(attempts.filter((result) => result.ok).length, 1, "同一 expectedRevision 只允许一次成功");
		assert.equal((await context.store.getRecord("dw_test")).revision, 2);
	} finally {
		context.cleanup();
	}
});
