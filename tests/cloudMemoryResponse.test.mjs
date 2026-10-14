// pi-deck-cloud-memory 回包层（有界读取 + unknown 收窄）的针对性测试（N03 两级工具）。
// 用 loadTsCommonJs 加载生产 TS；不产生真实网络。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里产出的对象原型与测试 realm 不同，deepStrictEqual 会因原型不等而失败；比较前转成纯 JSON。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function assertPlain(actual, expected, message) {
	assert.deepEqual(plain(actual), expected, message);
}

const response = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-response.ts");

function textResponse(text, headers = {}) {
	return { status: 200, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, text: async () => text };
}

function streamResponse(chunks, { cancel } = {}) {
	let index = 0;
	const canceled = [];
	return {
		status: 200,
		headers: { get: () => null },
		body: {
			getReader: () => ({
				read: async () => (index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true }),
				cancel: async () => {
					canceled.push(true);
					if (cancel) cancel();
				},
				releaseLock: () => {},
			}),
		},
		canceled,
	};
}

test("有界读取：content-length 先拒；流式超限即 cancel；text 回退读完再拒", async () => {
	const declared = await response.readBoundedResponseText(textResponse("{}", { "content-length": String(response.MAX_RESPONSE_BYTES + 1) }), response.MAX_RESPONSE_BYTES);
	assertPlain(declared, { kind: "error", reason: "response_too_large" });

	const big = streamResponse(["a".repeat(1000), "b".repeat(1000)]);
	const streamed = await response.readBoundedResponseText(big, 1500);
	assertPlain(streamed, { kind: "error", reason: "response_too_large" });
	assert.equal(big.canceled.length, 1, "超限必须立即 cancel，不继续缓冲");

	const ok = await response.readBoundedResponseText(streamResponse(['{"ok":', "true}"]), 1024);
	assertPlain(ok, { kind: "ok", text: '{"ok":true}' });

	const fallback = await response.readBoundedResponseText(textResponse("x".repeat(2048)), 1024);
	assertPlain(fallback, { kind: "error", reason: "response_too_large" });
	assertPlain(await response.readBoundedResponseText({}, 1024), { kind: "error", reason: "invalid_response" });
});

test("server_timing：缺字段保持 null，形状不对归 null", () => {
	assertPlain(response.parseServerTiming({ hindsight_ms: 12 }), { hindsight_ms: 12, server_total_ms: null });
	assert.equal(response.parseServerTiming(undefined), null);
	assertPlain(response.parseServerTiming({ hindsight_ms: -1, server_total_ms: "x" }), { hindsight_ms: null, server_total_ms: null });
});

test("search 回包：完整新字段、缺字段保持 unknown/null、空结果也是成功", () => {
	const outcome = response.parseSearchResponse(200, {
		ok: true,
		timing: { hindsight_ms: 12, server_total_ms: 30 },
		budget: { max_tokens: 500, limit: 20, partial: true },
		dropped: 3,
		upstream_returned: 25,
		items: [
			{
				id: "m1",
				text: "remembered text",
				document_id: "doc1",
				source_id: "src_1",
				scope: "personal",
				mentioned_at: "2026-10-01T00:00:00Z",
				preview_truncated: true,
				sources: [{ source_id: "src_1", role: "user", occurred_at: "2026-09-30T00:00:00Z", revision: 2 }],
			},
			{ id: "m2", text: "no markers" },
		],
	});
	assert.equal(outcome.kind, "items");
	assertPlain(outcome.budget, { maxTokens: 500, limit: 20, partial: true });
	assertPlain(outcome.indicators, { dropped: 3, droppedOutdated: null, upstreamReturned: 25 });
	assert.equal(outcome.serverTiming.hindsight_ms, 12);
	assert.equal(outcome.items[0].previewTruncated, true);
	assertPlain(outcome.items[0].sources, [{ sourceId: "src_1", role: "user", occurredAt: "2026-09-30T00:00:00Z", revision: 2, textSha256: null }]);
	assert.equal(outcome.items[1].previewTruncated, null);
	assert.equal(outcome.items[1].sources, "unknown");
	assert.equal(outcome.items[1].scope, null);

	const empty = response.parseSearchResponse(200, { ok: true, available: true, items: [] });
	assert.equal(empty.kind, "items");
	assertPlain(empty.items, []);
	assertPlain(empty.budget, { maxTokens: null, limit: null, partial: null });
	assertPlain(empty.indicators, { dropped: null, droppedOutdated: null, upstreamReturned: null }, "缺指标不得猜成 0");

	const topLevelPartial = response.parseSearchResponse(200, { ok: true, items: [], partial: false, max_tokens: 100 });
	assertPlain(topLevelPartial.budget, { maxTokens: 100, limit: null, partial: false });

	const emptySources = response.parseSearchResponse(200, { ok: true, items: [{ id: "m", text: "t", sources: [] }] });
	assert.equal(emptySources.items[0].sources, "missing", "空来源列表按「无来源」处理");
});

test("search 回包：可用性/权限/不存在/传输上限/坏条目各自结构化，不伪装成功", () => {
	assertPlain(response.parseSearchResponse(200, { available: false }), { kind: "unavailable" });
	assertPlain(response.parseSearchResponse(401, { ok: false }), { kind: "auth_required" });
	assertPlain(response.parseSearchResponse(403, { ok: false }), { kind: "auth_required" });
	assertPlain(response.parseSearchResponse(404, { ok: false }), { kind: "not_found" });
	assertPlain(response.parseSearchResponse(409, { ok: false }), { kind: "error", reason: "revision_conflict" });
	assertPlain(response.parseSearchResponse(500, { ok: false }), { kind: "error", reason: "http_500" });
	assertPlain(response.parseSearchResponse(200, { ok: false, code: "quota_exhausted" }), { kind: "error", reason: "quota_exhausted" });
	assertPlain(response.parseSearchResponse(200, { ok: false, reason: "query 太长的自由文本" }), { kind: "error", reason: "cloud_error" }, "自由文本不得回显");
	assertPlain(response.parseSearchResponse(200, { ok: true, items: [{ id: "m" }] }), { kind: "error", reason: "invalid_items" });
	assertPlain(response.parseSearchResponse(200, null), { kind: "error", reason: "invalid_response" });
	const tooMany = response.parseSearchResponse(200, { ok: true, items: Array.from({ length: response.MAX_SEARCH_ITEMS + 1 }, (_, index) => ({ id: `m${index}`, text: "t" })) });
	assertPlain(tooMany, { kind: "error", reason: "too_many_items" });
	assertPlain(response.parseSearchResponse(200, { ok: true, items: [{ id: "m", text: "t", sources: "unknown" }] }).items[0].sources, "unknown");
});

test("source 回包：嵌套与顶层两种形态、分页字段、多来源与 pieces 都如实", () => {
	const nested = response.parseSourceResponse(200, {
		ok: true,
		source: { source_id: "src_1", role: "user", occurred_at: "2026-10-01T00:00:00Z", revision: 3, project: "TPA", content: "原文", offset: 0, next_offset: 8, total_chars: 20, text_sha256: "abc", base_sha256: "abc", partial: true, record_index: 1, included: true },
	});
	assert.equal(nested.kind, "source");
	assertPlain(nested.source.pieces, []);
	assert.equal(nested.source.piecesUnknown, true, "服务端未给 pieces 即 unknown，不是「没有多条消息」");
	assert.equal(nested.source.nextOffset, 8);
	assert.equal(nested.source.partial, true);
	assert.equal(nested.source.baseSha256, "abc");
	assert.equal(nested.source.recordIndex, 1);
	assert.equal(nested.source.included, true);
	assert.equal(nested.source.recordsUnknown, true, "未给 records 列表时不得声称只有一条");

	// paging 对象是可选兼容形态：顶层缺字段时从这里回填，仍然绑定同一版本哈希。
	const paged = response.parseSourceResponse(200, {
		ok: true,
		source: { source_id: "src_3", content: "第二段", paging: { offset: 8, next_offset: 16, total_chars: 24, partial: true, base_sha256: "b".repeat(64) } },
	});
	assert.equal(paged.source.offset, 8);
	assert.equal(paged.source.nextOffset, 16);
	assert.equal(paged.source.totalChars, 24);
	assert.equal(paged.source.partial, true);
	assert.equal(paged.source.baseSha256, "b".repeat(64));

	const multi = response.parseSourceResponse(200, {
		ok: true,
		record_index: 1,
		included: false,
		source_type: "user_confirmed",
		confirmation: "explicit_user_confirmation",
		source: {
			source_id: "src_2",
			content: "选中的那条",
			records: [
				{ source_id: "src_0", role: "user", text_sha256: "z", included: false, type: "user_statement", confirmation: "self_reported" },
				{ source_id: "src_2", role: "assistant", text_sha256: "a", included: false, type: "assistant_answer", confirmation: "unconfirmed" },
			],
		},
	});
	assert.equal(multi.source.records.length, 2);
	assert.equal(multi.source.recordsUnknown, false);
	assert.equal(multi.source.recordIndex, 1);
	assert.equal(multi.source.included, false);
	assert.equal(multi.source.records[1].sourceId, "src_2");
	assert.equal(multi.source.sourceType, "user_confirmed", "get_memory_source 顶层 source_type 透传");
	assert.equal(multi.source.confirmation, "explicit_user_confirmation");
	assert.equal(multi.source.records[0].type, "user_statement", "records[] 逐条透传 type/confirmation");
	assert.equal(multi.source.records[0].confirmation, "self_reported");
	assert.equal(multi.source.records[1].type, "assistant_answer");
	assert.equal(multi.source.records[1].confirmation, "unconfirmed");

	const flat = response.parseSourceResponse(200, {
		ok: true,
		source_id: "src_2",
		content: "",
		pieces: [{ source_id: "src_2", role: "assistant", occurred_at: null, revision: 1, text_sha256: "d" }],
	});
	assert.equal(flat.source.content, "");
	assert.equal(flat.source.pieces.length, 1);
	assert.equal(flat.source.piecesUnknown, false);
	assert.equal(flat.source.role, null);

	const badPieces = response.parseSourceResponse(200, { ok: true, source: { content: "x", pieces: "nope" } });
	assert.equal(badPieces.source.piecesUnknown, true);
	assert.equal(badPieces.source.content, "x");
});

test("source 回包：404/403/409 与缺失 content 都是真实状态，不伪装成功", () => {
	assertPlain(response.parseSourceResponse(404, { ok: false }), { kind: "missing" });
	assertPlain(response.parseSourceResponse(403, { ok: false }), { kind: "auth_required" });
	assertPlain(response.parseSourceResponse(409, { ok: false }), { kind: "conflict" });
	assertPlain(response.parseSourceResponse(200, { available: false }), { kind: "unavailable" });
	assertPlain(response.parseSourceResponse(200, { ok: false, code: "conflict_revision" }), { kind: "error", reason: "conflict_revision" });
	assertPlain(response.parseSourceResponse(200, { ok: true, source: { content: 5 } }), { kind: "error", reason: "invalid_source_content" });
	assertPlain(response.parseSourceResponse(200, { ok: true, source: { content: "x".repeat(response.MAX_SOURCE_CONTENT_CHARS + 1) } }), { kind: "error", reason: "invalid_source_content" });
	assertPlain(response.parseSourceResponse(500, { ok: false }), { kind: "error", reason: "http_500" });
});

test("recall items 新字段：分类/确认/有效期/项目/替代与来源哈希都可空收窄，未知不当已确认，旧 payload 兼容", () => {
	const full = response.parseSearchResponse(200, {
		ok: true,
		items: [
			{
				id: "m1",
				text: "用户说过周五复盘",
				scope: "personal",
				source_type: "user_statement",
				confirmation: "self_reported",
				valid_from: "2026-10-01",
				valid_to: "2026-12-31T00:00:00.000Z",
				project: "TPA",
				superseded_by: "src_newer",
				sources: [{ source_id: "src_1", role: "user", occurred_at: "2026-10-01T00:00:00Z", revision: 2, text_sha256: "a".repeat(64) }],
			},
			// 未知枚举 + 坏日期 + 对象形态 superseded_by：一律 null，不得当成已确认。
			{ id: "m2", text: "未知分类", source_type: "not_a_type", confirmation: "maybe", valid_from: "not-a-date", superseded_by: { source_id: "src_2" }, sources: [] },
			// 旧 payload：完全没有新字段。
			{ id: "m3", text: "旧条目" },
		],
	});
	assert.equal(full.kind, "items");
	const [first, second, legacy] = full.items;
	assert.equal(first.sourceType, "user_statement");
	assert.equal(first.confirmation, "self_reported");
	assert.equal(first.validFrom, "2026-10-01");
	assert.equal(first.validTo, "2026-12-31T00:00:00.000Z");
	assert.equal(first.project, "TPA");
	assert.equal(first.supersededBy, "src_newer");
	assert.equal(first.sources[0].textSha256, "a".repeat(64), "来源哈希必须保留（formatter 用它标注来源）");

	assert.equal(second.sourceType, null, "未知 source_type 归 null");
	assert.equal(second.confirmation, null, "未知 confirmation 不得当已确认");
	assert.equal(second.validFrom, null, "无法解析的日期归 null（Date.parse 合法即保留，与 E 的给值条件一致）");
	assert.equal(second.supersededBy, "src_2", "对象形态 superseded_by 取 source_id");
	assert.equal(second.sources, "missing");

	assert.equal(legacy.sourceType, null);
	assert.equal(legacy.confirmation, null);
	assert.equal(legacy.validFrom, null);
	assert.equal(legacy.validTo, null);
	assert.equal(legacy.project, null);
	assert.equal(legacy.supersededBy, null);
	assert.equal(legacy.sources, "unknown", "旧 payload 缺 sources 仍是 unknown，不伪造成 missing");
});
