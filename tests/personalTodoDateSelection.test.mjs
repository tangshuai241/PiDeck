import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const dates = loadTsCommonJs("src/renderer/src/utils/personalTodoDateSelection.ts");
test("日历只转换明确日期，不把日期原文或 UTC 时间戳猜成本机日期", () => {
	for (const raw of [null, "下周", "2026-02-30", "2026-10-15T23:00:00Z"]) assert.equal(dates.personalTodoPickerDate(raw), undefined);
	const early = dates.personalTodoPickerDate("0099-01-02");
	assert.equal(early.getFullYear(), 99);
	assert.equal(early.getMonth(), 0);
	assert.equal(early.getDate(), 2);
});
test("日期快捷项跨月跨年；下周一始终是下一周的周一", () => {
	assert.equal(dates.personalTodoQuickDate("today", new Date(2026, 9, 15)), "2026-10-15");
	assert.equal(dates.personalTodoQuickDate("tomorrow", new Date(2026, 11, 31)), "2027-01-01");
	assert.equal(dates.personalTodoQuickDate("fortnight", new Date(2026, 11, 25)), "2027-01-08");
	assert.equal(dates.personalTodoQuickDate("nextMonday", new Date(2026, 9, 15)), "2026-10-19");
	assert.equal(dates.personalTodoQuickDate("nextMonday", new Date(2026, 9, 19)), "2026-10-26");
	assert.equal(dates.personalTodoQuickDate("nextMonday", new Date(2026, 9, 18)), "2026-10-19");
});
