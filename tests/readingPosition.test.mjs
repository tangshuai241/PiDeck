/**
 * 阅读位置策略：恢复计划（含版本陈旧回章首）、写回守卫（loading/零高度/不可滚动不覆盖）、保存入参身份。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里创建的对象属于另一个 realm；先归一成纯 JSON 再比对（deepStrictEqual 会比原型）。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const position = loadTsCommonJs("src/renderer/src/utils/readingPosition.ts");

const toc = ["OEBPS/c1.xhtml", "OEBPS/c2.xhtml"];

function positionOk(overrides = {}) {
	return {
		ok: true,
		stale: false,
		reason: "none",
		position: { workId: "w1", editionId: "e1", contentVersion: "v1", fraction: 0.42, spineHref: "OEBPS/c2.xhtml", chapterNum: 2, chapterTextDigest: "sha:abc", source: "reader", savedAt: "2026-01-01T00:00:00.000Z" },
		...overrides,
	};
}

test("fraction 归一：非法输入归 0，越界夹到 0..1", () => {
	assert.equal(position.clampReadingFraction(0.5), 0.5);
	assert.equal(position.clampReadingFraction(-3), 0);
	assert.equal(position.clampReadingFraction(9), 1);
	assert.equal(position.clampReadingFraction(Number.NaN), 0);
	assert.equal(position.clampReadingFraction("0.4"), 0);
});

test("滚动进度：不可滚动或零高度时返回 0，不制造假进度", () => {
	assert.equal(position.readingScrollFraction(50, 250, 50), 0.25);
	assert.equal(position.readingScrollFraction(0, 50, 50), 0, "内容不高于视口 → 0");
	assert.equal(position.readingScrollFraction(0, 250, 0), 0, "零高度 → 0");
	assert.equal(position.readingScrollFraction(10, Number.NaN, 50), 0);
});

test("恢复计划：无位置不提示、同版恢复、版本不符回章首、章节已不在目录也算陈旧", () => {
	assert.deepEqual(plain(position.planReadingPositionRestore({ result: null, contentVersion: "v1", tocHrefs: toc })), { kind: "none" });
	assert.deepEqual(plain(position.planReadingPositionRestore({ result: positionOk({ position: null }), contentVersion: "v1", tocHrefs: toc })), { kind: "none" }, "首次阅读没有位置，属正常路径");
	assert.deepEqual(plain(position.planReadingPositionRestore({ result: positionOk({ stale: true, reason: "versionMismatch" }), contentVersion: "v1", tocHrefs: toc })), { kind: "stale", reason: "versionMismatch" });
	assert.deepEqual(plain(position.planReadingPositionRestore({ result: positionOk({ position: { ...positionOk().position, contentVersion: "v0" } }), contentVersion: "v1", tocHrefs: toc })), { kind: "stale", reason: "versionMismatch" }, "服务端未标 stale 但版本不同，也要按陈旧处理");
	assert.deepEqual(plain(position.planReadingPositionRestore({ result: positionOk({ position: { ...positionOk().position, spineHref: "OEBPS/gone.xhtml" } }), contentVersion: "v1", tocHrefs: toc })), { kind: "stale", reason: "missing" });
	const restore = plain(position.planReadingPositionRestore({ result: positionOk(), contentVersion: "v1", tocHrefs: toc }));
	assert.equal(restore.kind, "restore");
	assert.equal(restore.chapterHref, "OEBPS/c2.xhtml", "恢复用 toc 里的 href 形态");
	assert.equal(restore.fraction, 0.42);
	assert.equal(position.planReadingPositionRestore({ result: { ok: false, error: { code: "notFound", message: "x" } }, contentVersion: "v1", tocHrefs: toc }).kind, "none", "读取失败不猜位置（原因是另一件事）");
});

test("写回守卫：loading、零高度、不可滚动、抖动都不写（禁止覆盖已有位置）", () => {
	const base = { chapterLoaded: true, chapterHref: "OEBPS/c1.xhtml", viewportHeight: 600, scrollHeight: 5000, fraction: 0.4, lastSavedFraction: null };
	assert.equal(position.shouldPersistReadingPosition(base), true);
	assert.equal(position.shouldPersistReadingPosition({ ...base, chapterLoaded: false }), false, "正文没加载完不写");
	assert.equal(position.shouldPersistReadingPosition({ ...base, viewportHeight: 0 }), false, "零高度不写");
	assert.equal(position.shouldPersistReadingPosition({ ...base, scrollHeight: 600 }), false, "不可滚动不写（fraction 恒 0，会顶掉旧位置）");
	assert.equal(position.shouldPersistReadingPosition({ ...base, chapterHref: null }), false, "没有具体章节不写");
	assert.equal(position.shouldPersistReadingPosition({ ...base, fraction: 0.405, lastSavedFraction: 0.4 }), false, "抖动不写");
	assert.equal(position.shouldPersistReadingPosition({ ...base, fraction: 0.43, lastSavedFraction: 0.4 }), true);
});

test("保存入参：身份与章节全部来自发起对象，摘要只透传服务端声明值", () => {
	const payload = plain(position.buildReadingPositionSaveInput({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: " OEBPS/c1.xhtml ", chapterNum: 1, chapterTextDigest: "sha:abc", fraction: 1.4 }));
	assert.deepEqual(payload, { workId: "w1", editionId: "e1", contentVersion: "v1", fraction: 1, spineHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: "sha:abc" });
	// 服务端没给摘要就是 null：界面不按正文现算第二份摘要
	const noDigest = plain(position.buildReadingPositionSaveInput({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: null, chapterTextDigest: null, fraction: 0.1 }));
	assert.equal(noDigest.chapterTextDigest, null);
	assert.equal(noDigest.chapterNum, null);
	assert.equal(noDigest.spineHref, "OEBPS/c1.xhtml");
});

test("保存票据：身份或章节不全时没有票据；票据自带书身份、版本、章节与摘要", () => {
	const ticket = plain(position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: " OEBPS/c2.xhtml ", chapterNum: 2, chapterTextDigest: "sha:abc" }));
	assert.deepEqual(ticket, {
		workId: "w1",
		editionId: "e1",
		contentVersion: "v1",
		chapterHref: "OEBPS/c2.xhtml",
		chapterNum: 2,
		chapterTextDigest: "sha:abc",
		bookKey: position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "x", chapterNum: null, chapterTextDigest: null }).bookKey,
	});
	assert.equal(position.readingSaveTicket({ workId: null, editionId: "e1", contentVersion: "v1", chapterHref: "c1", chapterNum: null, chapterTextDigest: null }), null);
	assert.equal(position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: null, chapterHref: "c1", chapterNum: null, chapterTextDigest: null }), null, "版本没读到不发写回");
	assert.equal(position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "   ", chapterNum: null, chapterTextDigest: null }), null);
});

test("恢复幂等 key 按书 + 版本 + 章节 + 比例区分，输入相同则稳定", () => {
	const ticketA = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	const ticketB = position.readingSaveTicket({ workId: "w1", editionId: "e2", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	const ticketC = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v2", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	const ticketD = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c9.xhtml", chapterNum: 9, chapterTextDigest: null });
	const keys = [position.readingRestoreKey(ticketA, 0.4), position.readingRestoreKey(ticketB, 0.4), position.readingRestoreKey(ticketC, 0.4), position.readingRestoreKey(ticketD, 0.4), position.readingRestoreKey(ticketA, 0.5)];
	assert.equal(new Set(keys).size, keys.length, "五个输入必须给出五个不同的幂等 key");
	assert.equal(position.readingRestoreKey(ticketA, 0.4), keys[0], "同输入必须稳定");
});

test("写回守卫 key 按书 + 版本 + 章节隔离（不拿上一本的已保存比例压掉新书）", () => {
	const ticketA = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	const ticketB = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c2.xhtml", chapterNum: 2, chapterTextDigest: null });
	assert.notEqual(position.readingSaveGuardKey(ticketA), position.readingSaveGuardKey(ticketB));
	assert.equal(position.readingSaveGuardKey(ticketA), position.readingSaveGuardKey(position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: "sha:other" })));
});

test("回执核对：只有回执的 scope 与位置都指向发起票据才算这笔保存成功", () => {
	const ticket = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: "sha:abc" });
	const positionOf = (overrides = {}) => ({ workId: "w1", editionId: "e1", contentVersion: "v1", fraction: 0.4, spineHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: "sha:abc", source: "reader", savedAt: "2026-10-14T10:00:00.000Z", ...overrides });
	const result = { ok: true, position: positionOf(), idempotent: false, scope: { workId: "w1", editionId: "e1", contentVersion: "v1" } };
	assert.equal(position.isReadingSaveResultForTicket(result, ticket), true);
	assert.equal(position.isReadingSaveResultForTicket({ ...result, scope: { workId: "w1", editionId: "e9", contentVersion: "v1" } }, ticket), false, "别的版本 scope 不算");
	assert.equal(position.isReadingSaveResultForTicket({ ...result, scope: { workId: "w1", editionId: "e1", contentVersion: "v9" } }, ticket), false, "别的版本号 scope 不算");
	assert.equal(position.isReadingSaveResultForTicket({ ...result, position: positionOf({ editionId: "e9" }) }, ticket), false, "位置本身指向别的版本也不算");
	assert.equal(position.isReadingSaveResultForTicket({ ok: false, error: { code: "writeFailed", message: "x" } }, ticket), false);
});

test("票据是否仍是当前视图：换书或换章后都不算（迟到 ACK 不落当前书）", () => {
	const ticketA = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	const sameChapter = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: " OEBPS/c1.xhtml ", chapterNum: 1, chapterTextDigest: "sha:abc" });
	const otherChapter = position.readingSaveTicket({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c2.xhtml", chapterNum: 2, chapterTextDigest: null });
	const otherBook = position.readingSaveTicket({ workId: "w1", editionId: "e2", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, chapterTextDigest: null });
	assert.equal(position.isReadingSaveTicketCurrent(ticketA, sameChapter), true);
	assert.equal(position.isReadingSaveTicketCurrent(ticketA, otherChapter), false);
	assert.equal(position.isReadingSaveTicketCurrent(ticketA, otherBook), false);
	assert.equal(position.isReadingSaveTicketCurrent(ticketA, null), false);
});
