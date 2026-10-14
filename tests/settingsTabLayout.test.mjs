import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// settingsTabLayout.ts 只含 type-only import（编译期擦除），无运行时依赖，可直接加载。
const { SETTINGS_TAB_LAYOUT, SETTINGS_TAB_IDS, SETTINGS_NAV_GROUPS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");

test("布局覆盖全部 20 个 tab 且不重复", () => {
	// loadTsCommonJs 在 vm 里执行，数组原型属于另一 realm，先展开到测试侧再比较
	const ids = [...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)];
	assert.equal(ids.length, 20);
	assert.equal(new Set(ids).size, ids.length);
	// SETTINGS_TAB_IDS 由布局派生，两者必须一致（单一事实来源）
	assert.deepEqual([...SETTINGS_TAB_IDS], ids);
});

test("展示顺序按 日常 → 工作区 → AI → 连接 → 维护 排列", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)], ["common", "appearance", "shortcuts", "notification", "terminal", "git", "editors", "vision", "imagegen", "videogen", "cloudmemory", "proxy", "im", "hostplugins", "pet", "usage", "process", "storage", "backup", "dev"]);
});

test("五个常驻分组独立持有标题和成员，扁平入口保留分组归属", () => {
	assert.deepEqual([...SETTINGS_NAV_GROUPS.map((group) => group.id)], ["daily", "workspace", "ai", "connections", "maintenance"]);
	for (const group of SETTINGS_NAV_GROUPS) {
		assert.ok(group.labelKey.startsWith("settings.groups."));
		assert.deepEqual([...SETTINGS_TAB_LAYOUT.filter((entry) => entry.group === group.id).map((entry) => entry.id)], [...group.tabs]);
	}
});
