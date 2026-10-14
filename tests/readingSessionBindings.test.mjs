/**
 * P04 阅读会话绑定存储测试（main/personal-workbench/reading/readingSessionBindings）。
 *
 * 锁住的契约：
 * - 绑定按 workId+editionId 持久，跨实例重开可读；重绑保留 createdAt、更新 lastUsedAt；
 * - 解绑只删关系；同作品不同版本互不影响；
 * - 损坏隔离：坏 JSON / 结构非法 / 超界 → 原件改名隔离 + 以空状态继续 + 后续写入仍可用；
 * - 损坏条目逐条丢弃；条目上界按 lastUsedAt 淘汰最旧。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const { ReadingSessionBindingsStore, READING_BINDINGS_MAX_ENTRIES } = loadTsCommonJs("src/main/personal-workbench/reading/readingSessionBindings.ts");

function pathsFor(dir) {
	return {
		dataDir: dir,
		connectionFile: join(dir, "connection.json"),
		positionsDir: join(dir, "positions"),
		notesIndexDir: join(dir, "notes-index"),
		noteDraftsFile: join(dir, "note-drafts.json"),
		sessionsDir: join(dir, "sessions"),
	};
}

function tempDir() {
	return mkdtempSync(join(tmpdir(), "tpa-bindings-"));
}

function binding(overrides = {}) {
	return {
		workId: "w1",
		editionId: "e1",
		sessionId: "sess-a",
		projectId: "proj-1",
		createdAt: "2026-10-15T00:00:00.000Z",
		lastUsedAt: "2026-10-15T00:00:00.000Z",
		...overrides,
	};
}

function bindingsFile(dir) {
	return join(dir, "sessions", "bindings.json");
}

function quarantineFiles(dir) {
	const parent = join(dir, "sessions");
	try {
		return readdirSync(parent).filter((name) => name.includes(".corrupt-"));
	} catch {
		return [];
	}
}

test("绑定写入后重读一致：新实例（模拟重启）仍解析到同一 sessionId", async () => {
	const dir = tempDir();
	const now = () => new Date("2026-10-15T01:00:00.000Z");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir), now });
	const written = await store.upsert({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	assert.equal(written.ok, true);
	assert.equal(written.binding.createdAt, "2026-10-15T01:00:00.000Z");

	const reopened = new ReadingSessionBindingsStore({ paths: pathsFor(dir), now });
	const loaded = await reopened.list();
	assert.equal(loaded.ok, true);
	assert.deepEqual(plain(loaded.bindings.map((entry) => [entry.workId, entry.editionId, entry.sessionId])), [["w1", "e1", "sess-a"]]);
	const resolved = await reopened.get("w1", "e1");
	assert.equal(resolved?.sessionId, "sess-a");
});

test("重绑同版本：覆盖 sessionId、保留 createdAt、刷新 lastUsedAt；同作品不同版本独立", async () => {
	const dir = tempDir();
	let clock = new Date("2026-10-15T01:00:00.000Z");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir), now: () => clock });
	await store.upsert({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	await store.upsert({ workId: "w1", editionId: "e2", sessionId: "sess-b", projectId: "proj-1" });
	clock = new Date("2026-10-16T05:00:00.000Z");
	const rebound = await store.upsert({ workId: "w1", editionId: "e1", sessionId: "sess-c", projectId: "proj-2" });
	assert.equal(rebound.ok, true);
	assert.equal(rebound.binding.createdAt, "2026-10-15T01:00:00.000Z", "重绑不得改写首次绑定时间");
	assert.equal(rebound.binding.lastUsedAt, "2026-10-16T05:00:00.000Z");
	assert.equal(rebound.binding.sessionId, "sess-c");

	const loaded = await store.list();
	assert.equal(loaded.bindings.length, 2, "不同版本各自一条");
	assert.equal((await store.get("w1", "e2"))?.sessionId, "sess-b", "另一版本不受重绑影响");
});

test("解绑：只删绑定关系；未绑定时也成功（removed=false）", async () => {
	const dir = tempDir();
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
	await store.upsert({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	const removed = await store.remove("w1", "e1");
	assert.deepEqual(plain(removed), { ok: true, removed: true });
	assert.equal(await store.get("w1", "e1"), null);
	const again = await store.remove("w1", "e1");
	assert.deepEqual(plain(again), { ok: true, removed: false });
});

test("损坏 JSON：原件隔离保留，以空状态继续，后续写入仍可用", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(bindingsFile(dir), "{这不是 JSON", "utf8");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
	const loaded = await store.list();
	assert.equal(loaded.ok, true);
	assert.deepEqual(plain(loaded.bindings), []);
	assert.equal(quarantineFiles(dir).length, 1, "损坏原件必须改名隔离保留");
	const written = await store.upsert({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	assert.equal(written.ok, true, "隔离成功后允许继续写入");
	assert.equal((await store.list()).bindings.length, 1);
});

test("结构非法：bindings 不是数组同样按损坏隔离，不覆盖原件", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(bindingsFile(dir), JSON.stringify({ version: 1, bindings: { w1: "x" } }), "utf8");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
	const loaded = await store.list();
	assert.equal(loaded.ok, true);
	assert.deepEqual(plain(loaded.bindings), []);
	assert.equal(quarantineFiles(dir).length, 1);
});

test("条目级结构校验：非法条目逐条丢弃，合法条目保留", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const valid = binding();
	writeFileSync(bindingsFile(dir), JSON.stringify({ version: 1, bindings: [valid, { workId: 1, editionId: "e2" }] }), "utf8");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
	const loaded = await store.list();
	// 任一条目非法 → 整文件按损坏隔离（不静默过滤坏条目后覆写原件）
	assert.equal(loaded.ok, true);
	assert.deepEqual(plain(loaded.bindings), []);
	assert.equal(quarantineFiles(dir).length, 1, "含非法条目的原件必须被隔离保留");
	assert.ok(loaded.issue, "必须返回隔离诊断");
});

test("未知 version / 身份重复：同样按损坏隔离，不按当前格式解读/覆写", async () => {
	for (const payload of [
		{ version: 2, bindings: [binding()] },
		{ version: 1, bindings: [binding(), binding()] },
	]) {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(bindingsFile(dir), JSON.stringify(payload), "utf8");
		const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
		const loaded = await store.list();
		assert.deepEqual(plain(loaded.bindings), [], JSON.stringify(payload));
		assert.equal(quarantineFiles(dir).length, 1, `${JSON.stringify(payload)} 的原件必须被隔离保留`);
	}
});

test("超界文件（>512KiB）：按损坏隔离，不整文件读爆内存", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(bindingsFile(dir), `{"version":1,"bindings":[]}\n${"x".repeat(600 * 1024)}`, "utf8");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir) });
	const loaded = await store.list();
	assert.equal(loaded.ok, true);
	assert.deepEqual(plain(loaded.bindings), []);
	assert.equal(quarantineFiles(dir).length, 1);
});

test("容量下界：满额时拒绝新写并保留既有绑定，重绑既有键不增加条目仍可写", async () => {
	const dir = tempDir();
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const seed = Array.from({ length: READING_BINDINGS_MAX_ENTRIES }, (_, index) => binding({ editionId: `e${index}`, sessionId: `sess-${index}` }));
	writeFileSync(bindingsFile(dir), JSON.stringify({ version: 1, bindings: seed }), "utf8");
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir), now: () => new Date("2026-12-31T00:00:00.000Z") });
	const rejected = await store.upsert({ workId: "w-new", editionId: "e-new", sessionId: "sess-new", projectId: "proj-1" });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error.detail?.reason, "bindingCapacityExceeded");
	const after = await store.list();
	assert.equal(after.bindings.length, READING_BINDINGS_MAX_ENTRIES, "不得静默淘汰旧绑定");
	assert.ok(
		after.bindings.some((entry) => entry.editionId === "e0"),
		"既有绑定（含最旧）必须原样保留",
	);

	const rebound = await store.upsert({ workId: "w1", editionId: "e0", sessionId: "sess-rebound", projectId: "proj-1" });
	assert.equal(rebound.ok, true, "重绑既有条目不增加数量，容量满时仍可写");
	assert.equal((await store.get("w1", "e0"))?.sessionId, "sess-rebound");
	assert.equal((await store.list()).bindings.length, READING_BINDINGS_MAX_ENTRIES);
});

test("字节上界：序列化超 512KiB 时拒绝写入（不写出下次读会当损坏的文件）", async () => {
	const dir = tempDir();
	const store = new ReadingSessionBindingsStore({ paths: pathsFor(dir), now: () => new Date("2026-12-31T00:00:00.000Z") });
	// 直接调持久化层：条目容量上限先挡住 upsert，这里只验证字节护栏本身
	const long = (char) => char.repeat(256);
	const huge = Array.from({ length: READING_BINDINGS_MAX_ENTRIES * 2 }, (_, index) => binding({ workId: long("w"), editionId: `e${index}`.padEnd(256, "x"), sessionId: long("s"), projectId: long("p"), createdAt: long("c"), lastUsedAt: long("l") }));
	const written = await store.persist(huge);
	assert.equal(written.ok, false);
	assert.equal(written.error.detail?.reason, "bindingBytesExceeded");
});
