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

	// 外观设置 tab：主题 Select（系统/浅色/深色）→ 外观主题卡片（每套自带主色）
	await modal.getByText("外观设置").click();
	// 背景图字段渲染（选图/清除按钮存在；弹系统对话框不在 e2e 范围）
	await expect(modal.getByText("背景图片")).toBeVisible();
	await expect(modal.getByRole("button", { name: "选择图片…" })).toBeVisible();
	// 外观主题卡片（radio）：选择森系绿 → 联动主色 green
	await modal.getByRole("radio", { name: "森系绿" }).click();

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
