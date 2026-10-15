import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

const appRequire = createRequire(resolve("apps/android/package.json"));
const stubs = {};
for (const name of ["unified", "remark-parse", "remark-gfm"]) stubs[name] = { __esModule: true, ...(await import(pathToFileURL(appRequire.resolve(name)).href)) };
const load = createTsSandbox({ stubs });
const { parseNativeMarkdown, safeMarkdownUrl, markdownText, tableColumnWidths } = load(resolve("apps/android/src/markdown.ts"));

test("weather output becomes a four-column GFM table with all seven forecast rows", () => {
	const source = "武汉天气\n\n| 日期 | 天气 | 气温 | 风 |\n| --- | --- | --- | --- |\n" + Array.from({ length: 7 }, (_, i) => `| ${15 + i}日 | 小雨 | 18°C | 微风 |`).join("\n");
	const tree = parseNativeMarkdown(source);
	const table = tree.children.find((node) => node.type === "table");
	assert.equal(table.children.length, 8);
	assert.equal(table.children[1].children.length, 4);
	assert.match(markdownText(tree), /21日/);
	assert.equal(tableColumnWidths(table).length, 4);
});

test("headings, emphasis, lists, quotes and code retain their semantic nodes", () => {
	const tree = parseNativeMarkdown("# 标题\n\n**粗体**与[来源](https://example.com)\n\n- 第一条\n- 第二条\n\n> 引用\n\n```sh\necho 'a|b'\n```\n\n最后一句");
	assert.deepEqual(
		Array.from(tree.children, (node) => node.type),
		["heading", "paragraph", "list", "blockquote", "code", "paragraph"],
	);
	assert.match(markdownText(tree), /最后一句$/);
	assert.equal(tree.children[4].value, "echo 'a|b'");
});

test("unfinished streaming tables settle without losing the final row or pipe escapes", () => {
	const source = "| A | B |\n| --- | --- |\n| a\\|b | `x` |\n| 最后 | 内容 |";
	for (let end = 1; end <= source.length; end++) assert.doesNotThrow(() => parseNativeMarkdown(source.slice(0, end)));
	const table = parseNativeMarkdown(source).children[0];
	assert.equal(markdownText(table.children[1].children[0]), "a|b");
	assert.equal(markdownText(table.children[2].children[1]), "内容");
});

test("external links allow only web and mail schemes; local and executable URLs stay inert", () => {
	for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///secret", "intent://x", "//example.com", "https://x\n.bad"]) assert.equal(safeMarkdownUrl(value), undefined);
	assert.equal(safeMarkdownUrl("https://example.com/a"), "https://example.com/a");
	assert.equal(safeMarkdownUrl("mailto:test@example.com"), "mailto:test@example.com");
});

test("oversized markdown degrades to selectable literal content instead of dropping data", () => {
	const source = "x".repeat(13000);
	assert.equal(markdownText(parseNativeMarkdown(source)), source);
});

test("temperature ranges and Windows short paths preserve single tildes while double tilde still deletes", () => {
	const source = "今天到周五：18~26°C，周日到周一回落到16~21°C。路径 C:\\ADMINI~1\\DOCUME~1。~~过期~~";
	const tree = parseNativeMarkdown(source);
	const children = tree.children[0].children;
	assert.equal(children.filter((node) => node.type === "delete").length, 1);
	assert.match(markdownText(tree), /18~26°C/);
	assert.match(markdownText(tree), /16~21°C/);
});

// Exercise the real component tree with native primitives replaced only at the host boundary.
const native =
	(tag) =>
	({ children, accessibilityRole }) =>
		React.createElement(tag, { role: accessibilityRole }, children);
const renderLoad = createTsSandbox({
	stubs: {
		...stubs,
		react: React,
		"react/jsx-runtime": jsxRuntime,
		"react-native": {
			Text: native("span"),
			View: native("div"),
			ScrollView: native("section"),
			useWindowDimensions: () => ({ fontScale: 1 }),
			Alert: { alert() {} },
			Linking: {
				openURL() {
					throw new Error("render must never open a link");
				},
			},
		},
	},
});
const { NativeMarkdown } = renderLoad(resolve("apps/android/src/ui/NativeMarkdown.tsx"));
const colors = { text: "#222", secondary: "#666", muted: "#eee", border: "#aaa", primary: "#246", background: "white", surface: "white" };

test("native view renders header cells and table body instead of displaying delimiter text", () => {
	const output = renderToStaticMarkup(React.createElement(NativeMarkdown, { text: "| 日期 | 气温 |\n| --- | --- |\n| 周五 | 18°C |\n\n结尾内容", colors }));
	assert.equal((output.match(/role="header"/g) || []).length, 2);
	assert.match(output, /18°C/);
	assert.match(output, /结尾内容/);
	assert.doesNotMatch(output, /---/);
});

test("native view keeps code and HTML literal, without creating active scripts or images", () => {
	const output = renderToStaticMarkup(React.createElement(NativeMarkdown, { text: "```js\n<script>bad()</script>\n```\n\n![说明](https://example.com/tracker.png)\n\n[危险](javascript:alert)\n\n<script>raw()</script>", colors }));
	assert.match(output, /&lt;script&gt;/);
	assert.match(output, /说明/);
	assert.doesNotMatch(output, /<script|<img|role="link"/);
});
