/**
 * 阅读边界校验窄测（P03）：服务地址回环白名单、id/章节引用形态、位置与笔记入参边界。
 * 纯函数测试：不触网、不碰文件。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const v = loadTsCommonJs("src/main/personal-workbench/reading/readingValidation.ts");
const { READING_DEFAULT_BASE_URL } = loadTsCommonJs("src/shared/types/reading.ts");

/** vm 沙箱对象原型与宿主不同；结构比较前转成宿主普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("服务地址：默认回环，只接受回环 http/https，拒远端/凭据/查询/片段/路径", () => {
	assert.deepEqual(plain(v.normalizeReadingBaseUrl(undefined)), { ok: true, baseUrl: READING_DEFAULT_BASE_URL });
	assert.deepEqual(plain(v.normalizeReadingBaseUrl("http://127.0.0.1:18965/")), { ok: true, baseUrl: "http://127.0.0.1:18965" });
	assert.deepEqual(plain(v.normalizeReadingBaseUrl("https://localhost:8443")), { ok: true, baseUrl: "https://localhost:8443" });
	assert.deepEqual(plain(v.normalizeReadingBaseUrl("http://[::1]:18965")), { ok: true, baseUrl: "http://[::1]:18965" });
	assert.equal(v.normalizeReadingBaseUrl("http://192.168.1.9:18965").ok, false, "拒非回环主机");
	assert.equal(v.normalizeReadingBaseUrl("https://deepread.example.com").ok, false, "拒外网域名");
	assert.equal(v.normalizeReadingBaseUrl("ftp://127.0.0.1:21").ok, false);
	assert.equal(v.normalizeReadingBaseUrl("http://user:pw@127.0.0.1:18965").ok, false, "拒内嵌凭据");
	assert.equal(v.normalizeReadingBaseUrl("http://127.0.0.1:18965/?x=1").ok, false);
	assert.equal(v.normalizeReadingBaseUrl("http://127.0.0.1:18965/api").ok, false);
	assert.equal(v.normalizeReadingBaseUrl("http://127.0.0.1:18965/#f").ok, false);
});

test("连接入参：地址+密码+记住密码；换行密码与非法布尔拒收", () => {
	const ok = v.parseReadingConnectInput({ baseUrl: "http://127.0.0.1:18965", password: "p a s s", rememberPassword: true });
	assert.equal(ok.ok, true);
	assert.equal(ok.input.baseUrl, "http://127.0.0.1:18965");
	assert.equal(ok.input.password, "p a s s");
	assert.equal(v.parseReadingConnectInput({ password: "x", rememberPassword: "yes" }).ok, false);
	assert.equal(v.parseReadingConnectInput({ password: "a\nb", rememberPassword: true }).error.detail.field, "password");
	assert.equal(v.parseReadingConnectInput(null).ok, false);
});

test("id 与章节引用：只允许安全字符；章节可传章号或 href", () => {
	assert.equal(v.parseReadingId("wrk_0123456789ab", "workId").ok, true);
	assert.equal(v.parseReadingId("edn_0123456789ab", "editionId").ok, true);
	assert.equal(v.parseReadingId("note_abc:def", "noteId").ok, true);
	assert.equal(v.parseReadingId("../../etc/passwd", "noteId").ok, false, "拒路径分隔符");
	assert.equal(v.parseReadingId("a".repeat(129), "noteId").ok, false);
	assert.equal(v.parseReadingId("", "noteId").ok, false);
	assert.equal(v.parseReadingChapterRef(3).chapter, "3");
	assert.equal(v.parseReadingChapterRef("3").chapter, "3");
	assert.equal(v.parseReadingChapterRef("OEBPS/ch1.xhtml").chapter, "OEBPS/ch1.xhtml");
	assert.equal(v.parseReadingChapterRef("0").ok, false);
	assert.equal(v.parseReadingChapterRef(-1).ok, false);
	assert.equal(v.parseReadingChapterRef("章节\n注入").ok, false);
	assert.equal(v.parseReadingChapterRequest({ workId: "wrk_a", editionId: "edn_b", chapter: 2 }).ok, true);
});

test("引文核验：text 必填、expectedVersion 必填、chapterHref 可省", () => {
	const ok = v.parseReadingResolveQuoteInput({ workId: "wrk_a", editionId: "edn_b", text: "原文", expectedVersion: "v1" });
	assert.equal(ok.ok, true);
	assert.equal(ok.chapterHref, null);
	const withHref = v.parseReadingResolveQuoteInput({ workId: "wrk_a", editionId: "edn_b", text: "原文", chapterHref: "c1.xhtml", expectedVersion: "v1" });
	assert.equal(withHref.chapterHref, "c1.xhtml");
	assert.equal(v.parseReadingResolveQuoteInput({ workId: "wrk_a", editionId: "edn_b", text: "", expectedVersion: "v1" }).ok, false);
	assert.equal(v.parseReadingResolveQuoteInput({ workId: "wrk_a", editionId: "edn_b", text: "原文" }).error.detail.field, "expectedVersion");
	assert.equal(v.parseReadingResolveQuoteInput({ workId: "wrk_a", editionId: "edn_b", text: "x".repeat(5001), expectedVersion: "v1" }).ok, false);
});

test("位置入参：fraction 0..1、contentVersion 必填、digest 可选", () => {
	const ok = v.parseReadingPositionSaveInput({ workId: "wrk_a", editionId: "edn_b", contentVersion: "cv1", fraction: 0.42, chapterNum: 3, chapterTextDigest: "d1" });
	assert.equal(ok.ok, true);
	assert.equal(ok.input.fraction, 0.42);
	assert.equal(v.parseReadingPositionSaveInput({ workId: "wrk_a", editionId: "edn_b", contentVersion: "cv1", fraction: 1.5 }).error.detail.field, "fraction");
	assert.equal(v.parseReadingPositionSaveInput({ workId: "wrk_a", editionId: "edn_b", contentVersion: "cv1", fraction: -0.1 }).ok, false);
	assert.equal(v.parseReadingPositionSaveInput({ workId: "wrk_a", editionId: "edn_b", fraction: 0.5 }).error.detail.field, "contentVersion");
	assert.equal(v.parseReadingPositionSaveInput({ workId: "wrk_a", editionId: "edn_b", contentVersion: "cv1", fraction: 0.5, chapterNum: -1 }).ok, false);
	const ref = v.parseReadingPositionRef({ workId: "wrk_a", editionId: "edn_b", contentVersion: "cv1" });
	assert.equal(ref.ok, true);
});

test("笔记入参：create/update/append 的必填与边界；noteId 形态", () => {
	const create = v.parseReadingNoteWriteInput({ operation: { op: "create", workId: "wrk_a", editionId: "edn_b", concept: "概念", chapter: "1.章", quote: "原句", understanding: "我的理解" } });
	assert.equal(create.ok, true);
	assert.equal(create.input.operation.op, "create");
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "create", workId: "wrk_a", editionId: "edn_b", concept: "  " } }).ok, false);
	const update = v.parseReadingNoteWriteInput({ operation: { op: "update", workId: "wrk_a", editionId: "edn_b", noteId: "note_1", section: "我的理解", content: "新内容", expectedRevision: "rev1" } });
	assert.equal(update.ok, true);
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "append", workId: "wrk_a", editionId: "edn_b", noteId: "note_1", section: "我的理解", content: "新内容" } }).error.detail.field, "expectedRevision");
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "update", workId: "wrk_a", editionId: "edn_b", noteId: "../x", section: "s", content: "c", expectedRevision: "r" } }).ok, false);
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "update", workId: "wrk_a", editionId: "edn_b", noteId: "note_1", section: "待探索", content: "c", expectedRevision: "r" } }).input.operation.section, "explore", "中文段落名在边界归一");
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "explode" } }).error.detail.field, "op");
	assert.equal(v.parseReadingNoteWriteInput({ operation: { op: "create", workId: "wrk_a", editionId: "edn_b", concept: "c" }, clientRequestId: "short" }).ok, false);
	const withRequest = v.parseReadingNoteWriteInput({ operation: { op: "create", workId: "wrk_a", editionId: "edn_b", concept: "c" }, clientRequestId: "req_12345678" });
	assert.equal(withRequest.input.clientRequestId, "req_12345678");
	assert.equal(v.parseReadingNoteRef({ workId: "wrk_a", noteId: "note_1" }).ok, true);
});

test("历史查询与引用：source 必填、游标与分页边界、草稿引用", () => {
	assert.equal(v.parseReadingHistoryQuery(undefined).error.detail.field, "query", "缺整包参数按不完整拒收");
	assert.equal(v.parseReadingHistoryQuery({}).error.detail.field, "source", "source 必填（wire 契约 §6）");
	const one = v.parseReadingHistoryQuery({ source: "deepread-legacy", cursor: "c1", limit: 10 });
	assert.equal(one.source, "deepread-legacy");
	assert.equal(one.limit, 10);
	assert.equal(v.parseReadingHistoryQuery({ source: "deepread-current" }).limit, 30, "缺省 30（与 wire 默认一致）");
	assert.equal(v.parseReadingHistoryQuery({ source: "other" }).error.detail.field, "source");
	assert.equal(v.parseReadingHistoryQuery({ source: "deepread-current", limit: 0 }).ok, false);
	assert.equal(v.parseReadingHistoryQuery({ source: "deepread-current", limit: 101 }).ok, false, "上限 100（wire 契约）");
	assert.equal(v.parseReadingHistoryRef({ source: "deepread-current", id: "sess-1" }).ok, true);
	assert.equal(v.parseReadingHistoryRef({ source: "nope", id: "sess-1" }).ok, false);
	const draftRef = v.parseReadingNoteDraftRef({ requestId: "nd_abc12345" });
	assert.equal(draftRef.ok, true);
	assert.equal(draftRef.ref.requestId, "nd_abc12345");
	assert.equal(v.parseReadingNoteDraftRef({}).ok, false, "requestId 必填");
	assert.equal(v.parseReadingNoteDraftRef({ requestId: "../x" }).ok, false);
	assert.equal(v.parseReadingNoteDraftRef({ requestId: "a".repeat(200) }).ok, false);
});
