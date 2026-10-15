import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const presentation = loadTsCommonJs("src/renderer/src/utils/personalTodoPresentation.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 使用完整记录工厂，检查展示策略不修改任何业务字段。 */
function view(id, overrides = {}) {
	const item = {
		id,
		title: id,
		note: "",
		category: null,
		deadline: null,
		urgency: null,
		status: "open",
		revision: "r1",
		createdAt: null,
		updatedAt: null,
		linkedTaskIds: [],
		subtodos: [],
		subtodoProgress: { total: 0, done: 0, open: 0, cancelled: 0 },
		source: { kind: "canonical", namespace: null, sourceId: null, fingerprint: null, rawAvailable: null },
		isRoot: true,
		parentId: null,
		parentSubtaskId: null,
		historyCount: null,
		...overrides,
	};
	return { item, confirmed: item, draft: null, sync: { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: [] };
}

test("分组完整保留完成、取消、未知日期和无日期事项；不猜时区", () => {
	const items = [
		view("past", { deadline: "2026-10-14" }),
		view("today", { deadline: "2026-10-15" }),
		view("future", { deadline: "2026-10-16" }),
		view("none"),
		view("text", { deadline: "下周" }),
		view("timestamp", { deadline: "2026-10-14T00:00:00Z" }),
		view("done", { deadline: "2026-10-01", status: "done" }),
		view("cancel", { deadline: "2026-10-01", status: "cancelled" }),
	];
	const before = JSON.stringify(items);
	const groups = presentation.groupPersonalTodos(items, "2026-10-15");
	assert.deepEqual(plain(groups.map((group) => [group.id, group.items.map((entry) => entry.item.id)])), [
		["overdue", ["past"]],
		["today", ["today"]],
		["upcoming", ["future"]],
		["undated", ["none", "text", "timestamp"]],
		["completed", ["done"]],
		["cancelled", ["cancel"]],
	]);
	assert.equal(JSON.stringify(items), before);
});

test("仅接受有效 YYYY-MM-DD 日期，包括闰年和世纪边界", () => {
	for (const day of ["2024-02-29", "2000-02-29", "2026-10-15"]) assert.equal(presentation.personalTodoCalendarDate(day), day);
	for (const day of [null, "", "明天", "2026-2-01", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "0000-01-01", "2026-10-15T00:00:00Z"]) assert.equal(presentation.personalTodoCalendarDate(day), null);
});

test("展示排序稳定、空紧急度排后、同组日期升序且不改变输入顺序", () => {
	const items = [view("a", { deadline: "2026-10-20", urgency: 1 }), view("b", { deadline: "2026-10-18", urgency: 3 }), view("c", { deadline: "2026-10-18", urgency: 3 }), view("d", { deadline: "2026-10-21" })];
	const ids = (order) =>
		plain(
			presentation
				.groupPersonalTodos(items, "2026-10-15", order)
				.find((group) => group.id === "upcoming")
				.items.map((entry) => entry.item.id),
		);
	assert.deepEqual(ids("source"), ["a", "b", "c", "d"]);
	assert.deepEqual(ids("deadline"), ["b", "c", "a", "d"]);
	assert.deepEqual(ids("urgency"), ["b", "c", "a", "d"]);
	assert.deepEqual(
		items.map((entry) => entry.item.id),
		["a", "b", "c", "d"],
	);
});

test("月历覆盖完整整周，跨年与闰年不丢日期", () => {
	const february = plain(presentation.personalTodoMonthDays(new Date(2024, 1, 1)));
	assert.equal(february.length % 7, 0);
	assert.equal(february.filter((entry) => entry.inMonth).length, 29);
	assert.equal(february.filter((entry) => entry.inMonth).at(-1).day, "2024-02-29");
	const january = plain(presentation.personalTodoMonthDays(new Date(2027, 0, 1)));
	assert.equal(january[0].day, "2026-12-27");
	assert.equal(january.filter((entry) => entry.inMonth).length, 31);
});
