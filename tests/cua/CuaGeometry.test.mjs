/**
 * CUA 截图几何纯函数测试。
 *
 * 用 C0 实测的真实数值做夹具：主屏物理 (0,0) 2560×1440、副屏物理 (-2560,0) 2560×1600（负原点）、
 * 交付图 1280×720。几何错误会在实机上变成「点偏两倍」，所以这里逐条断言换算与取整边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const Geometry = loadTsCommonJs("src/main/cua/CuaGeometry.ts");

const primaryFrame = {
	frameId: "frame-primary",
	displayId: "3907019210",
	sourceId: "screen:1:0",
	screenRect: { x: 0, y: 0, width: 2560, height: 1440 },
	sourceWidth: 2560,
	sourceHeight: 1440,
	imageWidth: 1280,
	imageHeight: 720,
	capturedAtMs: 1790000000000,
	rotation: 0,
};

const secondaryFrame = {
	...primaryFrame,
	frameId: "frame-secondary",
	displayId: "86307912",
	sourceId: "screen:0:0",
	screenRect: { x: -2560, y: 0, width: 2560, height: 1600 },
	sourceWidth: 2560,
	sourceHeight: 1600,
	imageWidth: 1280,
	imageHeight: 800,
};

test("image point maps to physical screen pixels (1280px delivery of a 2560px screen)", () => {
	const mapped = Geometry.imagePointToScreen(primaryFrame, { x: 640, y: 360 });
	assert.strictEqual(mapped.ok, true);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(mapped.value)), { x: 1280, y: 720 });

	const corner = Geometry.imagePointToScreen(primaryFrame, { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(corner.value)), { x: 0, y: 0 });
});

test("negative-origin secondary display keeps its physical origin", () => {
	const mapped = Geometry.imagePointToScreen(secondaryFrame, { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(mapped.value)), { x: -2560, y: 0 });

	const center = Geometry.imagePointToScreen(secondaryFrame, { x: 640, y: 400 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(center.value)), { x: -1280, y: 800 });
});

test("screen point maps back into image coordinates (round trip)", () => {
	const image = Geometry.screenPointToImage(primaryFrame, { x: 1280, y: 720 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(image.value)), { x: 640, y: 360 });

	const outside = Geometry.screenPointToImage(primaryFrame, { x: -1, y: 10 });
	assert.strictEqual(outside.ok, false);
	assert.strictEqual(outside.reason, "point-out-of-bounds");
});

test("crop frame maps its own image pixels to the same screen area", () => {
	// 在 1280×720 交付图上裁 (200,200)-(400,320)：物理区域是 (400,400) 400×240。
	const child = Geometry.cropFrameGeometry(primaryFrame, { x: 200, y: 200, width: 200, height: 120 }, { width: 400, height: 240 }, "frame-child", primaryFrame.capturedAtMs);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(child.screenRect)), { x: 400, y: 400, width: 400, height: 240 });
	assert.strictEqual(child.parentFrameId, "frame-primary");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(child.crop)), { x: 200, y: 200, width: 200, height: 120 });

	const topLeft = Geometry.imagePointToScreen(child, { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(topLeft.value)), { x: 400, y: 400 });
	const bottomRight = Geometry.imagePointToScreen(child, { x: 400, y: 240 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(bottomRight.value)), { x: 800, y: 640 });
});

test("rounding happens at the input boundary and stays inside the display", () => {
	// resolveScreenPoint 的入参已经是屏幕物理坐标（浮点），只在这里取整。
	const point = Geometry.resolveScreenPoint(primaryFrame, { x: 2559.4, y: 1438.6 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(point)), { x: 2559, y: 1439 });

	// 图像右下边界（x == imageWidth）映射到屏幕右边界外 1px，必须夹回最后一个像素。
	const edge = Geometry.imagePointToScreen(primaryFrame, { x: 1280, y: 720 });
	const resolved = Geometry.resolveScreenPoint(primaryFrame, edge.value);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(resolved)), { x: 2559, y: 1439 });
});

test("out-of-bounds image points and rotated displays are refused, not guessed", () => {
	const outside = Geometry.imagePointToScreen(primaryFrame, { x: 1281, y: 10 });
	assert.strictEqual(outside.ok, false);
	assert.strictEqual(outside.reason, "point-out-of-bounds");

	const negative = Geometry.imagePointToScreen(primaryFrame, { x: -1, y: 10 });
	assert.strictEqual(negative.reason, "point-out-of-bounds");

	const rotated = Geometry.imagePointToScreen({ ...primaryFrame, rotation: 90 }, { x: 10, y: 10 });
	assert.strictEqual(rotated.ok, false);
	assert.strictEqual(rotated.reason, "rotation-unsupported");
});

test("invalid geometry is rejected instead of dividing by zero", () => {
	const invalid = Geometry.imagePointToScreen({ ...primaryFrame, imageWidth: 0 }, { x: 1, y: 1 });
	assert.strictEqual(invalid.ok, false);
	assert.strictEqual(invalid.reason, "invalid-geometry");
});

test("image rect maps to a physical rect and to native pixels", () => {
	const screenRect = Geometry.imageRectToScreenRect(primaryFrame, { x: 100, y: 50, width: 200, height: 100 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(screenRect.value)), { x: 200, y: 100, width: 400, height: 200 });

	const nativeRect = Geometry.imageRectToNativeRect(primaryFrame, { x: 100, y: 50, width: 200, height: 100 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(nativeRect)), { x: 200, y: 100, width: 400, height: 200 });
});

test("clampImageRect clips to the image and rejects empty regions", () => {
	const clipped = Geometry.clampImageRect({ x: 1200, y: 700, width: 200, height: 100 }, 1280, 720);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(clipped)), { x: 1200, y: 700, width: 80, height: 20 });

	assert.strictEqual(Geometry.clampImageRect({ x: 1300, y: 10, width: 10, height: 10 }, 1280, 720), null);
	assert.strictEqual(Geometry.clampImageRect({ x: 10, y: 10, width: 0, height: 10 }, 1280, 720), null);
});

test("monitor matching resolves mixed-DPI displays without DIP multiplication drift", () => {
	const monitors = [
		{ rect: { x: -2560, y: 0, width: 2560, height: 1600 }, work: { x: -2560, y: 0, width: 2560, height: 1528 }, primary: false, dpiX: 144, dpiY: 144 },
		{ rect: { x: 0, y: 0, width: 2560, height: 1440 }, work: { x: 0, y: 0, width: 2560, height: 1380 }, primary: true, dpiX: 120, dpiY: 120 },
	];

	// 实测 DIP：副屏 (-1707,0) 1707×1067 @150%，主屏 (0,0) 2048×1152 @125%。
	const secondary = Geometry.matchMonitorToDisplay({ x: -1707, y: 0, width: 1707, height: 1067 }, 1.5, monitors);
	assert.ok(secondary);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(secondary.monitor.rect)), { x: -2560, y: 0, width: 2560, height: 1600 });
	assert.ok(secondary.errorPx < 1);

	const primary = Geometry.matchMonitorToDisplay({ x: 0, y: 0, width: 2048, height: 1152 }, 1.25, monitors);
	assert.ok(primary);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(primary.monitor.rect)), { x: 0, y: 0, width: 2560, height: 1440 });
	assert.strictEqual(primary.errorPx, 0);

	// 完全不匹配时返回 null，由调用方降级并标注，不编造矩形。
	assert.strictEqual(Geometry.matchMonitorToDisplay({ x: 5000, y: 5000, width: 800, height: 600 }, 1, monitors), null);
});

test("describeFrameGeometry exposes the mapping contract but no internal cache fields", () => {
	const described = Geometry.describeFrameGeometry(primaryFrame);
	assert.strictEqual(described.frameId, "frame-primary");
	assert.strictEqual(described.coordinateSpace, "image");
	assert.deepStrictEqual(JSON.parse(JSON.stringify(described.screenRect)), { x: 0, y: 0, width: 2560, height: 1440 });
	assert.strictEqual(described.nativeJpeg, undefined);
});
