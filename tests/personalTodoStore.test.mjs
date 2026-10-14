/**
 * 待办持久化与队列纯策略窄测（P02）：原子写失败、损坏队列不静默丢稿（隔离/禁止覆盖）、
 * 字节上界、缓存往返保真、启动归一、队首串行、确认后重映射、列表快照防降级。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const store = loadTsCommonJs("src/main/personal-workbench/personalTodoStore.ts");
const queue = loadTsCommonJs("src/main/personal-workbench/personalTodoQueue.ts");
const { parseWireTodo } = loadTsCommonJs("src/main/personal-workbench/personalTodoWire.ts");

/** vm 沙箱里的对象原型与宿主不同；结构比较前先转成宿主普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const FIXED_NOW = "2026-10-14T00:00:00.000Z";
const QUARANTINE_SUFFIX = "2026-10-14T00-00-00-000Z";

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-todo-store-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function pathsOf(dir) {
	return {
		accountDir: dir,
		identityFile: join(dir, "account.json"),
		cacheFile: join(dir, "cache.json"),
		outboxFile: join(dir, "outbox.json"),
		ledgerFile: join(dir, "ledger.json"),
	};
}

function makeStore(dir, options = {}) {
	return new store.PersonalTodoAccountStore({ paths: pathsOf(dir), now: () => new Date(FIXED_NOW), ...options });
}

function queuedOperation(overrides = {}) {
	return {
		opId: "req_1",
		requestId: "req_00000001",
		itemId: "todo_a",
		operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "改" } },
		clientRef: null,
		baseRevision: "r1-root",
		phase: "pending",
		attempts: 0,
		lastError: null,
		conflictRevision: null,
		localSubtodoId: null,
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
		lastAttemptAt: null,
		...overrides,
	};
}

function domainItem(overrides = {}) {
	return parseWireTodo({ id: "todo_a", title: "云端事项", root_revision: "r1-root", linked_task_ids: [], subtodos: [], ...overrides });
}

test("原子写失败：父路径不可用时结构化失败且不产生半成品", async (t) => {
	const dir = tempDir(t);
	const blockedParent = join(dir, "personal-todos");
	writeFileSync(blockedParent, "not-a-dir");
	const target = join(blockedParent, "acc", "outbox.json");
	assert.deepEqual(plain(await store.writeJsonAtomic(target, { version: 1, operations: [] })), { ok: false, reason: "writeFailed" });
	assert.equal(existsSync(target), false);
	const okPath = join(dir, "ok", "outbox.json");
	assert.deepEqual(plain(await store.writeJsonAtomic(okPath, { version: 1, operations: [] })), { ok: true });
	assert.equal(readdirSync(join(dir, "ok")).filter((name) => name.endsWith(".tmp")).length, 0, "不残留 tmp 文件");
});

test("队列损坏不静默丢稿：原文件隔离保留并返回结构化 issue", async (t) => {
	const dir = tempDir(t);
	const accountStore = makeStore(dir);
	const raw = "{ this is not json";
	writeFileSync(pathsOf(dir).outboxFile, raw, "utf8");
	const loaded = await accountStore.loadOutbox();
	assert.deepEqual(plain(loaded.value), { operations: [] });
	assert.equal(loaded.issue.code, "invalidJson");
	assert.equal(loaded.issue.file, "outbox");
	assert.equal(loaded.issue.blocked, false);
	assert.equal(loaded.issue.quarantinePath, `${pathsOf(dir).outboxFile}.corrupt-${QUARANTINE_SUFFIX}`);
	assert.equal(readFileSync(loaded.issue.quarantinePath, "utf8"), raw, "原 bytes 原样保留");
	assert.equal(existsSync(pathsOf(dir).outboxFile), false, "损坏文件已从主路径移开");
	assert.deepEqual(plain(await accountStore.saveOutbox({ operations: [] })), { ok: true }, "隔离后可继续写入");
});

test("有效 JSON 但结构/条目非法同样算损坏（不静默丢单条）", async (t) => {
	const mixed = tempDir(t);
	const mixedStore = makeStore(mixed);
	writeFileSync(pathsOf(mixed).outboxFile, JSON.stringify({ version: 1, operations: [queuedOperation(), { opId: "req_2" }] }));
	const loaded = await mixedStore.loadOutbox();
	assert.deepEqual(plain(loaded.value), { operations: [] }, "不保留部分条目");
	assert.equal(loaded.issue.code, "invalidStructure");
	assert.equal(existsSync(loaded.issue.quarantinePath), true);

	const badPhaseDir = tempDir(t);
	writeFileSync(pathsOf(badPhaseDir).outboxFile, JSON.stringify({ version: 1, operations: [queuedOperation({ phase: "whatever" })] }));
	assert.equal((await makeStore(badPhaseDir).loadOutbox()).issue.code, "invalidStructure", "非法枚举不得被 as 强转成合法 phase");

	const badCodeDir = tempDir(t);
	writeFileSync(pathsOf(badCodeDir).outboxFile, JSON.stringify({ version: 1, operations: [queuedOperation({ lastError: { code: "notARealCode", message: "x" } })] }));
	assert.equal((await makeStore(badCodeDir).loadOutbox()).issue.code, "invalidStructure", "非法错误码不得被强转，也不得静默丢弃 lastError");

	const badKindDir = tempDir(t);
	writeFileSync(pathsOf(badKindDir).ledgerFile, JSON.stringify({ version: 1, entries: [{ requestId: "req_00000001", itemId: "todo_a", kind: "explode", confirmedAt: FIXED_NOW }] }));
	assert.equal((await makeStore(badKindDir).loadLedger()).issue.file, "ledger");
});

test("隔离失败时禁止覆盖：原文件保留且写入被拒", async (t) => {
	const dir = tempDir(t);
	const raw = JSON.stringify({ version: 1, operations: [queuedOperation({ phase: "nope" })] });
	writeFileSync(pathsOf(dir).outboxFile, raw);
	// 隔离目标位置已被目录占用：rename 必然失败
	mkdirSync(`${pathsOf(dir).outboxFile}.corrupt-${QUARANTINE_SUFFIX}`);
	const accountStore = makeStore(dir);
	const loaded = await accountStore.loadOutbox();
	assert.equal(loaded.issue.blocked, true);
	assert.equal(loaded.issue.quarantinePath, null);
	assert.equal(readFileSync(pathsOf(dir).outboxFile, "utf8"), raw, "原文件仍在原位且内容不变");
	assert.deepEqual(plain(await accountStore.saveOutbox({ operations: [queuedOperation()] })), { ok: false, reason: "writeFailed" }, "禁止用新队列覆盖损坏原件");
	assert.equal(readFileSync(pathsOf(dir).outboxFile, "utf8"), raw);
});

test("读取有字节上界：超限文件不进内存、按损坏处理", async (t) => {
	const dir = tempDir(t);
	writeFileSync(pathsOf(dir).cacheFile, JSON.stringify({ version: 1, items: [], note: "x".repeat(512) }));
	const accountStore = makeStore(dir, { maxBytes: 128 });
	const loaded = await accountStore.loadCache();
	assert.equal(loaded.issue.code, "tooLarge");
	assert.deepEqual(plain(loaded.value), { fetchedAt: null, cursor: null, items: [] });
});

test("缓存往返保真：parseCacheFile 读回 camelCase 缓存与写入前完全一致", async (t) => {
	const dir = tempDir(t);
	const wire = {
		id: "todo-20260905-1000-p0yr",
		title: "旧事项",
		note: "长备注".repeat(300),
		category: "工作",
		deadline: "2026-09-05",
		urgency: 0,
		status: "done",
		revision: "r1-item",
		root_revision: "r1-root",
		is_root: true,
		parent_id: null,
		created_at: "2026-09-05T10:00:00.000Z",
		updated_at: "2026-09-06T00:00:00.000Z",
		linked_task_ids: ["20260905-1011-cx15"],
		subtodos: [{ id: "legacy_sub_abc", title: "子项一", note: "", status: "open", assignee: "me", linked_task_ids: ["t1"], parent_subtodo_id: "s1", revision: "r-sub" }],
		subtodo_progress: { total: 1, done: 0, open: 1, cancelled: 0 },
		source: { kind: "legacy", namespace: "workbench", source_id: "s1", fingerprint: "fp", raw_available: true },
		history_count: 3,
	};
	const item = parseWireTodo(wire);
	const accountStore = makeStore(dir);
	assert.deepEqual(plain(await accountStore.saveCache({ fetchedAt: FIXED_NOW, cursor: "cur_1", items: [item] })), { ok: true });
	const loaded = await accountStore.loadCache();
	assert.equal(loaded.issue, null);
	assert.deepEqual(plain(loaded.value.items), plain([item]), "往返后字段、来源、子项与进度必须一致");
	assert.equal(loaded.value.fetchedAt, FIXED_NOW);
	assert.equal(loaded.value.cursor, "cur_1");
});

test("启动归一：sending 按是否尝试过转为 unknown/pending，并同步 expectRevision", () => {
	const normalized = queue.normalizeLoadedOperations([
		queuedOperation({ phase: "sending", attempts: 1 }),
		queuedOperation({ opId: "req_2", requestId: "req_00000002", phase: "sending", attempts: 0 }),
		queuedOperation({ opId: "req_3", requestId: "req_00000003", operation: { kind: "patch", id: "todo_a", expectedRevision: "stale", patch: { title: "x" } } }),
	]);
	assert.equal(normalized[0].phase, "unknown");
	assert.equal(normalized[1].phase, "pending");
	assert.equal(normalized[2].operation.expectedRevision, "r1-root", "以 baseRevision 校正旧文件里的不一致");
	assert.equal(normalized[2].baseRevision, "r1-root");
});

test("台账追加去重并保留上限窗口", () => {
	let entries = [];
	for (let index = 0; index < 520; index += 1) {
		entries = store.appendLedgerEntry(entries, { requestId: `req_${String(index).padStart(8, "0")}`, itemId: "todo_a", kind: "patch", revision: `r${index}`, confirmedAt: FIXED_NOW });
	}
	assert.equal(entries.length, store.PERSONAL_TODO_LEDGER_MAX_ENTRIES);
	entries = store.appendLedgerEntry(entries, { requestId: "req_00000500", itemId: "todo_a", kind: "patch", revision: "rX", confirmedAt: FIXED_NOW });
	assert.equal(entries.length, store.PERSONAL_TODO_LEDGER_MAX_ENTRIES, "重复 requestId 不膨胀台账");
	assert.equal(entries[entries.length - 1].revision, "rX");
});

test("队首串行：冲突/失败的队首阻塞同事项后续，其它事项照常推进", () => {
	const operations = [queuedOperation({ opId: "a1", requestId: "req_00000001", itemId: "todo_a", phase: "conflict" }), queuedOperation({ opId: "a2", requestId: "req_00000002", itemId: "todo_a", phase: "pending" }), queuedOperation({ opId: "b1", requestId: "req_00000003", itemId: "todo_b", phase: "pending" })];
	const picked = queue.pickEligibleOperation(operations);
	assert.equal(picked.opId, "b1", "todo_a 队首未消解则整组跳过，另事项继续");
	assert.equal(queue.hasQueuedOperations([queuedOperation({ phase: "conflict" })]), false, "冲突不自动重试");
	assert.equal(queue.headOperationForItem(operations, "todo_a").opId, "a1");
});

test("确认后重映射：create 本地 id 换服务端 id，链上 CAS 与子项 id 同步", () => {
	const operations = [
		queuedOperation({ opId: "c1", requestId: "req_00000001", itemId: "todo_local_1", operation: { kind: "create", title: "新事项" }, baseRevision: null }),
		queuedOperation({ opId: "c2", requestId: "req_00000002", itemId: "todo_local_1", operation: { kind: "subtodoAdd", id: "todo_local_1", expectedRevision: "", text: "子项" }, localSubtodoId: "sub_local_1" }),
		queuedOperation({ opId: "c3", requestId: "req_00000003", itemId: "todo_local_1", operation: { kind: "subtodoPatch", id: "todo_local_1", expectedRevision: "", subtodoId: "sub_local_1", text: "改名" } }),
	];
	const rebased = queue.rebaseQueuedOperations(operations, "todo_local_1", "todo_srv_1", "r9", { localId: "sub_local_1", serverId: "legacy_sub_9" });
	assert.equal(rebased[1].itemId, "todo_srv_1");
	assert.equal(rebased[1].baseRevision, "r9");
	assert.equal(rebased[2].operation.subtodoId, "legacy_sub_9", "后续子项操作改指服务端 sub_id");
	assert.equal(rebased[2].operation.expectedRevision, "r9");
});

test("列表快照不覆盖本地新确认记录，也不丢失已加载窗口", () => {
	const local = domainItem({ root_revision: "r2-root", title: "本地新版本" });
	const page = [domainItem({ root_revision: "r1-root", title: "服务端旧快照" })];
	const kept = queue.mergePageItems([local], page, false, (id) => id === "todo_a");
	assert.equal(kept.length, 1);
	assert.equal(kept[0].title, "本地新版本");
	const replaced = queue.mergePageItems([local], page, false, () => false);
	assert.equal(replaced[0].title, "服务端旧快照");
	const secondPage = queue.mergePageItems([domainItem({ id: "todo_b", root_revision: "r1" })], [domainItem({ id: "todo_b", root_revision: "r2", title: "更新" }), domainItem({ id: "todo_c", root_revision: "r1" })], true);
	assert.deepEqual(plain(secondPage.map((item) => item.id)), ["todo_b", "todo_c"], "游标页保持原有顺序并追加新条目");
	assert.equal(secondPage[0].title, "更新");
	assert.equal(queue.mergePageItems([domainItem({ id: "todo_z", root_revision: "r1" })], [], false).length, 1, "服务端当前页未返回的本地已知记录保留（分页窗口不缩水）");
});

test("差异检测与退避序列", () => {
	const before = [domainItem({ root_revision: "r1" })];
	const after = [domainItem({ root_revision: "r2" }), domainItem({ id: "todo_b", root_revision: "r1" })];
	assert.deepEqual(plain(queue.diffItemIds(before, after)), { changedIds: ["todo_a", "todo_b"], removed: false });
	assert.deepEqual(plain(queue.diffItemIds(before, [])), { changedIds: [], removed: true });
	assert.equal(queue.nextBackoffMs(0, 5000, 120000), 5000);
	assert.equal(queue.nextBackoffMs(5000, 5000, 120000), 10000);
	assert.equal(queue.nextBackoffMs(120000, 5000, 120000), 120000);
});
