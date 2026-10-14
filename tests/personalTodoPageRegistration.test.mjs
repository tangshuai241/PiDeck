/**
 * 功能页注册：目录只描述身份与可用性，正文由注册表分发。
 *
 * 断言的是「按页面 id 取到哪个正文」这一公开行为：P02 起待办页有渲染器，P03 起阅读页有渲染器；
 * 未注册的页面 id 返回 null，容器回落到目录里的状态说明。不写源码字符串扫描。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const TodoPageStub = function PersonalTodoPageStub() {
	return null;
};
const ReadingPageStub = function ReadingPageStub() {
	return null;
};

const registry = loadTsCommonJs("src/renderer/src/components/personal-workbench/personalWorkbenchPageRenderers.ts", {
	stubs: { "../todos/PersonalTodoPage": { PersonalTodoPage: TodoPageStub }, "../reading/ReadingPage": { ReadingPage: ReadingPageStub } },
});

test("已实现的页面有正文渲染器；未注册的页面回落到目录里的状态说明", () => {
	assert.equal(registry.personalWorkbenchPageRenderer("todo"), TodoPageStub, "待办页正文由注册表提供");
	assert.equal(registry.personalWorkbenchPageRenderer("reading"), ReadingPageStub, "P03 起阅读页正文由注册表提供");
	assert.equal(registry.personalWorkbenchPageRenderer("not-a-page"), null, "未注册的页面不臆造渲染器");
});
