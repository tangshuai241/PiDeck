/**
 * 历史分页与呈现：两源不合并、同 id 不同 source 各自保留、游标决定 more、归属与坏文件如实标注。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里创建的对象属于另一个 realm；先归一成纯 JSON 再比对。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const history = loadTsCommonJs("src/renderer/src/utils/readingHistory.ts");

function session(overrides = {}) {
	return { source: "deepread-current", id: "s1", title: "会话", bookLabel: "书", chapterLabel: "章", attribution: "bound", provider: null, model: null, updatedAt: null, counts: null, readable: true, error: null, ...overrides };
}

test("分页合并：同一条不重复，同 id 不同 source 各自保留（不跨源去重）", () => {
	const first = [session({ id: "a" }), session({ id: "b" })];
	const page = [session({ id: "b" }), session({ id: "c" }), session({ id: "a", source: "deepread-legacy" })];
	const merged = plain(history.mergeReadingHistoryPage(first, page)).map((entry) => `${entry.source}:${entry.id}`);
	assert.deepEqual(merged, ["deepread-current:a", "deepread-current:b", "deepread-current:c", "deepread-legacy:a"]);
	assert.equal(history.readingHistorySessionKey({ source: "deepread-current", id: "a" }), history.readingHistorySessionKey({ source: "deepread-current", id: "a" }));
	assert.notEqual(history.readingHistorySessionKey({ source: "deepread-current", id: "a" }), history.readingHistorySessionKey({ source: "deepread-legacy", id: "a" }));
});

test("列表状态：unsupported / loading / empty / rows 四态分开", () => {
	assert.equal(history.resolveReadingHistoryListState({ loading: true, unsupported: true, sessionCount: 0 }), "unsupported", "接口未部署优先说明，不显示加载中");
	assert.equal(history.resolveReadingHistoryListState({ loading: true, unsupported: false, sessionCount: 0 }), "loading");
	assert.equal(history.resolveReadingHistoryListState({ loading: false, unsupported: false, sessionCount: 0 }), "empty");
	assert.equal(history.resolveReadingHistoryListState({ loading: false, unsupported: false, sessionCount: 3 }), "rows");
});

test("more 只看服务端游标：没有游标就不猜还有下一页", () => {
	assert.equal(history.readingHistoryHasMore({ ok: true, nextCursor: "c1" }), true);
	assert.equal(history.readingHistoryHasMore({ ok: true, nextCursor: null }), false);
	assert.equal(history.readingHistoryHasMore({ ok: true, nextCursor: "" }), false);
	assert.equal(history.readingHistoryHasMore({ ok: false }), false);
	assert.equal(history.readingHistoryHasMore(null), false);
});

test("归属与坏文件：unattributed 单独标注；不可读原样保留原因", () => {
	assert.equal(history.readingHistoryAttributionKey("unattributed"), "reading.historyUnattributed");
	assert.equal(history.readingHistoryAttributionKey("bound"), null, "正常归属不占位");
	assert.equal(history.readingHistoryUnreadable(session({ readable: false, error: "boom" })), true);
	assert.equal(history.readingHistoryUnreadable(session()), false);
	assert.equal(history.readingHistorySourceStateKey({ source: "deepread-legacy", label: "旧目录", root: "/x", count: 3, readable: false }), "reading.historySourceUnreadable");
	assert.equal(history.readingHistorySourceStateKey({ source: "deepread-legacy", label: "旧目录", root: "/x", count: 0, readable: true }), null);
});

test("计数与原文可用性：只透传服务端数字，空原文不当作可回看", () => {
	assert.deepEqual(plain(history.readingHistoryCountEntries(session({ counts: { messages: 3, notes: 1 } }))), [
		{ key: "messages", value: 3 },
		{ key: "notes", value: 1 },
	]);
	assert.deepEqual(plain(history.readingHistoryCountEntries(session({ counts: null }))), []);
	assert.equal(history.readingHistoryRawAvailable({ ok: true, raw: "{}" }), true);
	assert.equal(history.readingHistoryRawAvailable({ ok: true, raw: "" }), false);
	assert.equal(history.readingHistoryRawAvailable(null), false);
});
