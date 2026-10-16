import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { summarizeConfigUnsavedChanges, formatConfigUnsavedMessage } = loadTsCommonJs("src/renderer/src/config/configUnsavedChangesSummary.ts");
const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");

test("无脏标记时返回 null，回退到通用未保存文案", () => {
	assert.equal(summarizeConfigUnsavedChanges([]), null);
	assert.equal(
		formatConfigUnsavedMessage(null, (key) => `#${key}`),
		"#config.unsavedMessage",
	);
});

test("多条脏 tab 时单行兜底文案带计数，插值用单花括号（t() 契约）", () => {
	const zh = String(i18n.exports?.rendererCopy ?? "");
	const summary = summarizeConfigUnsavedChanges(["config:models", "security"]);
	const text = formatConfigUnsavedMessage(summary, (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key));
	assert.match(text, /count/);
	assert.doesNotMatch(zh, /\{\{tab\}\}/);
});

test("装配契约：关闭确认用点名列表", () => {
	assert.match(configModal, /configUnsavedSummary\?\.items\.map/);
	assert.match(configModal, /config\.unsavedListIntro/);
});

test("装配契约：保存并关闭汇总全部脏来源（不再只存当前 tab）", () => {
	// 保存顺序必须经 orderDirtyKeysForSave：settings 最后保存，否则它的 force 重载
	// 会连带把 models/auth/raw 的未保存草稿冲成磁盘内容（保存并关闭路径同样适用）。
	assert.match(configModal, /for \(const key of orderDirtyKeysForSave\(roots\)\)/);
	assert.doesNotMatch(configModal, /for \(const key of roots\)/);
	assert.match(configModal, /saveByKey\(key\)/);
});
