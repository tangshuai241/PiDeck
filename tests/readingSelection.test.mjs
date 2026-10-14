/**
 * 选区快照：偏移只在核验通过时填写；身份三件套齐备；核验状态如实映射。
 *
 * 快照是 P04 的稳定入口，本节点不发往任何会话；测试只断言构造规则。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里创建的对象属于另一个 realm；先归一成纯 JSON 再比对。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const selection = loadTsCommonJs("src/renderer/src/utils/readingSelection.ts");

test("异步核验后的快照保留当前核验结果；迟到快照不覆盖新的选区", () => {
	const verified = quote();
	const snapshot = selection.createReadingSelectionSnapshot({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, text: "原文", quote: verified });
	const current = { snapshot: null, quote: verified, verifying: false, error: null };
	const settled = selection.applyReadingSelectionSnapshot(current, snapshot, verified);
	assert.equal(settled.quote, verified, "写快照不得把刚收到的核验结果重置为旧闭包中的 null");
	assert.equal(settled.snapshot, snapshot);
	const cleared = { ...current, quote: null };
	assert.equal(selection.applyReadingSelectionSnapshot(cleared, snapshot, verified), cleared);
	const newer = { ...current, quote: quote() };
	assert.equal(selection.applyReadingSelectionSnapshot(newer, snapshot, verified), newer);
	assert.equal(selection.applyReadingSelectionSnapshot(current, { ...snapshot, editionId: "other" }, verified), current);
});

function quote(overrides = {}) {
	return {
		ok: true,
		identity: { workId: "w1", editionId: "e1", contentVersion: "v1", filename: null, size: null },
		status: "exact",
		candidates: [{ chapterNum: 1, href: "OEBPS/c1.xhtml", title: "第一章", matchStatus: "exact", matchLevel: "chapter", start: 12, end: 20, chapterWordCount: 100 }],
		candidatesTruncated: false,
		note: null,
		...overrides,
	};
}

test("核验状态映射：四种服务端状态各有文案，未知不冒充通过", () => {
	assert.equal(selection.readingQuoteStatusKey("exact"), "reading.quoteExact");
	assert.equal(selection.readingQuoteStatusKey("normalized"), "reading.quoteNormalized");
	assert.equal(selection.readingQuoteStatusKey("ambiguous"), "reading.quoteAmbiguous");
	assert.equal(selection.readingQuoteStatusKey("unmatched"), "reading.quoteUnmatched");
	assert.equal(selection.readingQuoteStatusKey("whatever"), "reading.quoteUnknown");
});

test("偏移只在 exact/normalized 且候选带完整 start/end 时填写", () => {
	assert.deepEqual(plain(selection.readingQuoteOffsets(quote())), { start: 12, end: 20 });
	assert.deepEqual(plain(selection.readingQuoteOffsets(quote({ status: "normalized" }))), { start: 12, end: 20 });
	assert.deepEqual(plain(selection.readingQuoteOffsets(quote({ status: "unmatched", candidates: [] }))), { start: null, end: null }, "未匹配不得填偏移");
	assert.deepEqual(plain(selection.readingQuoteOffsets(quote({ status: "ambiguous" }))), { start: null, end: null }, "有歧义不挑第一个候选");
	assert.deepEqual(plain(selection.readingQuoteOffsets(quote({ candidates: [{ chapterNum: 1, href: "x", title: "t", matchStatus: "exact", matchLevel: "chapter", start: 5, end: null, chapterWordCount: null }] }))), { start: null, end: null }, "start/end 不完整就留空");
	assert.deepEqual(plain(selection.readingQuoteOffsets({ ok: false, error: { code: "notFound", message: "x" } })), { start: null, end: null });
	assert.deepEqual(plain(selection.readingQuoteOffsets(null)), { start: null, end: null });
});

test("快照身份：版本与章节照实记录，偏移随核验结果；时间可注入", () => {
	const snapshot = plain(selection.createReadingSelectionSnapshot({ workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, text: "一段原文", quote: quote(), capturedAt: "2026-01-02T03:04:05.000Z" }));
	assert.deepEqual(snapshot, { workId: "w1", editionId: "e1", contentVersion: "v1", chapterHref: "OEBPS/c1.xhtml", chapterNum: 1, text: "一段原文", start: 12, end: 20, capturedAt: "2026-01-02T03:04:05.000Z" });
	const unverified = plain(selection.createReadingSelectionSnapshot({ workId: "w1", editionId: "e1", contentVersion: "v2", chapterHref: "OEBPS/c1.xhtml", chapterNum: null, text: "一段原文", quote: quote({ status: "unmatched", candidates: [] }), capturedAt: "2026-01-02T03:04:05.000Z" }));
	assert.equal(unverified.start, null);
	assert.equal(unverified.end, null);
	assert.equal(unverified.contentVersion, "v2", "身份以本次正文为准，不取自核验结果");
});

test("空/纯空白选区不发起核验", () => {
	assert.equal(selection.readingSelectionVerifiable("一段原文"), true);
	assert.equal(selection.readingSelectionVerifiable("   \n\t "), false);
	assert.equal(selection.readingSelectionVerifiable(""), false);
});
