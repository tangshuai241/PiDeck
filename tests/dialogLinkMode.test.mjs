import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 弹框（Dialog/Modal/Overlay）内的链接必须强制系统浏览器打开：
// 内置浏览器面板位于 Dialog 下层不可见，linkOpenMode=internal 时跟随设置打开会被遮挡，
// 用户表现为“点了没反应”。统一规则与 ConfigShared.openDocsInSystemBrowser 一致（forceSystem=true）。

test("config diagnostic docs link forces system browser", () => {
	const src = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(src, /onOpenDocs=\{\(\) => api\.app\.openExternal\(configDiagnostic\.docsUrl, true\)\}/);
});

test("environment dialog nodejs link forces system browser in dialog implementations", () => {
	// OverlayComponents 版是 EnvironmentDialog 唯一实现（含 pi 环境三步引导）；
	// AppParts 现在只 re-export，不再持实现。两处 nodejs.org 外链都必须 forceSystem。
	const overlay = readFileSync("src/renderer/src/components/overlays/OverlayComponents.tsx", "utf8");
	assert.match(overlay, /window\.piDesktop\.app\.openExternal\(\s*"https:\/\/nodejs\.org\/zh-cn\/download\/",\s*true\s*\)/);
	const guide = readFileSync("src/renderer/src/components/overlays/EnvironmentGuidePanel.tsx", "utf8");
	assert.match(guide, /openExternal\("https:\/\/nodejs\.org\/zh-cn\/download\/", true\)/);
});
