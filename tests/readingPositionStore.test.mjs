/**
 * 阅读位置存储窄测（P03）：往返/幂等、原子写失败、损坏隔离与禁止覆盖、字节上界、备份原件。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ReadingPositionStore } = loadTsCommonJs("src/main/personal-workbench/reading/ReadingPositionStore.ts");
const { resolveReadingPaths } = loadTsCommonJs("src/main/personal-workbench/reading/readingPaths.ts");

const FIXED = "2026-10-14T00:00:00.000Z";
const QUARANTINE_SUFFIX = "2026-10-14T00-00-00-000Z";

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-reading-pos-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeStore(dir, options = {}) {
	const paths = resolveReadingPaths(dir);
	return { paths, store: new ReadingPositionStore({ paths, now: () => new Date(FIXED), ...options }) };
}

function position(overrides = {}) {
	return { workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.5, spineHref: "ch1.xhtml", chapterNum: 1, chapterTextDigest: "d1", source: "reader", savedAt: FIXED, ...overrides };
}

test("位置往返与幂等：同值不重复写，变化写并留 .bak 原件", async (t) => {
	const dir = tempDir(t);
	const { paths, store } = makeStore(dir);
	const created = await store.save(position());
	assert.deepEqual({ ok: created.ok, idempotent: created.idempotent }, { ok: true, idempotent: false }, "首次写入不是幂等命中");
	const file = join(paths.positionsDir, "edn_1.json");
	const firstBytes = readFileSync(file, "utf8");
	const same = await store.save(position());
	assert.deepEqual({ ok: same.ok, idempotent: same.idempotent }, { ok: true, idempotent: true });
	assert.equal(readFileSync(file, "utf8"), firstBytes, "同值不重写（时间戳不变）");
	const changed = await store.save(position({ fraction: 0.75 }));
	assert.deepEqual({ ok: changed.ok, idempotent: changed.idempotent }, { ok: true, idempotent: false });
	assert.equal(readFileSync(`${file}.bak`, "utf8"), firstBytes, "替换前留 .bak 原件");
	const loaded = await store.load("edn_1");
	assert.equal(loaded.value.fraction, 0.75);
	assert.equal(loaded.issue, null);
});

test("原子写失败：positions 目录位被文件占用时结构化失败，不产生半成品", async (t) => {
	const dir = tempDir(t);
	const { paths, store } = makeStore(dir);
	mkdirSync(join(paths.dataDir), { recursive: true });
	writeFileSync(join(paths.dataDir, "positions"), "not-a-dir");
	const outcome = await store.save(position());
	assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: "writeFailed" });
	assert.equal(existsSync(join(paths.dataDir, "positions", "edn_1.json")), false);
});

test("损坏保护：坏 JSON 隔离原件、不丢 bytes；隔离后可继续写", async (t) => {
	const dir = tempDir(t);
	const { paths, store } = makeStore(dir);
	mkdirSync(paths.positionsDir, { recursive: true });
	const file = join(paths.positionsDir, "edn_1.json");
	const raw = "{ broken position";
	writeFileSync(file, raw, "utf8");
	const loaded = await store.load("edn_1");
	assert.equal(loaded.value, null);
	assert.equal(loaded.issue.code, "invalidJson");
	assert.equal(loaded.issue.quarantinePath, `${file}.corrupt-${QUARANTINE_SUFFIX}`);
	assert.equal(readFileSync(loaded.issue.quarantinePath, "utf8"), raw, "原 bytes 完整保留");
	assert.equal(existsSync(file), false, "损坏原件已从主路径移开");
	assert.equal((await store.save(position())).ok, true, "隔离后可重新写入");
});

test("隔离失败即禁止覆盖：原文件保留且 save 返回 blocked", async (t) => {
	const dir = tempDir(t);
	const { paths, store } = makeStore(dir);
	mkdirSync(paths.positionsDir, { recursive: true });
	const file = join(paths.positionsDir, "edn_1.json");
	const raw = JSON.stringify({ version: 1, bad: true });
	writeFileSync(file, raw, "utf8");
	mkdirSync(`${file}.corrupt-${QUARANTINE_SUFFIX}`);
	const loaded = await store.load("edn_1");
	assert.equal(loaded.issue.blocked, true);
	assert.equal(loaded.issue.quarantinePath, null);
	const outcome = await store.save(position());
	assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: "blocked" });
	assert.equal(readFileSync(file, "utf8"), raw, "损坏原件未被覆盖");
});

test("结构非法与字节上界都按损坏处理，不当空覆盖", async (t) => {
	const dir = tempDir(t);
	const { paths, store } = makeStore(dir);
	mkdirSync(paths.positionsDir, { recursive: true });
	writeFileSync(join(paths.positionsDir, "edn_1.json"), JSON.stringify({ version: 1, editionId: "edn_1", workId: "wrk_a", contentVersion: "cv1", fraction: 2, savedAt: FIXED }));
	const loaded = await store.load("edn_1");
	assert.equal(loaded.value, null);
	assert.equal(loaded.issue.code, "invalidStructure");
	const bigDir = tempDir(t);
	const big = makeStore(bigDir, { maxBytes: 64 });
	mkdirSync(big.paths.positionsDir, { recursive: true });
	writeFileSync(join(big.paths.positionsDir, "edn_9.json"), JSON.stringify({ version: 1, note: "x".repeat(256) }));
	const bounded = await big.store.load("edn_9");
	assert.equal(bounded.issue.code, "tooLarge");
});
