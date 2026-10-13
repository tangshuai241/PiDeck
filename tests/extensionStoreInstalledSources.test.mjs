import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (path) => readFileSync(path, "utf8");
const { projectInstalledExtensionSources } = loadTsCommonJs("src/renderer/src/config/resourceScopeModel.ts");

const extensionRow = (source, scope) => ({ id: `${scope}:${source}`, source, scope });
const discoveryItem = (source, sourceId) => ({ source, sourceId, path: `/tmp/${source}`, sourceLabel: sourceId, physicalScope: "project", enabled: true, managed: true });

test("项目里装的包通过发现条目计入商店卡片已安装判据", () => {
	// 场景：项目 scope 商店装 npm:billion-context-pi → 记录写进项目 settings.json 的 packages；
	// 项目列表只扫 .pi/extensions 目录、pi list 又看不到项目包，只有 package-project 发现条目带 npm:<name>。
	const sources = projectInstalledExtensionSources([extensionRow("local-ext-dir", "project")], [discoveryItem("npm:billion-context-pi", "package-project")]);
	assert.equal(sources.has("npm:billion-context-pi"), true, "项目安装的包必须标记已安装，否则卡片会重复触发 pi install -l");
});

test("全局已装的包不点亮项目卡片：项目卡片动作是装进本项目", () => {
	const sources = projectInstalledExtensionSources([extensionRow("npm:globally-installed", "user")], []);
	assert.equal(sources.has("npm:globally-installed"), false);
});

test("只有 package-project 发现条目计入，settings/祖先/全局包不算", () => {
	const sources = projectInstalledExtensionSources([], [discoveryItem("npm:user-package", "package-user"), discoveryItem("/abs/settings-ext.ts", "settings-project"), discoveryItem("/abs/ancestor.ts", "ancestor-agents")]);
	assert.deepEqual([...sources], []);
});
