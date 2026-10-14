import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveSettingsNavigation } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsNavigationSearch.ts");
const { SETTINGS_TAB_LAYOUT } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
const translate = (key) => (key === "settings.tabs.appearance" ? "外观" : key);
const ids = (groups) => Array.from(groups).flatMap((group) => Array.from(group.items, (item) => item.id));

test("empty search retains all five groups and every visible tab", () => {
	const groups = resolveSettingsNavigation(SETTINGS_TAB_LAYOUT, "  ", translate);
	assert.equal(groups.length, 5);
	assert.equal(ids(groups).length, 20);
	assert.ok(groups.every((group) => group.items.every((item) => item.fields.length === 0)));
});

test("search finds translated titles and aliases across groups", () => {
	assert.deepEqual(ids(resolveSettingsNavigation(SETTINGS_TAB_LAYOUT, "外观", translate)), ["appearance"]);
	assert.deepEqual(ids(resolveSettingsNavigation(SETTINGS_TAB_LAYOUT, "字体", translate)), ["appearance", "terminal"]);
	assert.deepEqual(ids(resolveSettingsNavigation(SETTINGS_TAB_LAYOUT, "settings.groups.ai", translate)), ["vision", "imagegen", "videogen", "cloudmemory"]);
});

test("multiword search is case insensitive and returns a real field anchor", () => {
	const groups = resolveSettingsNavigation(SETTINGS_TAB_LAYOUT, "  SESSION   tab WIDTH  ", translate);
	const appearance = groups.flatMap((group) => group.items).find((item) => item.id === "appearance");
	assert.ok(appearance.fields.some((field) => field.slug === "appearance-session-tab-width"));
});

test("search does not resurrect hidden tabs or leave empty headings", () => {
	const visible = SETTINGS_TAB_LAYOUT.filter((entry) => entry.id !== "imagegen");
	// 外观页的模块显示设置也包含“生图”别名，仍应可搜索；隐藏的生图页自身不能出现。
	const result = resolveSettingsNavigation(visible, "生图", translate);
	assert.deepEqual(ids(result), ["appearance"]);
	assert.ok(result[0].items[0].fields.length > 0);
	assert.equal(resolveSettingsNavigation(visible, "no-such-setting-829", translate).length, 0);
});
