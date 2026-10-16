import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * archiveIo 共用能力的永久保障（DSH 运行时移除时从中性模块的旧测试迁移，见 2026-10 审查 R2）：
 * - createNetDownloader 的下载生命周期（超时 / 取消 / 完成 / 数据到达刷新 deadline / 手工重定向）；
 * - isSafeArchiveEntry 的 tar slip 防护。
 * 这类保障与 DSH 无关，Pi 便携 Node 安装器与后续下载链路都依赖；实现位于
 * src/main/archiveIo/archiveIoImpl.ts 与 archiveIo.ts。
 */

/** Controlled Electron requests and clock: no network or real timeout waits. */
function createFixture() {
	const requests = [];
	const timers = new Map();
	const logs = [];
	let timerId = 0;
	const load = createTsSandbox({
		stubs: {
			"node:timers": {
				setTimeout: (callback, ms) => {
					const id = ++timerId;
					timers.set(id, { callback, ms });
					return id;
				},
				clearTimeout: (id) => timers.delete(id),
			},
			electron: {
				net: {
					request: (options) => {
						const request = new EventEmitter();
						request.options = options;
						request.setHeader = () => {};
						request.end = () => {};
						request.abortCount = 0;
						request.abort = () => {
							request.abortCount++;
							request.emit("error", new Error("request aborted"));
						};
						requests.push(request);
						return request;
					},
				},
			},
		},
	});
	const io = load("src/main/archiveIo/archiveIoImpl.ts");
	return {
		...io,
		requests,
		timers,
		logs,
		log: (...args) => logs.push(args),
		fireTimeout: () => {
			const entry = timers.entries().next().value;
			assert.ok(entry, "an in-flight request must have a deadline");
			timers.delete(entry[0]);
			entry[1].callback();
		},
	};
}

function response(body = "", statusCode = 200, headers = {}) {
	const stream = Readable.from([Buffer.from(body)]);
	stream.statusCode = statusCode;
	stream.headers = headers;
	return stream;
}

/** 每个用例独占一个临时下载目录，避免并发用例互相踩文件。 */
function tempDownloadRoot(prefix) {
	return mkdtempSync(join(tmpdir(), `pideck-archive-io-${prefix}-`));
}

test("a silent download has an idle deadline and releases the cancellation listener on failure", async () => {
	const fixture = createFixture();
	const root = tempDownloadRoot("timeout");
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const rejected = assert.rejects(pending, /download timed out/i);
		fixture.fireTimeout();
		await rejected;
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("download cancellation stops the active file pipeline and clears its resources", async () => {
	const fixture = createFixture();
	const root = tempDownloadRoot("cancel");
	const stream = new PassThrough();
	try {
		stream.statusCode = 200;
		stream.headers = {};
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const rejected = assert.rejects(pending, /download aborted/i);
		fixture.requests[0].emit("response", stream);
		stream.write("partial archive");
		controller.abort();
		await rejected;
		assert.equal(stream.destroyed, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		stream.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test("completed download clears its deadline and cannot be aborted by a later cancellation", async () => {
	const fixture = createFixture();
	const root = tempDownloadRoot("finish");
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const initialTimer = fixture.timers.keys().next().value;
		fixture.requests[0].emit("response", response("complete archive"));
		await pending;
		assert.ok(!fixture.timers.has(initialTimer));
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(fixture.requests[0].abortCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("incoming download data refreshes the idle deadline; a later stall closes the file before rejecting", async () => {
	const fixture = createFixture();
	const root = tempDownloadRoot("stall");
	const stream = new PassThrough();
	try {
		stream.statusCode = 200;
		stream.headers = {};
		const controller = new AbortController();
		const progress = [];
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), (received) => progress.push(received), controller.signal);
		const rejected = assert.rejects(pending, /download timed out/i);
		fixture.requests[0].emit("response", stream);
		const beforeData = fixture.timers.keys().next().value;
		stream.write("partial archive");
		assert.deepEqual(progress, [15]);
		assert.ok(!fixture.timers.has(beforeData), "data, not just response headers, must reset the deadline");
		assert.equal(fixture.timers.size, 1);
		fixture.fireTimeout();
		await rejected;
		assert.equal(stream.destroyed, true);
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		stream.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test("manual redirect closes the first request and transfers cancellation/deadline ownership to the next hop", async () => {
	const fixture = createFixture();
	const root = tempDownloadRoot("redirect");
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		assert.equal(fixture.requests[0].options.redirect, "manual");
		fixture.requests[0].emit("redirect", 302, "GET", "https://cdn.example.invalid/archive.tgz");
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		await Promise.resolve();
		assert.equal(fixture.requests.length, 2);
		assert.equal(fixture.requests[1].options.url, "https://cdn.example.invalid/archive.tgz");
		assert.equal(fixture.timers.size, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		fixture.requests[0].emit("error", new Error("late redirect socket error"));
		fixture.requests[1].emit("response", response("complete archive"));
		await pending;
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSafeArchiveEntry 拒绝绝对路径与 ../ 逃逸", () => {
	const { isSafeArchiveEntry } = createTsSandbox()("src/main/archiveIo/archiveIo.ts");
	const dest = join(tmpdir(), "pideck-archive-io-dest");
	assert.equal(isSafeArchiveEntry(dest, "node_modules/x/index.js"), true);
	assert.equal(isSafeArchiveEntry(dest, "a/b/c.txt"), true);
	assert.equal(isSafeArchiveEntry(dest, "../outside.js"), false);
	assert.equal(isSafeArchiveEntry(dest, "a/../../b.js"), false);
	assert.equal(isSafeArchiveEntry(dest, "/etc/passwd"), false);
	assert.equal(isSafeArchiveEntry(dest, "C:/Windows/system32/x.dll"), false);
});
