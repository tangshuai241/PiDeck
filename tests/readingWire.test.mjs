/**
 * 阅读 wire 适配窄测（P03）：snake_case → camelCase 单点转换、错误分类与请求体。
 * 纯函数测试：不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const wire = loadTsCommonJs("src/main/personal-workbench/reading/readingWire.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("书库：catalog 为主，books 兜底补版本；work/edition/rel 原样", () => {
	const works = wire.parseWireLibrary(
		{
			ok: true,
			works: [
				{ work_id: "wrk_a", title: "书一", author: "作者", edition_count: 1, editions: [{ edition_id: "edn_1", rel: "books/a.epub", size: 10, mtime: 1, title: "第一版" }] },
				{ work_id: "wrk_b", title: "书二", author: null, editions: [] },
			],
		},
		{ ok: true, books_dir: "E:/books", books: [{ name: "b.epub", path: "E:/books/b.epub", rel: "b.epub", size: 20, mtime: 2, work_id: "wrk_b", edition_id: "edn_2", title: "书二" }] },
	);
	assert.equal(works.length, 2);
	assert.deepEqual(plain(works[0].editions[0]), { editionId: "edn_1", rel: "books/a.epub", size: 10, mtime: 1, title: "第一版" });
	assert.equal(works[1].editionCount, 1, "books 兜底补上的版本计入数量");
	assert.equal(works[1].editions[0].editionId, "edn_2");
	assert.equal(wire.parseWireLibrary(null, null).length, 0);
});

test("版本身份/目录/spine/analysis：content_version 与 map_status 原样", () => {
	const view = wire.parseWireEditionView(
		{
			ok: true,
			identity: { filename: "a.epub", size: 123, sha256: "abc", edition_id: "edn_1", content_version: "cv1" },
			toc: [
				{ pos: 0, href: "nav.xhtml", raw_href: "nav.xhtml", title: "封面", is_chapter: false, chapter_num: null, map_status: "frontmatter" },
				{ pos: 1, href: "ch1.xhtml", title: "第一章", is_chapter: true, chapter_num: 1, map_status: "chapter" },
			],
			spine: [
				{ index: 0, href: "nav.xhtml" },
				{ index: 1, href: "ch1.xhtml" },
			],
			analysis: { found: true, match_quality: "exact", files: ["a.json", "b.json"], match_basis: "dir-name" },
		},
		{ workId: "wrk_a", editionId: "edn_1" },
	);
	assert.equal(view.identity.workId, "wrk_a");
	assert.equal(view.identity.contentVersion, "cv1");
	assert.equal(view.toc[0].mapStatus, "frontmatter");
	assert.equal(view.toc[1].chapterNum, 1);
	assert.equal(view.spine.length, 2);
	assert.equal(view.analysis.fileCount, 2);
	assert.equal(wire.parseWireEditionView({ ok: true }, { workId: "wrk_a", editionId: "edn_1" }), null, "缺 identity 不造记录");
});

test("正文：offset_unit 声明保留、text 原样、chapter_num 兼容", () => {
	const parsed = wire.parseWireChapter({ ok: true, identity: { content_version: "cv9", edition_id: "edn_1" }, chapter: { chapter_num: 2, title: "第二章", href: "ch2.xhtml", text: "正文内容", word_count: 4, text_digest: "d9", offset_unit: "unicode_code_point" } }, { workId: "wrk_a", editionId: "edn_1" });
	assert.equal(parsed.chapter.text, "正文内容");
	assert.equal(parsed.chapter.wordCount, 4);
	assert.equal(parsed.chapter.offsetUnit, "unicode_code_point");
	assert.equal(parsed.identity.contentVersion, "cv9");
	assert.equal(wire.parseWireChapter({ ok: true, identity: { content_version: "cv1" } }, { workId: "wrk_a", editionId: "edn_1" }), null);
});

test("引文核验：candidates 与 code point 偏移原样；note/truncated 保留", () => {
	const parsed = wire.parseWireQuote(
		{ ok: true, identity: { content_version: "cv1" }, status: "matched", candidates: [{ chapter_num: 1, href: "ch1.xhtml", title: "第一章", match_status: "exact", match_level: "sentence", start: 10, end: 20, chapter_word_count: 100 }], candidates_truncated: true, note: "跨章" },
		{ workId: "wrk_a", editionId: "edn_1" },
	);
	assert.equal(parsed.status, "matched");
	assert.equal(parsed.candidates[0].start, 10);
	assert.equal(parsed.candidates[0].end, 20);
	assert.equal(parsed.candidatesTruncated, true);
	assert.equal(parsed.note, "跨章");
	assert.equal(wire.parseWireQuote({ ok: true }, { workId: "wrk_a", editionId: "edn_1" }), null);
});

test("笔记：by-work 的 notes/unattributed/link_status、读取 truncated、写入结果状态机", () => {
	const list = wire.parseWireNoteList({
		ok: true,
		work: { work_id: "wrk_a", title: "书一" },
		edition: { edition_id: "edn_1", filename: "a.epub" },
		edition_match: "exact",
		notes: [{ note_id: "note_1", source: "deepread", name: "概念", chapter_label: "1.章", revision: "sha256:aa", updated_at: "2026-10-14T00:00:00Z", unlocated: false, link_status: "linked" }],
		unattributed: [{ note_id: "note_x", source: "deepread", name: "别的书", chapter_label: null, revision: null, updated_at: "2026-10-01T00:00:00Z", unlocated: true, link_status: "pending" }],
		truncated: true,
	});
	assert.equal(list.notes.length, 1);
	assert.equal(list.notes[0].noteId, "note_1");
	assert.equal(list.notes[0].unlocated, false, "unlocated 以服务端判定为准");
	assert.equal(list.notes[0].linkStatus, "linked");
	assert.equal(list.unattributed.length, 1, "归属未知单独可见，不合并");
	assert.equal(list.unattributed[0].linkStatus, "pending");
	assert.equal(list.truncated, true);
	const bare = wire.parseWireNoteList({ ok: true, notes: [{ note_id: "note_2", name: "旧概念" }] });
	assert.equal(bare.notes[0].unlocated, true, "服务端未给 unlocated 时才用无标签兜底");
	assert.equal(bare.unattributed.length, 0);
	assert.equal(wire.parseWireNoteList({ ok: true }), null, "形状不合法返回 null");
	const read = wire.parseWireNoteRead({ ok: true, note: { noteId: "note_1", name: "概念", revision: "sha256:bb" }, content: "正文（截断）", truncated: true });
	assert.equal(read.truncated, true);
	assert.equal(read.content, "正文（截断）");
	assert.equal(read.note.revision, "sha256:bb");
	// 写：只有 ok:true + applied + revision 才算已保存
	const applied = wire.parseWireNoteWriteOutcome({ ok: true, request_id: "rq", replayed: false, state: "applied", op: "create", note: { note_id: "note_3", name: "新概念", revision: "sha256:cc" } });
	assert.equal(applied.ok, true);
	assert.equal(applied.state, "applied");
	const pending200 = wire.parseWireNoteWriteOutcome({ ok: false, request_id: "rq", replayed: true, state: "pending", op: "create", error: { code: "unknownOutcome", message: "x", detail: { reason: "INTENT_PENDING" } } });
	assert.equal(pending200.ok, false, "HTTP 200 的 pending 不算成功");
	assert.equal(pending200.state, "pending");
	assert.equal(pending200.error.code, "unknownOutcome");
	assert.equal(pending200.replayed, true);
	const conflict = wire.parseWireNoteWriteOutcome({ ok: false, request_id: "rq", state: "unknown", error: { code: "conflict", message: "x", detail: { reason: "REQUEST_CONFLICT" } } });
	assert.equal(conflict.error.code, "conflict");
	assert.equal(conflict.error.detail.reason, "REQUEST_CONFLICT");
	const probe = wire.parseWireNoteRequest({ ok: true, request_id: "rq", op: "append", state: "applied", replayed: false, note: { note_id: "note_3", name: "新概念", revision: "sha256:dd" }, updated_at: "2026-10-14T01:00:00Z" });
	assert.equal(probe.state, "applied");
	assert.equal(probe.note.revision, "sha256:dd");
});

test("旧历史：两源、unattributed 原样、分页游标", () => {
	const sources = wire.parseWireHistorySources({ ok: true, sources: [{ source: "deepread-current", label: "当前树", root: "E:/state/sessions", count: 31, readable: true }, { source: "deepread-legacy", label: "旧树", root: "E:/old/sessions", count: 18, readable: true }, { source: "weird" }] });
	assert.equal(sources.length, 2);
	assert.equal(sources[1].count, 18);
	const list = wire.parseWireHistoryList({ ok: true, source: "deepread-legacy", items: [{ id: "s1", title: "会话", book: "旧书", attribution: "unattributed", provider: "deepread", model: "m", updated_at: "2026-10-01T00:00:00Z", counts: { messages: 3 } }], next_cursor: "c2" });
	assert.equal(list.sessions[0].source, "deepread-legacy");
	assert.equal(list.sessions[0].attribution, "unattributed", "归属未知原样保留");
	assert.equal(list.sessions[0].bookLabel, "旧书");
	assert.equal(list.sessions[0].readable, true, "readable 缺省视为可读");
	assert.equal(list.sessions[0].error, null);
	assert.equal(list.nextCursor, "c2");
	assert.equal(wire.parseWireHistoryList({ nope: true }), null);
	// 详情：session 与 raw 都来自本次响应，truncated 原样转达
	const detail = wire.parseWireHistorySessionDetail({ ok: true, session: { source: "deepread-legacy", id: "s1", attribution: "unattributed", readable: false, error: "parse_failed" }, raw: "{原始}", truncated: true }, "不该用到");
	assert.equal(detail.session.id, "s1");
	assert.equal(detail.session.readable, false);
	assert.equal(detail.session.error, "parse_failed");
	assert.equal(detail.raw, "{原始}");
	assert.equal(detail.truncated, true);
	const fallback = wire.parseWireHistorySessionDetail({ ok: true, session: { id: "s2" }, truncated: false }, "原文兜底");
	assert.equal(fallback.raw, "原文兜底", "raw 缺字段时用响应文本兜底，不重序列化");
});

test("错误分类：401 needsConnection、新接口 404 unsupported、普通 404 notFound、5xx unavailable", () => {
	assert.equal(wire.mapReadingHttpError({ status: 401, json: null, feature: null }).code, "needsConnection");
	assert.equal(wire.mapReadingHttpError({ status: 404, json: null, feature: "notes" }).code, "unsupported");
	assert.equal(wire.mapReadingHttpError({ status: 404, json: null, feature: "history" }).code, "unsupported");
	assert.equal(wire.mapReadingHttpError({ status: 404, json: null, feature: null }).code, "notFound");
	assert.equal(wire.mapReadingHttpError({ status: 400, json: null, feature: null }).code, "invalidInput");
	assert.equal(wire.mapReadingHttpError({ status: 409, json: null, feature: null }).code, "conflict");
	assert.equal(wire.mapReadingHttpError({ status: 503, json: null, feature: "notes" }).code, "unavailable", "503 归服务不可用，不算未部署");
	assert.equal(wire.mapReadingHttpError({ status: 501, json: null, feature: "notes" }).code, "unsupported", "501 表示接口未启用");
	assert.equal(wire.mapReadingHttpError({ status: 500, json: null, feature: null }).code, "unavailable");
	assert.equal(wire.mapReadingHttpError({ status: null, json: null, feature: null }).code, "unavailable");
	// 服务端错误体优先：同一枚举 + detail.reason
	const stale = wire.mapReadingHttpError({ status: 409, json: { ok: false, error: { code: "staleVersion", message: "x", detail: { reason: "NOTE_REVISION_CONFLICT", current_revision: "sha256:ee" } } }, feature: "notes" });
	assert.equal(stale.code, "staleVersion");
	assert.equal(stale.detail.reason, "NOTE_REVISION_CONFLICT");
	assert.equal(stale.detail.current_revision, "sha256:ee");
	const unregistered = wire.mapReadingHttpError({ status: 404, json: { ok: false, error: { code: "notFound", message: "x" } }, feature: "notes" });
	assert.equal(unregistered.code, "notFound", "结构化 notFound 说明端点已部署，按真实语义归 notFound，不能当未部署");
	// 边界 1：只有「裸 404/405/501」（响应体没有结构化 error.code）才是未部署
	assert.equal(wire.mapReadingHttpError({ status: 404, json: { detail: "Not Found" }, feature: "notes" }).code, "unsupported", "裸 404 才是未部署");
	assert.equal(wire.mapReadingHttpError({ status: 405, json: null, feature: "history" }).code, "unsupported", "裸 405 才是未部署");
	// 边界 2：结构化错误体优先于状态码兜底（405/501 也不当未部署吞掉真实错误）
	assert.notEqual(wire.mapReadingHttpError({ status: 405, json: { ok: false, error: { code: "notFound", message: "x" } }, feature: "history" }).code, "unsupported", "有结构化错误体的 405 不能当未部署");
	assert.equal(wire.mapReadingHttpError({ status: 501, json: { detail: "Not Implemented" }, feature: "notes" }).code, "unsupported", "结构化缺失的 501 仍是未部署");
});

test("请求体：note write snake_case；history query 参数", () => {
	const create = wire.buildNoteWriteBody({ op: "create", workId: "wrk_a", editionId: "edn_b", concept: "概念", chapter: "1.章", quote: "原句", understanding: "理解" }, "req_1");
	assert.deepEqual(plain(create), { request_id: "req_1", op: "create", work_id: "wrk_a", edition_id: "edn_b", concept: "概念", chapter: "1.章", quote: "原句", understanding: "理解" });
	const update = wire.buildNoteWriteBody({ op: "append", workId: "wrk_a", editionId: "edn_b", noteId: "note_1", section: "我的理解", content: "补充", expectedRevision: "rev1" }, "req_2");
	assert.deepEqual(plain(update), { request_id: "req_2", op: "append", work_id: "wrk_a", edition_id: "edn_b", note_id: "note_1", section: "understanding", content: "补充", expected_revision: "rev1" }, "中文段落名归一成 wire 枚举");
	assert.equal(wire.canonicalNoteSection("quote"), "quote");
	assert.equal(wire.canonicalNoteSection("待探索"), "explore");
	assert.equal(wire.buildHistoryQuery({ source: "deepread-legacy", cursor: "c1", limit: 20 }), "source=deepread-legacy&limit=20&cursor=c1");
	assert.equal(wire.buildHistoryQuery({ source: "deepread-current", cursor: null, limit: 30 }), "source=deepread-current&limit=30", "source 必填");
	assert.equal(wire.buildHistorySessionQuery("deepread-current", "s1"), "source=deepread-current&id=s1");
});
