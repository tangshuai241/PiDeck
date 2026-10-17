/**
 * CUA 截图落盘：内容寻址、数量上限、路径白名单。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { CuaFrameStore } = loadTsCommonJs("src/main/cua/CuaFrameStore.ts");

// 1×1 白色 PNG（合法且体积小，ImageBlobStore 会嗅探魔数）。
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("saves a screenshot as a content-addressed reference and resolves it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cua-frames-"));
	const store = new CuaFrameStore({ getFramesPath: () => dir });
	const ref = await store.save(PNG_BASE64, "image/png");
	assert.ok(ref);
	assert.match(ref, /^[0-9a-f]{64}\.png$/);
	assert.deepStrictEqual(readdirSync(dir), [ref]);
	assert.strictEqual(store.resolvePath(ref), join(dir, ref));
	// 同一张图再存一次按内容去重，不产生第二份文件。
	const again = await store.save(PNG_BASE64, "image/png");
	assert.strictEqual(again, ref);
	assert.strictEqual(readdirSync(dir).length, 1);
});

test("rejects invalid base64 and never escapes the frames directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cua-frames-"));
	const store = new CuaFrameStore({ getFramesPath: () => dir });
	assert.strictEqual(await store.save("not base64!!", "image/png"), null);
	assert.strictEqual(store.resolvePath("../settings.json"), null);
	assert.strictEqual(store.resolvePath("a".repeat(64) + ".jpg"), join(dir, "a".repeat(64) + ".jpg"));
});

test("prunes to the configured maximum, keeping the most recently used files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cua-frames-"));
	const store = new CuaFrameStore({ getFramesPath: () => dir, maxFrames: 2 });
	const first = await store.save(PNG_BASE64, "image/png");
	assert.ok(first);
	// save() 会触发一次后台 prune；等它结束再构造上限场景，避免与 pruning 去重标志竞态。
	await new Promise((resolve) => setTimeout(resolve, 100));
	// 造两个更旧/更新的文件：内容不同（用两个字节不同的合法 PNG 太麻烦，
	// 直接写入白名单命名的文件，prune 只按 mtime 决策）。
	const second = "b".repeat(64) + ".jpg";
	const third = "c".repeat(64) + ".jpg";
	const old = new Date(Date.now() - 60_000);
	writeFileSync(join(dir, second), Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
	writeFileSync(join(dir, third), Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
	const { utimesSync } = await import("node:fs");
	utimesSync(join(dir, first), old, old);
	utimesSync(join(dir, second), old, old);

	const removed = await store.prune();
	assert.strictEqual(removed, 1);
	const remaining = readdirSync(dir).sort();
	assert.strictEqual(remaining.length, 2);
	assert.ok(!remaining.includes(first), "oldest file removed");
	assert.ok(remaining.includes(third));
});
