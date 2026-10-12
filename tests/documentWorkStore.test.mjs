/**
 * 持久化存储：原子写入失败、重启恢复、requestId 去重与冲突、并发修改只成功一次、
 * 损坏记录不丢原件。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryWorkFs } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");

const INDEX_PATH = "/data/index.json";
/** 工作文件路径由 workId 推导，不硬编码（避免 ID 生成策略变化后测试静默失效）。 */
const workPath = (workId) => `/data/works/${workId}.json`;

function createStore(overrides = {}) {
	const fs = createMemoryWorkFs(overrides.faults);
	let counter = 0;
	const store = new DocumentWorkStore({
		dir: "/data",
		fs,
		now: () => 1000,
		newId: (prefix) => `${prefix}_${++counter}`,
	});
	return { store, fs };
}

function registerRoot(store, path = "C:/out") {
	const root = store.registerOutputRoot({ path, label: "out" });
	assert.equal(root.ok, true);
	return root.value.outputRootId;
}

function createWork(store, outputRootId, overrides = {}) {
	return store.createWork({ requestId: "req_1", requestDigest: "digest-1", sessionId: "session-1", sourceTurnId: "turn_1", title: "draft", outputRootId, ...overrides });
}

test("登记输出根复用同一路径，未登记的根不能建工作", () => {
	const { store } = createStore();
	const first = store.registerOutputRoot({ path: "C:/out", label: "out" });
	const second = store.registerOutputRoot({ path: "C:/out", label: "out-again" });
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.value.outputRootId, second.value.outputRootId);
	const rejected = createWork(store, "root_missing");
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error.code, "PATH_DENIED");
});

test("首次提交允许先不绑定成果目录，绑定后再建", () => {
	const { store } = createStore();
	const created = createWork(store, "");
	assert.equal(created.ok, true);
	assert.equal(created.value.outputRootId, "");
	const rootId = registerRoot(store);
	const bound = store.withWork(created.value.workId, created.value.revision, (bucket) => ({ ok: true, value: { bucket: { ...bucket, record: { ...bucket.record, outputRootId: rootId } }, value: bucket.record } }));
	assert.equal(bound.ok, true);
	assert.equal(store.readWork(created.value.workId).value.record.outputRootId, rootId);
});

test("原子写入失败时不留下半截记录，并返回结构化错误", () => {
	const { store, fs } = createStore();
	const rootId = registerRoot(store);
	// 第 2 次 newId 就是工作 ID；把它的临时文件写入打掉。
	fs.faults.write.add(workPath("work_2"));
	fs.faults.write.add(`${workPath("work_2")}.tmp`);
	const created = createWork(store, rootId);
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "IO_ERROR");
	assert.equal(fs.exists(workPath("work_2")), false);
	// 索引也必须能重新读出来（没有半截 JSON）。
	assert.ok(store.listOutputRoots().length >= 1);
});

test("重启后从磁盘恢复工作记录与幂等台账", () => {
	const { store, fs } = createStore();
	const rootId = registerRoot(store);
	const created = createWork(store, rootId);
	assert.equal(created.ok, true);
	assert.ok(fs.exists(INDEX_PATH));
	const restarted = new DocumentWorkStore({ dir: "/data", fs, now: () => 2000, newId: (prefix) => `${prefix}_restart` });
	const reloaded = restarted.readWork(created.value.workId);
	assert.equal(reloaded.ok, true);
	assert.equal(reloaded.value.record.sessionId, "session-1");
	// 同一个 requestId + 同一载荷返回原记录，不新建。
	const again = createWork(restarted, rootId);
	assert.equal(again.ok, true);
	assert.equal(again.value.workId, created.value.workId);
	assert.equal(restarted.listWorkIds().length, 1);
});

test("同 requestId 不同载荷返回 IDEMPOTENCY_CONFLICT，不换 ID 重放", () => {
	const { store } = createStore();
	const rootId = registerRoot(store);
	createWork(store, rootId);
	// 同 requestId、不同载荷：载荷指纹由调用方（服务层）算好，这里直接给出不同的指纹。
	const conflicting = createWork(store, rootId, { title: "something else", requestDigest: "digest-2" });
	assert.equal(conflicting.ok, false);
	assert.equal(conflicting.error.code, "IDEMPOTENCY_CONFLICT");
	// 台账里仍只有一件工作。
	assert.equal(store.listWorkIds().length, 1);
});

test("并发修改只有一个匹配 expectedRevision，另一个收到 REVISION_CONFLICT", () => {
	const { store } = createStore();
	const rootId = registerRoot(store);
	const created = createWork(store, rootId);
	const revision = created.value.revision;
	const first = store.withWork(created.value.workId, revision, (bucket) => ({ ok: true, value: { bucket: { ...bucket, record: { ...bucket.record, title: "first" } }, value: "first" } }));
	const second = store.withWork(created.value.workId, revision, (bucket) => ({ ok: true, value: { bucket: { ...bucket, record: { ...bucket.record, title: "second" } }, value: "second" } }));
	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "REVISION_CONFLICT");
	assert.equal(second.error.currentRevision, revision + 1);
	assert.equal(store.readWork(created.value.workId).value.record.title, "first");
});

test("损坏记录：保留原文件、停止写入、返回结构化错误", () => {
	const { store, fs } = createStore();
	const rootId = registerRoot(store);
	const created = createWork(store, rootId);
	const path = workPath(created.value.workId);
	fs.writeFile(path, "{not json}");
	const read = store.readWork(created.value.workId);
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "IO_ERROR");
	assert.equal(fs.exists(path), true, "原文件必须保留");
	const write = store.withWork(created.value.workId, 0, (bucket) => ({ ok: true, value: { bucket: { ...bucket, record: { ...bucket.record, title: "x" } }, value: "x" } }));
	assert.equal(write.ok, false);
});

test("主文件损坏但有可解析的 .bak 时只做只读展示，不原位修复", () => {
	const { store, fs } = createStore();
	const rootId = registerRoot(store);
	const created = createWork(store, rootId);
	const path = workPath(created.value.workId);
	const backup = Buffer.from(fs.readFile(path));
	fs.writeFile(`${path}.bak`, backup.toString("utf8"));
	fs.writeFile(path, "{truncated");
	// 关键语义：**不自动修复**。损坏文件原样保留，旧内容只作只读展示，
	// 这样一次自动修复不会把旧授权"恢复"回来。
	const read = store.readWork(created.value.workId);
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "IO_ERROR");
	assert.equal(fs.readFile(path).toString("utf8").includes("{truncated"), true, "损坏文件必须原样保留");
	const display = store.readWorkForDisplay(created.value.workId);
	assert.equal(display.corrupt?.repairedFromBackup, true);
	assert.equal(display.record?.workId, created.value.workId);
});

test("未知 schemaVersion 的记录视为损坏，不补齐字段", () => {
	const { store, fs } = createStore();
	const rootId = registerRoot(store);
	const created = createWork(store, rootId);
	const path = workPath(created.value.workId);
	const record = JSON.parse(fs.readFile(path).toString("utf8"));
	record.schemaVersion = 99;
	fs.writeFile(path, JSON.stringify(record));
	const read = store.readWork(created.value.workId);
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "IO_ERROR");
});
