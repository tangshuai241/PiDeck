/**
 * CuaScreen 装配测试：用替身替换 CuaFrame（真实截图需要 Electron）与 CuaDisplays，
 * 断言「请求显示器物理尺寸」「几何合成」「局部队列与清理」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

function makeFrame(overrides = {}) {
	return {
		data: Buffer.from("jpeg-delivered"),
		base64: Buffer.from("jpeg-delivered").toString("base64"),
		mimeType: "image/jpeg",
		width: 1280,
		height: 720,
		sourceWidth: 2560,
		sourceHeight: 1440,
		sourceId: "screen:1:0",
		displayId: "display-primary",
		timestampMs: 1790000000000,
		durationMs: 120,
		nativeJpeg: Buffer.from("jpeg-native"),
		...overrides,
	};
}

const primaryDisplay = {
	displayId: "display-primary",
	label: "H27T22",
	primary: true,
	dipBounds: { x: 0, y: 0, width: 2048, height: 1152 },
	scaleFactor: 1.25,
	dpi: 120,
	screenRect: { x: 0, y: 0, width: 2560, height: 1440 },
	rotation: 0,
	rectSource: "win32-monitor",
};

const secondaryDisplay = {
	displayId: "display-secondary",
	label: "",
	primary: false,
	dipBounds: { x: -1707, y: 0, width: 1707, height: 1067 },
	scaleFactor: 1.5,
	dpi: 144,
	screenRect: { x: -2560, y: 0, width: 2560, height: 1600 },
	rotation: 0,
	rectSource: "win32-monitor",
};

/**
 * cropNativeJpeg 替身：按真实语义返回「交付图（受 maxLongEdge 限制）」与「原生图（不缩小）」两份。
 * 这样连续 zoom 用例才能区分「从原生裁剪」和「从缩小图裁剪」。
 */
function fakeCropNativeJpeg(buffer, rect, options = {}) {
	const nativeWidth = Math.round(rect.width);
	const nativeHeight = Math.round(rect.height);
	if (nativeWidth <= 0 || nativeHeight <= 0) return null;
	const maxLongEdge = options.maxLongEdge ?? 1600;
	const longEdge = Math.max(nativeWidth, nativeHeight);
	if (longEdge <= maxLongEdge) {
		const data = Buffer.from(`native-${nativeWidth}x${nativeHeight}`);
		return { data, width: nativeWidth, height: nativeHeight, nativeData: data, nativeWidth, nativeHeight };
	}
	const scale = maxLongEdge / longEdge;
	const width = Math.max(1, Math.round(nativeWidth * scale));
	const height = Math.max(1, Math.round(nativeHeight * scale));
	return { data: Buffer.from(`delivered-${width}x${height}`), width, height, nativeData: Buffer.from(`native-${nativeWidth}x${nativeHeight}`), nativeWidth, nativeHeight };
}

function loadScreen() {
	return loadTsCommonJs("src/main/cua/CuaScreen.ts", {
		stubs: {
			"./CuaFrame": {
				captureScreen: async () => makeFrame(),
				cropNativeJpeg: fakeCropNativeJpeg,
				DEFAULT_NATIVE_QUALITY: 92,
			},
			"./CuaDisplays": {
				listCuaDisplays: () => [primaryDisplay, secondaryDisplay],
				findCuaDisplay: (displays, displayId) => (displayId ? displays.find((display) => display.displayId === displayId) : displays.find((display) => display.primary)),
			},
		},
	});
}

test("capture requests the display's physical size and returns full geometry", async () => {
	const requested = [];
	const { CuaScreen } = loadTsCommonJs("src/main/cua/CuaScreen.ts", {
		stubs: {
			"./CuaFrame": {
				captureScreen: async (options) => {
					requested.push(options);
					return makeFrame();
				},
				cropNativeJpeg: () => null,
				DEFAULT_NATIVE_QUALITY: 92,
			},
			"./CuaDisplays": {
				listCuaDisplays: () => [primaryDisplay, secondaryDisplay],
				findCuaDisplay: (displays, displayId) => (displayId ? displays.find((display) => display.displayId === displayId) : displays.find((display) => display.primary)),
			},
		},
	});
	const screen = new CuaScreen({ saveScreenshot: async () => "a".repeat(64) + ".jpg" });
	const outcome = await screen.capture({ maxLongEdge: 1280 });

	assert.deepStrictEqual(JSON.parse(JSON.stringify(requested[0].requestSize)), { width: 2560, height: 1440 });
	assert.strictEqual(requested[0].displayId, "display-primary");
	assert.strictEqual(requested[0].keepNativeJpeg, true);
	assert.strictEqual(outcome.geometry.displayId, "display-primary");
	assert.strictEqual(outcome.geometry.sourceId, "screen:1:0");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(outcome.geometry.screenRect)), { x: 0, y: 0, width: 2560, height: 1440 });
	assert.deepStrictEqual({ width: outcome.geometry.imageWidth, height: outcome.geometry.imageHeight }, { width: 1280, height: 720 });
	assert.strictEqual(outcome.screenshotRef, "a".repeat(64) + ".jpg");
	// 帧已登记，点击可以用 frameId 引用。
	assert.ok(screen.getFrame(outcome.geometry.frameId));
});

test("capture accepts a legacy source id when a resolver is provided", async () => {
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen({ resolveDisplayIdFromSource: async (sourceId) => (sourceId === "screen:1:0" ? "display-primary" : undefined) });
	const outcome = await screen.capture({ displayId: "screen:1:0" });
	assert.strictEqual(outcome.geometry.displayId, "display-primary");
});

test("capture rejects an unknown display id instead of silently using the primary", async () => {
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen();
	await assert.rejects(() => screen.capture({ displayId: "nope" }), /Unknown displayId/);
});

test("zoom crops the registered native capture and maps the child frame back to the screen", async () => {
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen();
	const captured = await screen.capture();
	const parent = captured.geometry;

	const zoomed = await screen.zoom({ frameId: parent.frameId, region: { x: 200, y: 200, width: 200, height: 120 } });
	assert.strictEqual(zoomed.ok, true);
	if (!zoomed.ok) return;

	// 父帧 1280×720 覆盖 2560×1440：图像 (200,200)-(400,320) → 物理 (400,400) 400×240。
	assert.deepStrictEqual(JSON.parse(JSON.stringify(zoomed.geometry.screenRect)), { x: 400, y: 400, width: 400, height: 240 });
	assert.strictEqual(zoomed.geometry.parentFrameId, parent.frameId);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(zoomed.geometry.crop)), { x: 200, y: 200, width: 200, height: 120 });
	assert.strictEqual(zoomed.parentFrameId, parent.frameId);
	// 子帧也进了缓存，后续点击可以直接用它。
	assert.ok(screen.getFrame(zoomed.geometry.frameId));
});

test("consecutive zooms keep native detail instead of cropping the downscaled delivery", async () => {
	// 回归（复核复现）：第一次 zoom 的交付图被缩小后，若把它当子帧的原生裁剪源，
	// 第二次 zoom 只能从缩小图裁，细节逐级丢失。这里锁定两条路径得到相同原生尺寸。
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen();
	const captured = await screen.capture();
	const parent = captured.geometry;

	// 路径 A：直接从原帧裁剪同一区域（1280×720 图上 (100,100)-(300,300) → 原生 400×400）。
	const direct = await screen.zoom({ frameId: parent.frameId, region: { x: 100, y: 100, width: 200, height: 200 }, maxLongEdge: 640 });
	assert.strictEqual(direct.ok, true);
	if (!direct.ok) return;
	// 400×400 未超过 maxLongEdge=640：不放大，交付图 = 原生 400×400。
	assert.deepStrictEqual({ width: direct.geometry.imageWidth, height: direct.geometry.imageHeight }, { width: 400, height: 400 });
	assert.deepStrictEqual({ width: direct.geometry.sourceWidth, height: direct.geometry.sourceHeight }, { width: 400, height: 400 });
	assert.deepStrictEqual({ width: direct.width, height: direct.height }, { width: 400, height: 400 });

	// 路径 B：先输出一张缩小到 200×200 的局部帧，再从该子帧裁同一块屏幕区域。
	const first = await screen.zoom({ frameId: parent.frameId, region: { x: 100, y: 100, width: 200, height: 200 }, maxLongEdge: 200 });
	assert.strictEqual(first.ok, true);
	if (!first.ok) return;
	assert.deepStrictEqual({ width: first.geometry.imageWidth, height: first.geometry.imageHeight }, { width: 200, height: 200 });
	// 子帧的原生尺寸仍是 400×400（不是被缩小的 200×200）。
	assert.deepStrictEqual({ width: first.geometry.sourceWidth, height: first.geometry.sourceHeight }, { width: 400, height: 400 });

	// 子帧图像 200×200 覆盖同一物理区域；取它的整幅再放大，应仍拿到 400×400 原生细节。
	const second = await screen.zoom({ frameId: first.geometry.frameId, region: { x: 0, y: 0, width: 200, height: 200 }, maxLongEdge: 640 });
	assert.strictEqual(second.ok, true);
	if (!second.ok) return;
	assert.deepStrictEqual({ width: second.geometry.sourceWidth, height: second.geometry.sourceHeight }, { width: 400, height: 400 }, "second zoom must crop the native 400x400 source, not the 200x200 delivery");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(second.geometry.screenRect)), JSON.parse(JSON.stringify(direct.geometry.screenRect)));
	// 缓存里存的是原生裁剪图（名称里带 native-400x400），不是缩小后的交付图。
	const cached = screen.getFrame(second.geometry.frameId);
	assert.strictEqual(cached.nativeJpeg.toString(), "native-400x400");
});

test("zoom reports frame-not-found / empty-region / rotation instead of guessing", async () => {
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen();
	const missing = await screen.zoom({ frameId: "missing", region: { x: 0, y: 0, width: 10, height: 10 } });
	assert.strictEqual(missing.ok, false);
	assert.strictEqual(missing.reason, "frame-not-found");

	const captured = await screen.capture();
	const empty = await screen.zoom({ frameId: captured.geometry.frameId, region: { x: 5000, y: 5000, width: 10, height: 10 } });
	assert.strictEqual(empty.ok, false);
	assert.strictEqual(empty.reason, "empty-region");

	// 旋转屏：不猜轴向映射（未实测组合）。
	const rotated = await screen.capture();
	const frame = screen.getFrame(rotated.geometry.frameId);
	frame.geometry.rotation = 90;
	const result = await screen.zoom({ frameId: rotated.geometry.frameId, region: { x: 0, y: 0, width: 10, height: 10 } });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, "rotation-unsupported");
});

test("dispose clears the frame cache", async () => {
	const { CuaScreen } = loadScreen();
	const screen = new CuaScreen();
	const captured = await screen.capture();
	screen.dispose();
	assert.strictEqual(screen.getFrame(captured.geometry.frameId), undefined);
});
