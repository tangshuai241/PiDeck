import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("startup Pi update check is removed", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");

	// 回归：启动时不再自动检查 pi CLI 更新（曾在应用打开 1.2s 后弹
	// 「Pi 不是最新版本」toast 打扰启动流程）；版本检测只保留设置页手动入口。
	assert.doesNotMatch(app, /checkPiCliUpdateOnStartup/);
	assert.doesNotMatch(hook, /checkPiCliUpdateOnStartup|startupUpdateCheckDoneRef/);
});

test("opening dev settings does not auto-detect pi; cached result is shown directly", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
	const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
	const settings = readFileSync("src/shared/types/settings.ts", "utf8");

	// 回归：打开开发设置 tab 曾自动触发一次 pi 路径检测（spawn 探测），
	// 现在只有手动点「检测环境」才检测；已检测成功的结果从 settings 缓存直接恢复显示。
	assert.doesNotMatch(devTab, /activeTab === "dev" && props\.piStatus === null/);
	assert.match(devTab, /不自动检测 pi/);
	// settings 持久化字段 + 恢复逻辑（piStatus 为 null 时从缓存回填）
	assert.match(settings, /piInstall\?: \{ command: string; version: string \}/);
	assert.match(hook, /settings\.piInstall && piStatus === null/);
	assert.match(hook, /persistPiInstall/);
	// 未检测到时清除旧缓存，避免残留旧路径
	assert.match(hook, /清除旧缓存，避免残留/);
});

test("cached pi version is silently revalidated once per session (stale-while-revalidate)", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");

	// 回归：缓存版本曾永久过期——startup 检测只在首次引导跑（piEnvironmentChecked 之后
	// 没人纠正 settings.piInstall），pi 被外部升级后开发页一直显示旧版本（实测 0.84.4 vs 1.0.2）。
	// 修复：缓存照常立即显示，但每渲染会话静默复核一次并回写缓存；
	// 会话级闸门保证不会在打开设置页时重复 spawn（上面的测试约束不被破坏）。
	assert.match(hook, /piStatusRevalidatedRef/);
	assert.match(hook, /api\.pi\.check\(false\)/);
	// 探测失败/未安装时不得静默盖掉上次成功结果
	assert.match(hook, /if \(!next\.installed\) return;/);
});

/**
 * 找某个 `<SettingsSection>` 在文件里的起始偏移。
 * 不要用字面量 `'<SettingsSection title={t("...")}>'` 做 indexOf：锚点补全（20fdfcf40）给这些
 * 分区都加了 `id="settings-section-…"`，属性一多/一换位、或多个空格就永远找不到（红灯）。
 */
function sectionStart(source, titleKey) {
	return source.search(new RegExp(`<SettingsSection[^>]*t\\(\\s*"${titleKey}"\\s*\\)[^>]*>`));
}

test("Pi CLI update notice is anchored to its controls", () => {
	const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	const environmentStart = sectionStart(devTab, "settings.environment");
	const piNoticeStart = devTab.indexOf("{piUpdateNotice &&");
	const updatesStart = sectionStart(devTab, "settings.sectionUpdates");

	assert.ok(environmentStart >= 0, "environment section must exist");
	assert.ok(piNoticeStart > environmentStart && piNoticeStart < updatesStart, "Pi CLI update notice must appear in the environment section beside its action buttons");
	// 手动检查结果比定时后台快照新，且后台已发现更新时“更新 Pi”应可直接操作。
	assert.match(devTab, /const piUpdateStatus = props\.piUpdateCheck \?\? piCliStatus;/);
	assert.match(devTab, /const piUpdateAvailable = Boolean\(piUpdateStatus\?\.hasUpdate\);/);
	assert.match(devTab, /disabled=\{\s*!piUpdateAvailable\s*\}/);
	assert.match(zh, /可使用上方的「更新 Pi」操作更新/);
	assert.match(en, /Use Update Pi above to install it/);
});
