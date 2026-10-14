/**
 * P04 UI 入口窄契约测试（阅读选区按钮 / 待办详情入口 / 注册表注入面）。
 *
 * 断言的是「入口只追加材料、不发送；绑定失效不清选区；目标会话身份显式」这些可复核事实。
 * 正则全部空白容忍；行为逻辑的单测在 workbenchMaterialSession.test.mjs 与 hooks 测试里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

const chapterView = read("src/renderer/src/components/reading/ReadingChapterView.tsx");
const readingPage = read("src/renderer/src/components/reading/ReadingPage.tsx");
const readingEntry = read("src/renderer/src/components/reading/ReadingMaterialEntry.tsx");
const readingBring = read("src/renderer/src/hooks/useReadingMaterialBring.ts");
const todoEntry = read("src/renderer/src/components/todos/TodoMaterialEntry.tsx");
const todoDetail = read("src/renderer/src/components/todos/PersonalTodoDetail.tsx");
const registry = read("src/renderer/src/components/personal-workbench/personalWorkbenchPageRenderers.ts");
const pageBody = read("src/renderer/src/components/personal-workbench/PersonalWorkbenchPageBody.tsx");
const overlay = read("src/renderer/src/components/personal-workbench/PersonalWorkbenchPageOverlay.tsx");
const zhCn = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const enUs = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
const zhTw = read("src/renderer/src/i18n/rendererCopy.zh-TW.ts");

const SEND_PATTERNS = [/sendPrompt/, /dispatchPromptSnapshot/, /submitPromptSnapshot/, /createSessionRuntime/, /api\.sessions\.send/];

test("入口绝不自动发送或调用模型：材料只走 appendMaterial", () => {
	for (const [label, source] of [
		["ReadingMaterialEntry", readingEntry],
		["useReadingMaterialBring", readingBring],
		["TodoMaterialEntry", todoEntry],
	]) {
		for (const pattern of SEND_PATTERNS) {
			assert.doesNotMatch(source, pattern, `${label} 不得调用发送链路（${pattern}）`);
		}
	}
	// 阅读入口把追加能力注入控制器；控制器是唯一追加点；新建会话是唯一的会话创建动作
	assert.match(readingEntry, /useReadingMaterialBring\(/);
	assert.match(readingEntry, /appendMaterial/);
	assert.match(readingBring, /deps\.appendMaterial\(\{ sessionId/);
	assert.match(readingEntry, /createDraft: \(input\) => api\.sessions\.createDraft\(input\)/);
});

test("绑定失效不清选区：stale 只提示重绑/解绑，不调用 clearSelection、不静默新建", () => {
	assert.doesNotMatch(readingEntry, /clearSelection/);
	assert.match(readingEntry, /workbenchMaterial\.stale/);
	assert.match(readingEntry, /workbenchMaterial\.rebind/);
	assert.match(readingEntry, /controller\.unbindBound/);
	// 解绑带点击时书身份，不碰其它书
	assert.match(readingBring, /deps\.binding\.unbind\(\{ workId: current\.workId, editionId: current\.editionId \}\)/);
});

test("阅读页选区按钮：正文视图给插槽，页面合成材料入口并传版本身份", () => {
	assert.match(chapterView, /selectionAction\?: ReactNode/);
	assert.match(chapterView, /\{props\.selectionAction\}/);
	assert.match(readingPage, /<ReadingMaterialEntry/);
	assert.match(readingPage, /contentVersion=\{contentVersion\}/);
	// 竞态行为在 readingMaterialBringHook.test.mjs 行为回归；这里只锁入口接线
	assert.match(readingEntry, /useReadingMaterialBring\(/);
	assert.match(readingBring, /readingMaterialFromSource/);
});

test("待办入口：父项与子项都保留身份，子项走 subtodoId 参数；取消不得产生已带入提示", () => {
	assert.match(todoDetail, /<TodoMaterialEntry view=\{view\} projectId=\{projectId\}/);
	assert.match(todoDetail, /subtodoId=\{materialSubtodoId\}/);
	assert.match(todoEntry, /createTodoMaterial\(\{ view: props\.view, subtodoId: props\.subtodoId \}\)/);
	// 确认时重新在候选里找目标（会话被删后不得继续带入）；取消不产生 notice
	assert.match(todoEntry, /const target = targets\.find\(\(entry\) => entry\.id === picked\)/);
	assert.match(todoEntry, /onCancel=\{props\.onCancel\}/);
	assert.match(todoDetail, /onCancel=\{\(\) => setMaterialSubtodoId\(null\)\}/);
});

test("注册表注入面：项目与会话打开动作经容器薄转交，不在页面里自造导航", () => {
	assert.match(registry, /onOpenSession\?: \(projectId: string, sessionId: string\) => void \| Promise<void>/);
	assert.match(pageBody, /<Renderer projectId=\{projectId\} onOpenSession=\{onOpenSession\} \/>/);
	assert.match(overlay, /onOpenSession=\{props\.onRestoreSession\}/);
	assert.match(readingPage, /onOpenSession=\{props\.onOpenSession\}/);
});

test("i18n 三语键位齐全（新增入口文案不得硬编码）", () => {
	const keys = [
		"workbenchMaterial.bringToSession",
		"workbenchMaterial.boundTo",
		"workbenchMaterial.changeSession",
		"workbenchMaterial.unbind",
		"workbenchMaterial.rebind",
		"workbenchMaterial.selectSession",
		"workbenchMaterial.confirmBring",
		"workbenchMaterial.confirmBindBring",
		"workbenchMaterial.cancel",
		"workbenchMaterial.noSession",
		"workbenchMaterial.newSession",
		"workbenchMaterial.newSessionTitle",
		"workbenchMaterial.openSession",
		"workbenchMaterial.noticeBrought",
		"workbenchMaterial.noticeDuplicate",
		"workbenchMaterial.noticeBound",
		"workbenchMaterial.noticeCreated",
		"workbenchMaterial.stale",
		"workbenchMaterial.errorMaterial",
		"workbenchMaterial.errorBind",
		"workbenchMaterial.errorBindUnavailable",
		"workbenchMaterial.errorCreate",
	];
	for (const key of keys) {
		for (const [locale, source] of [
			["zh-CN", zhCn],
			["en-US", enUs],
			["zh-TW", zhTw],
		]) {
			assert.match(source, new RegExp(`"${key.replace(/\./g, "\\.")}"\\s*:`), `${locale} 缺 ${key}`);
		}
	}
	// JSX 里不得出现中英文字面量文案
	for (const [label, source] of [
		["ReadingMaterialEntry", readingEntry],
		["TodoMaterialEntry", todoEntry],
	]) {
		assert.doesNotMatch(source, />[\u4e00-\u9fff][^<{]*</, `${label} 不得硬编码中文文案`);
		assert.doesNotMatch(source, /placeholder="[A-Za-z]/, `${label} 不得硬编码英文占位文案`);
	}
});
