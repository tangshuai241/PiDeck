/**
 * 帧缓存边界：有上限、会过期、可整体释放（不保留无限历史帧）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { CuaFrameRegistry } = loadTsCommonJs("src/main/cua/CuaFrames.ts");

function geometry(frameId) {
	return {
		frameId,
		displayId: "display-1",
		sourceId: "screen:1:0",
		screenRect: { x: 0, y: 0, width: 2560, height: 1440 },
		sourceWidth: 2560,
		sourceHeight: 1440,
		imageWidth: 1280,
		imageHeight: 720,
		capturedAtMs: 1,
		rotation: 0,
	};
}

test("keeps at most maxFrames and evicts the oldest", () => {
	let now = 1000;
	const registry = new CuaFrameRegistry({ maxFrames: 2, ttlMs: 10_000, now: () => now });
	registry.register({ geometry: geometry("a"), nativeJpeg: Buffer.from("a") });
	now += 1;
	registry.register({ geometry: geometry("b"), nativeJpeg: Buffer.from("b") });
	now += 1;
	registry.register({ geometry: geometry("c"), nativeJpeg: Buffer.from("c") });

	assert.strictEqual(registry.size(), 2);
	assert.strictEqual(registry.get("a"), undefined, "oldest frame evicted");
	assert.ok(registry.get("b"));
	assert.ok(registry.get("c"));
});

test("expires frames after ttl and reports a miss instead of stale geometry", () => {
	let now = 1000;
	const registry = new CuaFrameRegistry({ maxFrames: 4, ttlMs: 500, now: () => now });
	registry.register({ geometry: geometry("old"), nativeJpeg: Buffer.from("x") });
	now += 400;
	assert.strictEqual(registry.size(), 1, "still inside ttl (size(), not get(), so the ttl is not refreshed)");
	now += 200;
	assert.strictEqual(registry.get("old"), undefined, "expired");
	assert.strictEqual(registry.size(), 0);
});

test("reading a frame refreshes its ttl so a used frame outlives an untouched one", () => {
	let now = 1000;
	const registry = new CuaFrameRegistry({ maxFrames: 2, ttlMs: 500, now: () => now });
	registry.register({ geometry: geometry("a"), nativeJpeg: Buffer.from("a") });
	now = 1400;
	registry.register({ geometry: geometry("b"), nativeJpeg: Buffer.from("b") });
	now = 1450;
	assert.ok(registry.get("a"), "read refreshes a");
	now = 1950;
	// 截止时刻 1450：b（1400 登记）过期，a（1450 刚读过）仍可用。
	assert.strictEqual(registry.get("b"), undefined, "untouched frame expired");
	assert.ok(registry.get("a"), "refreshed frame survives");
	assert.strictEqual(registry.size(), 1);
});

test("dispose clears every cached frame", () => {
	const registry = new CuaFrameRegistry({ maxFrames: 4, ttlMs: 10_000 });
	registry.register({ geometry: geometry("a"), nativeJpeg: Buffer.from("a") });
	registry.register({ geometry: geometry("b"), nativeJpeg: Buffer.from("b") });
	registry.dispose();
	assert.strictEqual(registry.size(), 0);
	assert.strictEqual(registry.get("a"), undefined);
});
