/**
 * 阅读请求作用域与迟到守卫：切书/切版本后旧响应必须被判过期，合法章节才能进正文链路。
 *
 * 这些断言守住「迟到响应不落当前对象」这条产品规则：判据只有身份与 epoch，没有时间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const scope = loadTsCommonJs("src/renderer/src/utils/readingScope.ts");

const bookA = { workId: "w1", editionId: "e1" };
const bookB = { workId: "w1", editionId: "e2" };

test("书身份 key：不同版本不同 key，且长度前缀让含冒号的 id 不碰撞", () => {
	assert.notEqual(scope.readingBookKey(bookA), scope.readingBookKey(bookB));
	assert.equal(scope.readingBookKey(bookA), scope.readingBookKey({ workId: "w1", editionId: "e1" }));
	// '1:w:e' 与 'w:1:e' 这类组合必须区分开（长度前缀）
	assert.notEqual(scope.readingBookKey({ workId: "w", editionId: "1:e" }), scope.readingBookKey({ workId: "w:1", editionId: "e" }));
});

test("未发送输入的 key：同一本书下新建与不同笔记各自独立", () => {
	const key = scope.readingBookKey(bookA);
	assert.notEqual(scope.readingNoteInputKey(key, null), scope.readingNoteInputKey(key, "n1"));
	assert.notEqual(scope.readingNoteInputKey(key, "n1"), scope.readingNoteInputKey(key, "n2"));
	assert.equal(scope.readingNoteInputKey(key, "n1"), scope.readingNoteInputKey(key, "n1"));
});

test("请求票据：书身份或 epoch 变化即过期，没有活动票据也算过期", () => {
	const ticket = scope.readingRequestTicket({ bookKey: scope.readingBookKey(bookA), contentVersion: "v1", epoch: 1 });
	assert.equal(scope.isReadingTicketStale(ticket, null), true);
	assert.equal(scope.isReadingTicketStale(ticket, { ...ticket }), false);
	// 切书：身份不同 → 过期
	assert.equal(scope.isReadingTicketStale(ticket, scope.readingRequestTicket({ bookKey: scope.readingBookKey(bookB), contentVersion: "v1", epoch: 1 })), true);
	// 同一本书重新发起（连点目录/重新进入）：epoch 变了 → 旧响应过期
	assert.equal(scope.isReadingTicketStale(ticket, scope.readingRequestTicket({ bookKey: ticket.bookKey, contentVersion: "v1", epoch: 2 })), true);
	// 同一身份内版本探测完成不等于「请求过期」：正文不该因为版本回填被丢掉
	assert.equal(scope.isReadingTicketStale(ticket, scope.readingRequestTicket({ bookKey: ticket.bookKey, contentVersion: "v2", epoch: 1 })), false);
});

test("保存回执按 scope 判定：别的书、别的版本的回执不算当前对象", () => {
	const active = { workId: "w1", editionId: "e1", contentVersion: "v1" };
	assert.equal(scope.isReadingSaveScopeCurrent({ workId: "w1", editionId: "e1", contentVersion: "v1" }, active), true);
	assert.equal(scope.isReadingSaveScopeCurrent({ workId: "w1", editionId: "e2", contentVersion: "v1" }, active), false, "切版本的迟到回执不得套用到当前书");
	assert.equal(scope.isReadingSaveScopeCurrent({ workId: "w1", editionId: "e1", contentVersion: "v0" }, active), false, "旧版本的回执不得当成当前版本的保存结果");
});

test("章节选取：只有能映射章节且 href 非空的目录项才可选", () => {
	assert.equal(scope.isReadingChapterSelectable({ isChapter: true, href: "OEBPS/c1.xhtml", mapStatus: "chapter" }), true);
	assert.equal(scope.isReadingChapterSelectable({ isChapter: false, href: "cover.xhtml", mapStatus: "frontmatter" }), false, "前置页不进正文链路");
	assert.equal(scope.isReadingChapterSelectable({ isChapter: true, href: "   ", mapStatus: "chapter" }), false, "空 href 不可选");
	assert.equal(scope.readingChapterRequestTarget({ href: " OEBPS/c1.xhtml ", chapterNum: 3 }), "OEBPS/c1.xhtml", "优先用 toc href（核验与位置都用这个形态）");
	assert.equal(scope.readingChapterRequestTarget({ href: "", chapterNum: 3 }), 3, "没有 href 时退回章号");
	assert.equal(scope.readingChapterRequestTarget({ href: "", chapterNum: null }), null);
});
