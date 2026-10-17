import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// 顶层不带 electron stub 也能加载：npm `electron` 包在非 Electron 运行时导出
// 的是二进制路径字符串，destructure 出 undefined，仅 captureScreen 不可用。
const CuaFrame = loadTsCommonJs("src/main/cua/CuaFrame.ts");

function makeElectronStub({ sources, calls, primaryId = "primary-display" }) {
	return {
		desktopCapturer: {
			getSources: async (opts) => {
				calls.push(opts);
				return sources;
			},
		},
		nativeImage: {
			createFromDataURL: () => ({ isEmpty: () => true }),
			createFromBuffer: () => ({ isEmpty: () => true }),
		},
		screen: {
			getPrimaryDisplay: () => ({ id: primaryId }),
		},
	};
}

function makeFakeImage({ width, height, resizedTo, nativeQuality }) {
	return {
		getSize: () => ({ width, height }),
		resize: (opts) => {
			assert.ok(opts.width > 0 && opts.height > 0, "resize needs positive dims");
			resizedTo.push(opts);
			return {
				getSize: () => ({ width: opts.width, height: opts.height }),
				resize: () => {
					throw new Error("double resize should never happen");
				},
				toJPEG: () => Buffer.from(`jpeg-${opts.width}x${opts.height}`),
			};
		},
		toJPEG: (quality) => {
			if (nativeQuality) nativeQuality.push(quality);
			return Buffer.from(`jpeg-native-${width}x${height}`);
		},
	};
}

function sourceFor({ id = "screen:0:0", displayId = "primary-display", width = 2560, height = 1440 } = {}) {
	const resizedTo = [];
	const nativeQuality = [];
	return {
		source: { id, display_id: displayId, thumbnail: makeFakeImage({ width, height, resizedTo, nativeQuality }) },
		resizedTo,
		nativeQuality,
	};
}

function loadFrame(sources, calls, primaryId) {
	return loadTsCommonJs("src/main/cua/CuaFrame.ts", {
		stubs: { electron: makeElectronStub({ sources, calls, primaryId }) },
	});
}

test("default capture options match the delivered budget", () => {
	// 1280 long edge / quality 75 keeps delivered frames under ~190KB base64.
	assert.strictEqual(CuaFrame.DEFAULT_MAX_LONG_EDGE, 1280);
	assert.strictEqual(CuaFrame.DEFAULT_QUALITY, 75);
	// 8192 只是「调用方不知道显示器物理尺寸」时的兜底请求框；它会放大（C0 实测）。
	assert.strictEqual(CuaFrame.THUMBNAIL_REQUEST_SIZE, 8192);
});

test("captureScreen requests a large fallback box when no requestSize is given (never 1x1)", async () => {
	// 2026-10 实机回归：thumbnailSize {1,1} 让 Electron 把 capture 缩到 1 像素。
	const calls = [];
	const { source } = sourceFor();
	const mod = loadFrame([source], calls);

	const frame = await mod.captureScreen();
	assert.strictEqual(calls.length, 1);
	const requested = calls[0].thumbnailSize;
	assert.strictEqual(requested.width, mod.THUMBNAIL_REQUEST_SIZE);
	assert.strictEqual(requested.height, mod.THUMBNAIL_REQUEST_SIZE);

	// 2560x1440 → 1280x720
	assert.strictEqual(frame.width, 1280);
	assert.strictEqual(frame.height, 720);
	assert.strictEqual(frame.mimeType, "image/jpeg");
	// 交付图与 source id 分开：displayId 是 Electron 显示 id（cua_get_state/displays 用）。
	assert.strictEqual(frame.displayId, "primary-display");
	assert.strictEqual(frame.sourceId, "screen:0:0");
	assert.strictEqual(frame.sourceWidth, 2560);
	assert.strictEqual(frame.sourceHeight, 1440);
});

test("captureScreen uses requestSize verbatim (1:1 native request, no upscale)", async () => {
	const calls = [];
	const { source, resizedTo } = sourceFor();
	const mod = loadFrame([source], calls);

	const frame = await mod.captureScreen({ requestSize: { width: 2560, height: 1440 }, maxLongEdge: 2560 });
	assert.strictEqual(calls[0].thumbnailSize.width, 2560);
	assert.strictEqual(calls[0].thumbnailSize.height, 1440);
	assert.strictEqual(resizedTo.length, 0, "native-size request needs no resize");
	assert.strictEqual(frame.width, 2560);
	assert.strictEqual(frame.height, 1440);
});

test("captureScreen keeps a native JPEG when requested (crop source for cua_zoom)", async () => {
	const calls = [];
	const { source, nativeQuality } = sourceFor();
	const mod = loadFrame([source], calls);

	const frame = await mod.captureScreen({ requestSize: { width: 2560, height: 1440 }, keepNativeJpeg: true });
	assert.ok(Buffer.isBuffer(frame.nativeJpeg), "native JPEG is present");
	assert.strictEqual(nativeQuality[0], mod.DEFAULT_NATIVE_QUALITY);
	// 交付图仍然按 maxLongEdge 缩小。
	assert.strictEqual(frame.width, 1280);
	assert.strictEqual(frame.height, 720);
});

test("captureScreen selects the primary display by id, not sources[0]", async () => {
	const calls = [];
	const secondary = sourceFor({ id: "screen:0:0", displayId: "secondary-display", width: 2560, height: 1600 });
	const primary = sourceFor({ id: "screen:1:0", displayId: "primary-display" });
	const mod = loadFrame([secondary.source, primary.source], calls, "primary-display");

	const frame = await mod.captureScreen();
	assert.strictEqual(frame.displayId, "primary-display");
	assert.strictEqual(frame.sourceId, "screen:1:0");
});

test("captureScreen accepts either the electron display id or the source id", async () => {
	const calls = [];
	const { source } = sourceFor({ id: "screen:0:0", displayId: "secondary-display", width: 2560, height: 1600 });
	const mod = loadFrame([source], calls);

	const byDisplay = await mod.captureScreen({ displayId: "secondary-display" });
	assert.strictEqual(byDisplay.sourceId, "screen:0:0");
	const bySource = await mod.captureScreen({ displayId: "screen:0:0" });
	assert.strictEqual(bySource.displayId, "secondary-display");
});

test("captureScreen throws when the requested displayId is not found", async () => {
	const calls = [];
	const { source } = sourceFor();
	const mod = loadFrame([source], calls);
	await assert.rejects(() => mod.captureScreen({ displayId: "screen:9:9" }), /Screen source not found/);
});

test("cropNativeJpeg returns null for an unreadable buffer", () => {
	const calls = [];
	const { source } = sourceFor();
	const mod = loadFrame([source], calls);
	const result = mod.cropNativeJpeg(Buffer.from("not-a-jpeg"), { x: 0, y: 0, width: 10, height: 10 });
	assert.strictEqual(result, null);
});

/**
 * 可解码的 nativeImage 替身：cropNativeJpeg 的回归用。
 * toJPEG(quality) 的字节长度随 quality 变化，用来证明交付图真的按请求质量编码。
 */
function makeDecodableElectronStub({ sourceSize = { width: 2560, height: 1440 } } = {}) {
	const makeImage = (size) => ({
		isEmpty: () => false,
		getSize: () => ({ ...size }),
		crop: (rect) => makeImage({ width: rect.width, height: rect.height }),
		resize: (opts) => makeImage({ width: opts.width, height: opts.height }),
		// 模拟 JPEG：质量越低字节越少；长度与质量线性相关，便于断言。
		toJPEG: (quality) => Buffer.alloc(quality * 10, 0x2a),
	});
	return {
		desktopCapturer: { getSources: async () => [] },
		nativeImage: {
			createFromBuffer: (buffer) => (buffer?.length ? makeImage(sourceSize) : { isEmpty: () => true }),
			createFromDataURL: () => ({ isEmpty: () => true }),
		},
		screen: { getPrimaryDisplay: () => ({ id: "primary-display" }) },
	};
}

test("cropNativeJpeg honours the requested quality when the crop is not downscaled", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaFrame.ts", { stubs: { electron: makeDecodableElectronStub() } });
	const source = Buffer.alloc(64, 1);
	const rect = { x: 0, y: 0, width: 400, height: 400 };

	// 400×400 未超过 maxLongEdge：交付图不能被静默升级成原生缓存质量（92）。
	const low = mod.cropNativeJpeg(source, rect, { maxLongEdge: 1600, quality: 1 });
	const high = mod.cropNativeJpeg(source, rect, { maxLongEdge: 1600, quality: 100 });
	assert.ok(low && high);
	assert.deepStrictEqual({ width: low.width, height: low.height }, { width: 400, height: 400 });
	assert.strictEqual(low.data.length, 10, "quality 1 must encode the delivered crop at quality 1");
	assert.strictEqual(high.data.length, 1000, "quality 100 must encode the delivered crop at quality 100");
	assert.notStrictEqual(low.data.length, high.data.length);

	// 原生缓存质量固定 92，与交付质量无关：连续 zoom 的裁剪源不因本次低质量而变差。
	assert.strictEqual(low.nativeData.length, 920);
	assert.strictEqual(high.nativeData.length, 920);
	assert.deepStrictEqual({ width: low.nativeWidth, height: low.nativeHeight }, { width: 400, height: 400 });

	// 请求质量恰好等于原生缓存质量时才复用同一份字节（避免重复编码）。
	const same = mod.cropNativeJpeg(source, rect, { maxLongEdge: 1600, quality: mod.DEFAULT_NATIVE_QUALITY });
	assert.ok(same);
	assert.strictEqual(same.data, same.nativeData);
});
