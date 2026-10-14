/**
 * 位置 hook 的行为复现（先红后绿）：切章/切书晚到的写回必须仍带发起时的完整身份，
 * 回执必须与发起票据核对（不能自比较），恢复幂等按「书 + 版本 + 章节」区分且可重置。
 *
 * 加载真实生产 hook 与真实 Jotai store，只替换 React 挂载层与桌面契约依赖。
 */
import assert from "node:assert/strict";
import { setImmediate as nextTask } from "node:timers/promises";
import test from "node:test";
import { createReadingHookHarness } from "./helpers/readingHookHost.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => nextTask();

const BOOK_A = { workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: "sha:c1" };
const BOOK_B = { workId: "w1", editionId: "e2", contentVersion: "v2", chapterHref: "OEBPS/c2.xhtml", chapterNum: 2, chapterTextDigest: "sha:c2" };

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createClient(options = {}) {
	const calls = { getPosition: [], savePosition: [] };
	let positionImpl = options.getPosition ?? (async () => ({ ok: true, position: null, stale: false, reason: "none" }));
	let saveImpl = options.savePosition ?? (async (input) => ({ ok: true, position: { ...input, source: "reader", savedAt: "2026-10-14T10:00:00.000Z" }, idempotent: false, scope: { workId: input.workId, editionId: input.editionId, contentVersion: input.contentVersion } }));
	return {
		calls,
		getPosition: async (workId, editionId, contentVersion) => {
			calls.getPosition.push({ workId, editionId, contentVersion });
			return positionImpl(workId, editionId, contentVersion);
		},
		savePosition: async (input) => {
			calls.savePosition.push(plain(input));
			return saveImpl(input);
		},
		setPositionImpl(next) {
			positionImpl = next;
		},
		setSaveImpl(next) {
			saveImpl = next;
		},
	};
}

/** 位置输入：同一本书同一版本换章时只改 chapter* 字段。 */
function positionInput(book, overrides = {}) {
	return { client: overrides.client, workId: book.workId, editionId: book.editionId, contentVersion: book.contentVersion, chapterLoaded: true, chapterHref: book.chapterHref, chapterNum: book.chapterNum, chapterTextDigest: book.chapterTextDigest, tocHrefs: [BOOK_A.chapterHref, BOOK_B.chapterHref] };
}

test("切书时迟到的结算仍带发起时的完整身份，不把上一章的指标写到新书", async () => {
	const harness = createReadingHookHarness();
	const { useReadingPosition } = harness.load("src/renderer/src/hooks/useReadingPosition.ts");
	const pending = deferred();
	const client = createClient({ savePosition: async () => pending.promise });

	let controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	// 本轮的写回还在飞（lastSaved 还没落地），此时用户切到另一版本的另一章
	controller.reportViewport({ fraction: 0.5, viewportHeight: 600, scrollHeight: 5000 });
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_B, { client })));
	await tick();

	pending.resolve({
		ok: true,
		position: { workId: BOOK_A.workId, editionId: BOOK_A.editionId, contentVersion: BOOK_A.contentVersion, fraction: 0.5, spineHref: BOOK_A.chapterHref, chapterNum: 1, chapterTextDigest: "sha:c1", source: "reader", savedAt: "2026-10-14T10:00:00.000Z" },
		idempotent: false,
		scope: { workId: BOOK_A.workId, editionId: BOOK_A.editionId, contentVersion: BOOK_A.contentVersion },
	});
	await tick();

	assert.ok(client.calls.savePosition.length >= 1, "至少发出一次写回");
	for (const payload of client.calls.savePosition) {
		// 身份、章节、摘要必须来自同一张票据：要么全 A，要么全 B
		const isA = payload.editionId === BOOK_A.editionId;
		const isB = payload.editionId === BOOK_B.editionId;
		assert.ok(isA || isB, "写回必须发生在某一本书上");
		assert.equal(payload.contentVersion, isA ? BOOK_A.contentVersion : BOOK_B.contentVersion, "版本必须与版本身份一致");
		assert.equal(payload.spineHref, isA ? BOOK_A.chapterHref : BOOK_B.chapterHref, "章节 href 必须与同一张票据一致");
		assert.equal(payload.chapterTextDigest, isA ? BOOK_A.chapterTextDigest : BOOK_B.chapterTextDigest, "章节摘要必须与同一张票据一致");
	}
	assert.equal(client.calls.savePosition[0].editionId, BOOK_A.editionId, "第一笔写回属于 A 版");
	assert.equal(client.calls.savePosition[0].fraction, 0.5);
});

test("回执与发起票据核对：别的版本/别的书的 ACK 不落当前书，也不显示已保存", async () => {
	const harness = createReadingHookHarness();
	const { useReadingPosition } = harness.load("src/renderer/src/hooks/useReadingPosition.ts");
	const pending = deferred();
	const client = createClient({ savePosition: async () => pending.promise });

	let controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	controller.reportViewport({ fraction: 0.5, viewportHeight: 600, scrollHeight: 5000 });
	await tick();
	assert.equal(client.calls.savePosition.length, 1);

	// 服务端回了一个别的版本的回执（陈旧/串包）：不能当成当前书的保存结果
	pending.resolve({
		ok: true,
		position: { workId: BOOK_A.workId, editionId: BOOK_A.editionId, contentVersion: BOOK_A.contentVersion, fraction: 0.5, spineHref: BOOK_A.chapterHref, chapterNum: 1, chapterTextDigest: "sha:c1", source: "reader", savedAt: "2026-10-14T10:00:00.000Z" },
		idempotent: false,
		scope: { workId: BOOK_A.workId, editionId: "e9", contentVersion: "v9" },
	});
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	assert.equal(controller.savedAt, null, "scope 不符的回执不得显示已保存");
	assert.equal(controller.saving, false, "在飞的写回必须收尾，不能永远转圈");
});

test("恢复幂等按书/版本/章节区分，切走回来可重新下发一次", async () => {
	const harness = createReadingHookHarness();
	const { useReadingPosition } = harness.load("src/renderer/src/hooks/useReadingPosition.ts");
	const client = createClient({
		getPosition: async (workId, editionId, contentVersion) => ({
			ok: true,
			position: { workId, editionId, contentVersion, fraction: 0.4, spineHref: BOOK_A.chapterHref, chapterNum: 1, chapterTextDigest: "sha:c1", source: "reader", savedAt: "2026-10-13T10:00:00.000Z" },
			stale: false,
			reason: "none",
		}),
	});

	let controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	assert.ok(controller.restore, "同版同章有位置时应下发恢复");
	const firstKey = controller.restore.key;
	controller.ackRestore(firstKey);
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	assert.equal(controller.restore, null, "同一票据只恢复一次");

	// 切到另一版本的另一章，再切回来：应重新下发一次（幂等标记按作用域重置）
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_B, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_B, { client })));
	assert.equal(controller.restore, null, "B 章没有保存位置，不下发恢复");
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	assert.ok(controller.restore, "切走再回来应重新下发一次恢复");
	assert.notEqual(controller.restore.key, undefined);
});

test("位置读取被拒绝（IPC 抛错）时收尾为可见错误，不停在加载态", async () => {
	const harness = createReadingHookHarness();
	const { useReadingPosition } = harness.load("src/renderer/src/hooks/useReadingPosition.ts");
	const client = createClient({ getPosition: async () => Promise.reject(new Error("ipc down")) });

	let controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	await tick();
	controller = harness.render(() => useReadingPosition(positionInput(BOOK_A, { client })));
	assert.equal(controller.loading, false, "拒绝后必须退出加载态");
	assert.equal(controller.error?.code, "internalError", "拒绝要变成可见的结构化错误");
});
