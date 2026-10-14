import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

/**
 * 外观主题切换回归（issue #115 收尾时修复）：设置里改主题色必须立即生效——
 * 曾因 App.tsx applyTheme effect 依赖缺 settings.accent 导致 data-accent 不更新。
 * UI 2.0 重构后外观主题选择器（themeSkin + 自带主色 accent）替代了独立主色下拉：
 * 选择森系绿 → data-appearance=fresh-green 且联动 data-accent=green。
 * 出厂默认 classic-green 绑定黑白灰主色，因此初始 data-accent 为 default。
 */
test("appearance theme switch applies data-appearance and bundled accent", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await expect(window.locator("html")).toHaveAttribute("data-accent", "default");
	await expect(window.locator("html")).toHaveAttribute("data-appearance", "classic-green");

	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	// 外观设置 tab：明暗预览卡片 → 外观主题卡片（每套自带主色）
	await modal.getByText("外观").click();
	// 背景图字段渲染（选图/清除按钮存在；弹系统对话框不在 e2e 范围）
	await expect(modal.getByText("背景图片", { exact: true }).first()).toBeVisible();
	await expect(modal.getByRole("button", { name: "选择图片…" })).toBeVisible();
	// T3 卡片之外，原有主题仍可从兼容入口选择并联动主色。
	await modal.getByRole("combobox", { name: "原有主题", exact: true }).click();
	await window.getByRole("option", { name: "森系绿", exact: true }).click();

	// 保存后即时生效：data-appearance 与 data-accent 同时更新
	await modal.getByRole("button", { name: "保存" }).click();
	await expect(window.locator("html")).toHaveAttribute("data-appearance", "fresh-green");
	await expect(window.locator("html")).toHaveAttribute("data-accent", "green");

	// 关闭弹窗后保持
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-appearance", "fresh-green");
	await expect(window.locator("html")).toHaveAttribute("data-accent", "green");
});

/** 常驻分组、搜索和原有锚点定位共用真实桌面设置页面。 */
test("settings navigation shows persistent groups and searches field anchors", async ({ window }, testInfo) => {
	await window.setViewportSize({ width: 1440, height: 1000 });
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	const nav = modal.getByRole("complementary", { name: "设置分类" });
	await expect(nav.getByRole("heading")).toHaveText(["日常设置", "工作区", "AI 能力", "连接与扩展", "维护与诊断"]);
	await expect(nav.locator("[aria-expanded]")).toHaveCount(0);
	await expect(nav.getByRole("tab")).toHaveCount(20);
	const search = nav.getByRole("textbox", { name: "搜索设置…" });
	await search.fill("session tab width");
	await nav.getByRole("button", { name: "会话 Tab 宽度上限", exact: true }).click();
	await expect(nav.getByRole("tab", { name: "外观", exact: true })).toHaveAttribute("data-state", "active");
	await expect(modal.locator("#settings-section-appearance-session-tab-width")).toBeInViewport();
	await search.fill("no-such-setting-829");
	await expect(nav.getByRole("status")).toHaveText("没有找到相关设置");
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(modal).toBeVisible();
	await expect(nav.getByRole("heading")).toHaveCount(5);
	await nav.getByRole("tab", { name: "常规", exact: true }).click();
	await nav.getByRole("tab", { name: "外观", exact: true }).click();
	await modal.getByRole("radio", { name: "浅色", exact: true }).click();
	await window.screenshot({ path: testInfo.outputPath("navigation-light.png") });
	await modal.getByRole("radio", { name: "暗色", exact: true }).click();
	await window.screenshot({ path: testInfo.outputPath("navigation-dark.png") });
	await modal.getByRole("tab", { name: "模型与工具", exact: true }).click();
	await expect(modal.getByRole("tab", { name: "Pi 配置管理", exact: true })).toBeVisible();
	await modal.getByRole("tab", { name: "应用设置", exact: true }).click();
	await expect(modal.getByRole("radio", { name: "暗色", exact: true })).toBeChecked();
});

/** 新的明暗卡片沿用草稿预览与保存边界；方向键和窄窗口均可操作。 */
test("appearance cards support keyboard selection, cancel, save and narrow windows", async ({ window }, testInfo) => {
	await window.setViewportSize({ width: 1440, height: 1000 });
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await modal.getByRole("tab", { name: "外观", exact: true }).click();
	const light = modal.getByRole("radio", { name: "浅色", exact: true });
	const dark = modal.getByRole("radio", { name: "暗色", exact: true });
	await light.click();
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
	await window.screenshot({ path: testInfo.outputPath("appearance-light.png") });

	await light.focus();
	// Radix 用异步 roving focus 识别仍按住的方向键；保留真实按键的按下阶段。
	await window.keyboard.press("ArrowRight", { delay: 80 });
	await expect(dark).toBeChecked();
	await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
	await window.screenshot({ path: testInfo.outputPath("appearance-dark.png") });
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await expect(light).toBeChecked();
	await expect(window.locator("html")).toHaveAttribute("data-theme", "light");

	await modal.getByRole("radio", { name: "跟随时间", exact: true }).click();
	await expect(modal.getByLabel("浅色开始", { exact: true })).toBeVisible();
	await light.click();
	await modal.getByRole("combobox", { name: "原有主题", exact: true }).click();
	await window.getByRole("option", { name: "森系绿", exact: true }).click();
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
	await modal.getByRole("button", { name: "关闭", exact: true }).first().click();
	await openSettings(window);
	await modal.getByRole("tab", { name: "外观", exact: true }).click();
	await expect(light).toBeChecked();
	await expect(modal.getByRole("combobox", { name: "原有主题", exact: true })).toHaveText("森系绿");
	await window.screenshot({ path: testInfo.outputPath("appearance-green.png") });

	await window.setViewportSize({ width: 800, height: 900 });
	await expect(light).toBeVisible();
	const panel = modal.locator('[role="tabpanel"][data-state="active"]').last();
	await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
	await window.screenshot({ path: testInfo.outputPath("appearance-narrow.png") });
	await modal.getByRole("tab", { name: "常规", exact: true }).click();
	await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
	await window.screenshot({ path: testInfo.outputPath("settings-rows-narrow.png") });
	await window.setViewportSize({ width: 1440, height: 1000 });
	await window.screenshot({ path: testInfo.outputPath("settings-rows.png") });
});
