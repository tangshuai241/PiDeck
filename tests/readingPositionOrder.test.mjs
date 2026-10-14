/**
 * 阅读位置保存顺序窄测（P04 修正轮：从公开入口 ReadingService.savePosition 复现）。
 *
 * 真实风险点（2026-10 评审）不是 store 内部：首帧 save 会惰性触发 requireEdition → refreshLibrary
 * 的慢网络请求；校验若在既有 per-edition 链之外，并发第二次 save 可能先校验先写入，
 * 早发的旧位置反而后完成并在链内覆盖新位置。这里用可控 deferred 的 catalog 复现该顺序反转，
 * 并锁住：按版独立、失败不毒化后续、幂等与 .bak 原件语义。
 *
 * 口径：真实 ReadingService + 真实本地位置存储（临时目录），只替换 HTTP 客户端与连接存储；
 * 延迟全部由可控 fake 注入，不依赖真实磁盘/网络时序。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ReadingService } = loadTsCommonJs("src/main/personal-workbench/reading/ReadingService.ts");

const FIXED = "2026-10-15T00:00:00.000Z";
const LIBRARY = {
	works: [
		{
			work_id: "w1",
			title: "书",
			editions: [
				{ edition_id: "e1", rel: "a.epub", size: 1, mtime: 0 },
				{ edition_id: "e2", rel: "b.epub", size: 1, mtime: 0 },
			],
		},
	],
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 等待异步条件成立（磁盘 IO 完成时机不固定）；上界内轮询，不作时序假设。 */
async function waitFor(predicate, attempts = 200) {
	for (let index = 0; index < attempts; index += 1) {
		if (predicate()) return true;
		await tick();
	}
	return predicate();
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

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

function createClient(overrides = {}) {
	const unexpected = async () => {
		throw new Error("boundary: unexpected HTTP call");
	};
	return {
		setBaseUrl() {},
		dispose() {},
		catalog: unexpected,
		listBooks: async () => ({ ok: true, json: { books: [] } }),
		getEdition: unexpected,
		getChapter: unexpected,
		resolveQuote: unexpected,
		listNotes: unexpected,
		readNote: unexpected,
		writeNote: unexpected,
		historySources: unexpected,
		listHistory: unexpected,
		readHistorySession: unexpected,
		...overrides,
	};
}

function createService(dir, client) {
	const service = new ReadingService({
		paths: pathsFor(dir),
		client,
		connection: {
			read: async () => ({ version: 1, baseUrl: "http://127.0.0.1:18965", rememberPassword: false, lastConnectedAt: null }),
			readPassword: () => null,
			write: async () => ({ ok: true }),
			protectPassword: () => null,
		},
		sessionExists: () => true,
		now: () => new Date(FIXED),
	});
	return service;
}

function saveInput(overrides = {}) {
	return { workId: "w1", editionId: "e1", contentVersion: "cv1", fraction: 0.5, spineHref: "ch1.xhtml", chapterNum: 1, chapterTextDigest: "d1", ...overrides };
}

test("首帧惰性刷新期间并发保存：旧位置不得反超覆盖新位置（校验+写入整体入既有链）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-pos-order-"));
	const firstCatalog = deferred();
	let catalogCalls = 0;
	const client = createClient({
		catalog: () => {
			catalogCalls += 1;
			// 第一次 save 触发惰性书库刷新：挂起，模拟慢网络；第二次立即返回
			return catalogCalls === 1 ? firstCatalog.promise : Promise.resolve({ ok: true, json: LIBRARY });
		},
	});
	const service = createService(dir, client);

	const first = service.savePosition(saveInput({ fraction: 0.2 }));
	await tick();
	const second = service.savePosition(saveInput({ fraction: 0.8 }));
	await tick();

	// 串行判据：第一次校验还没回来前，第二次不得开始校验/写入（否则会出现顺序反转）
	assert.equal(catalogCalls, 1, "第二次 save 不得越过仍在刷新书库的第一次 save");
	assert.equal((await service.getPosition("w1", "e1", "cv1")).position, null, "此时不应有任何写入");

	firstCatalog.resolve({ ok: true, json: LIBRARY });
	const firstResult = await first;
	assert.equal(firstResult.ok, true);
	assert.equal(firstResult.position.fraction, 0.2);
	const secondResult = await second;
	assert.equal(secondResult.ok, true);
	assert.equal(secondResult.position.fraction, 0.8);

	const loaded = await service.getPosition("w1", "e1", "cv1");
	assert.equal(loaded.ok, true);
	assert.equal(loaded.position.fraction, 0.8, "后发（新位置）必须胜出");
	assert.ok(readFileSync(join(pathsFor(dir).positionsDir, "e1.json.bak"), "utf8").includes('"fraction": 0.2'), "替换前必须留 .bak 原件");
	assert.equal(catalogCalls, 2, "第二次 save 在第一次完成后才校验");
});

test("按版本独立：一个版本的保存被挂起时，另一版本照常完成", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-pos-order-"));
	const service = createService(dir, createClient({ catalog: async () => ({ ok: true, json: LIBRARY }) }));
	await service.listLibrary();

	const store = service.positionStore;
	const originalSave = store.save.bind(store);
	let releaseE1 = () => {};
	const gate = new Promise((resolve) => {
		releaseE1 = resolve;
	});
	let e1Entered = false;
	store.save = async (position) => {
		if (position.editionId === "e1") {
			e1Entered = true;
			await gate;
		}
		return originalSave(position);
	};

	const held = service.savePosition(saveInput({ editionId: "e1", fraction: 0.1 }));
	assert.equal(await waitFor(() => e1Entered), true, "e1 保存应已进入写入阶段并被挂起");
	const other = service.savePosition(saveInput({ editionId: "e2", contentVersion: "cv2", fraction: 0.9 }));
	const otherResult = await other;
	assert.equal(otherResult.ok, true);
	assert.equal((await service.getPosition("w1", "e2", "cv2")).position.fraction, 0.9, "另一版本不受同版串行阻塞");
	releaseE1();
	assert.equal((await held).ok, true);
	assert.equal((await service.getPosition("w1", "e1", "cv1")).position.fraction, 0.1);
});

test("失败不毒化后续：结构化写失败与意外抛错之后，同版保存仍可继续", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-pos-order-"));
	const service = createService(dir, createClient({ catalog: async () => ({ ok: true, json: LIBRARY }) }));
	await service.listLibrary();

	const store = service.positionStore;
	const originalSave = store.save.bind(store);
	store.save = async () => ({ ok: false, reason: "writeFailed" });
	const failed = await service.savePosition(saveInput({ fraction: 0.3 }));
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "writeFailed");

	store.save = async () => {
		throw new Error("unexpected store throw");
	};
	await assert.rejects(service.savePosition(saveInput({ fraction: 0.4 })));

	store.save = originalSave;
	const success = await service.savePosition(saveInput({ fraction: 0.6 }));
	assert.equal(success.ok, true);
	assert.equal((await service.getPosition("w1", "e1", "cv1")).position.fraction, 0.6, "前一次失败/抛错不得让后续保存失效");
});

// 幂等/.bak 与版本不符的服务级覆盖已在 tests/readingService.test.mjs / readingPositionStore.test.mjs；
// 本文件只保留与「顺序/续接」直接相关的复现，避免重复 Store 磁盘故障测试（root 2026-10 指引）。
