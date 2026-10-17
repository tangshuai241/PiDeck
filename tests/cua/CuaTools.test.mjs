/**
 * CUA 工具面测试（不经 Electron）：真实注册表 + 替身 engine/screen。
 *
 * 覆盖 C1 的三个关键契约：
 * 1. 带 frameId 的点击/滚动把图像坐标换算成物理坐标，只取整一次；
 * 2. 不带 frameId 的旧调用原样按绝对屏幕坐标执行，不做二次缩放；
 * 3. capture/zoom 返回几何与 tpaCua 记录，frame 过期时明确报错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { registerCuaTools } = loadTsCommonJs("src/main/cua/CuaTools.ts");

const FRAME_GEOMETRY = {
	frameId: "frame-a",
	displayId: "display-primary",
	sourceId: "screen:1:0",
	screenRect: { x: 0, y: 0, width: 2560, height: 1440 },
	sourceWidth: 2560,
	sourceHeight: 1440,
	imageWidth: 1280,
	imageHeight: 720,
	capturedAtMs: 1790000000000,
	rotation: 0,
};

function createHarness({ frame = FRAME_GEOMETRY, captureResult, zoomResult } = {}) {
	const calls = { clicks: [], doubleClicks: [], scrolls: [], types: [], captures: [], zooms: [] };
	const handlers = new Map();
	const server = {
		registerTool: (name, definition, handler) => {
			handlers.set(name, { definition, handler });
		},
	};
	const engine = {
		click: async (sessionId, x, y, button) => {
			calls.clicks.push({ sessionId, x, y, button });
			return { sent: 3, gateDecision: "allowed", target: { title: "测试窗口", hwnd: 42, rect: { x: 0, y: 0, width: 100, height: 100 } } };
		},
		doubleClick: async (sessionId, x, y, button) => {
			calls.doubleClicks.push({ sessionId, x, y, button });
			return { sent: 6, gateDecision: "allowed" };
		},
		scroll: async (sessionId, x, y, deltaY, deltaX) => {
			calls.scrolls.push({ sessionId, x, y, deltaY, deltaX });
			return { sent: 2, gateDecision: "allowed" };
		},
		type: async (sessionId, params) => {
			calls.types.push({ sessionId, params });
			return { sent: 22, gateDecision: "auto_approve" };
		},
		listWindows: () => [],
		getDisplay: () => ({ width: 2560, height: 1440 }),
		getForegroundWindow: () => undefined,
	};
	const gate = { isEnabled: () => true, isSessionEnabled: () => true, isAutoApprove: () => true };
	const screen = {
		listDisplays: () => [{ displayId: "display-primary", primary: true, screenRect: FRAME_GEOMETRY.screenRect }],
		getFrame: (frameId) => (frameId === frame.frameId ? { geometry: frame, nativeJpeg: Buffer.from("x"), screenshotRef: "b".repeat(64) + ".jpg" } : undefined),
		capture: async (options) => {
			calls.captures.push(options);
			return captureResult ?? { frame: { width: 1280, height: 720, displayId: "display-primary", sourceId: "screen:1:0", base64: "AAAA", mimeType: "image/jpeg", timestampMs: FRAME_GEOMETRY.capturedAtMs, durationMs: 100 }, geometry: FRAME_GEOMETRY, screenshotRef: "c".repeat(64) + ".jpg" };
		},
		zoom: async (options) => {
			calls.zooms.push(options);
			return (
				zoomResult ?? {
					ok: true,
					data: Buffer.from("crop"),
					width: 400,
					height: 240,
					geometry: { ...FRAME_GEOMETRY, frameId: "frame-crop", parentFrameId: "frame-a", crop: { x: 200, y: 200, width: 200, height: 120 }, screenRect: { x: 400, y: 400, width: 400, height: 240 }, imageWidth: 400, imageHeight: 240 },
					parentFrameId: "frame-a",
					screenshotRef: "d".repeat(64) + ".jpg",
				}
			);
		},
	};
	registerCuaTools(server, engine, gate, screen);
	const call = async (name, args) => {
		const entry = handlers.get(name);
		assert.ok(entry, `tool ${name} registered`);
		const result = await entry.handler(args);
		const text = result.content.find((item) => item.type === "text")?.text;
		return { result, json: text ? JSON.parse(text) : undefined };
	};
	return { calls, handlers, call };
}

test("registers the seven CUA tools including cua_zoom", () => {
	const { handlers } = createHarness();
	assert.deepStrictEqual([...handlers.keys()].sort(), ["cua_capture", "cua_click", "cua_get_state", "cua_list_windows", "cua_scroll", "cua_type", "cua_zoom"]);
});

test("frame-based click maps image pixels to physical screen pixels (single rounding)", async () => {
	const { calls, call } = createHarness();
	const { json, result } = await call("cua_click", { x: 640, y: 360, frameId: "frame-a", button: "left", double: false, sessionId: "s1" });

	assert.strictEqual(result.isError, false);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.clicks[0])), { sessionId: "s1", x: 1280, y: 720, button: "left" });
	assert.strictEqual(json.sent, 3);
	assert.strictEqual(json.coordinateSpace, "image");
	assert.deepStrictEqual(json.imagePoint, { x: 640, y: 360 });
	assert.deepStrictEqual(json.screenPoint, { x: 1280, y: 720 });
	assert.strictEqual(json.tpaCua.action, "click");
	assert.strictEqual(json.tpaCua.frame.frameId, "frame-a");
	assert.strictEqual(json.tpaCua.frame.screenshotRef, "b".repeat(64) + ".jpg");
	assert.strictEqual(json.tpaCua.input.coordinateSpace, "image");
	assert.strictEqual(json.tpaCua.receipt.sent, 3);
	assert.strictEqual(json.tpaCua.effect, "unverified");
});

test("legacy click without frameId passes absolute screen coordinates unchanged", async () => {
	const { calls, call } = createHarness();
	const { json } = await call("cua_click", { x: 375, y: 638, button: "left", double: false, sessionId: "s1" });

	assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.clicks[0])), { sessionId: "s1", x: 375, y: 638, button: "left" });
	assert.strictEqual(json.coordinateSpace, "screen");
	assert.deepStrictEqual(json.screenPoint, { x: 375, y: 638 });
	assert.strictEqual(json.imagePoint, undefined);
	// 不做第二次缩放：给多少就是多少。
	assert.strictEqual(json.tpaCua.input.screenPoint.x, 375);
});

test("a missing or out-of-range frame is an explicit error and never injects input", async () => {
	const { calls, call } = createHarness();
	const missing = await call("cua_click", { x: 10, y: 10, frameId: "expired", sessionId: "s1" });
	assert.strictEqual(missing.result.isError, true);
	assert.match(missing.json.error, /frame-not-found/);
	assert.strictEqual(calls.clicks.length, 0);

	const outside = await call("cua_click", { x: 2000, y: 10, frameId: "frame-a", sessionId: "s1" });
	assert.strictEqual(outside.result.isError, true);
	assert.match(outside.json.error, /point-out-of-bounds/);
	assert.strictEqual(calls.clicks.length, 0);
});

test("scroll uses the same coordinate resolution and returns the injected point", async () => {
	const { calls, call } = createHarness();
	const { json } = await call("cua_scroll", { x: 100, y: 50, frameId: "frame-a", deltaY: -120, deltaX: 0, sessionId: "s1" });

	assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.scrolls[0])), { sessionId: "s1", x: 200, y: 100, deltaY: -120, deltaX: 0 });
	assert.strictEqual(json.tpaCua.action, "scroll");
	assert.deepStrictEqual(json.tpaCua.input.screenPoint, { x: 200, y: 100 });
	assert.strictEqual(json.tpaCua.input.deltaY, -120);
});

test("capture returns geometry + tpaCua and keeps the legacy width/height/displayId fields", async () => {
	const { calls, call } = createHarness();
	const { json, result } = await call("cua_capture", { maxLongEdge: 1280, quality: 75 });

	assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.captures[0])), { maxLongEdge: 1280, quality: 75 });
	assert.strictEqual(json.width, 1280);
	assert.strictEqual(json.height, 720);
	assert.strictEqual(json.displayId, "display-primary");
	assert.strictEqual(json.frameId, "frame-a");
	assert.deepStrictEqual(json.screenRect, { x: 0, y: 0, width: 2560, height: 1440 });
	assert.strictEqual(json.coordinateSpace, "image");
	assert.strictEqual(json.screenshotRef, "c".repeat(64) + ".jpg");
	assert.strictEqual(json.tpaCua.action, "capture");
	assert.strictEqual(json.tpaCua.frame.frameId, "frame-a");
	// 图像块在文本之前，模型先看图再读几何。
	assert.strictEqual(result.content[0].type, "image");
});

test("zoom returns the cropped frame geometry and its parent frame", async () => {
	const { calls, call } = createHarness();
	const { json, result } = await call("cua_zoom", { frameId: "frame-a", x: 200, y: 200, width: 200, height: 120, maxLongEdge: 1600, quality: 85 });

	assert.strictEqual(result.isError, false);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.zooms[0])), { frameId: "frame-a", region: { x: 200, y: 200, width: 200, height: 120 }, maxLongEdge: 1600, quality: 85 });
	assert.strictEqual(json.frameId, "frame-crop");
	assert.strictEqual(json.parentFrameId, "frame-a");
	assert.deepStrictEqual(json.screenRect, { x: 400, y: 400, width: 400, height: 240 });
	assert.deepStrictEqual(json.crop, { x: 200, y: 200, width: 200, height: 120 });
	assert.strictEqual(json.tpaCua.action, "zoom");
	assert.strictEqual(json.tpaCua.frame.parentFrameId, "frame-a");
	assert.strictEqual(result.content[0].type, "image");
});

test("zoom payload reports native source size even when the delivered crop was downscaled", async () => {
	const { call } = createHarness({
		zoomResult: {
			ok: true,
			data: Buffer.from("crop"),
			width: 100,
			height: 60,
			geometry: { ...FRAME_GEOMETRY, frameId: "frame-crop", parentFrameId: "frame-a", crop: { x: 200, y: 200, width: 200, height: 120 }, screenRect: { x: 400, y: 400, width: 400, height: 240 }, imageWidth: 100, imageHeight: 60, sourceWidth: 400, sourceHeight: 240 },
			parentFrameId: "frame-a",
		},
	});
	const { json } = await call("cua_zoom", { frameId: "frame-a", x: 200, y: 200, width: 200, height: 120, maxLongEdge: 100, quality: 85 });
	assert.strictEqual(json.imageWidth, 100);
	assert.strictEqual(json.imageHeight, 60);
	// 后续 zoom 的裁剪坐标系：原生尺寸，不是缩小后的交付尺寸。
	assert.strictEqual(json.sourceWidth, 400);
	assert.strictEqual(json.sourceHeight, 240);
	assert.strictEqual(json.tpaCua.frame.sourceWidth, 400);
});

test("zoom failure is reported as an error result without an image block", async () => {
	const { call } = createHarness({ zoomResult: { ok: false, reason: "frame-not-found", message: "expired" } });
	const { json, result } = await call("cua_zoom", { frameId: "gone", x: 0, y: 0, width: 10, height: 10, maxLongEdge: 1600, quality: 85 });
	assert.strictEqual(result.isError, true);
	assert.match(json.error, /frame-not-found/);
	assert.strictEqual(json.tpaCua.action, "zoom");
	assert.strictEqual(result.content.length, 1);
});

test("get_state includes the display list so coordinate spaces are discoverable", async () => {
	const { call } = createHarness();
	const { json } = await call("cua_get_state", { includeDisplays: true });
	assert.strictEqual(json.displays.length, 1);
	assert.deepStrictEqual(json.displays[0].screenRect, { x: 0, y: 0, width: 2560, height: 1440 });
	assert.strictEqual(json.display.width, 2560);
});
