import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

test.use({ seedSettings: { theme: "light", themeSkin: "t3-iris" } });

test.beforeEach(async ({ window }) => {
	// The fixture records onboarding as seen; reload also cancels its already-scheduled popup.
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0);
});

test("model and tool pages share settings navigation and retain security drafts", async ({ window }, testInfo) => {
	test.setTimeout(90_000);
	await window.setViewportSize({ width: 1600, height: 1100 });
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: "模型与工具", exact: true }).click();
	const nav = dialog.locator(".config-sidebar");
	await expect(nav).toBeVisible();
	await expect(nav).toHaveCSS("width", "216px");
	for (const label of ["模型", "认证", "设置", "信任", "MCP", "源文件", "扩展", "技能", "提示词模板", "安全"]) {
		await nav.getByRole("tab", { name: label, exact: true }).click();
		await expect(dialog.locator("[data-config-page]:visible").getByRole("heading", { name: label, exact: true })).toBeVisible();
	}
	const security = dialog.locator(".security-section");
	await expect(security.getByRole("switch", { name: "启用安全管理" })).toBeVisible();
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("config-security-light.png") });
	const standard = security.getByRole("button", { name: /^标准/ });
	await standard.click();
	await expect(standard).toHaveAttribute("aria-expanded", "true");
	const description = security.getByRole("textbox", { name: "描述", exact: true });
	await description.fill("UI draft stays across navigation");
	await nav.getByRole("tab", { name: "模型", exact: true }).click();
	await nav.getByRole("tab", { name: "安全", exact: true }).click();
	await expect(description).toHaveValue("UI draft stays across navigation");
	await expect(standard).toHaveAttribute("aria-expanded", "true");
	const search = nav.getByRole("textbox");
	await search.fill("MCP");
	await expect(nav.getByRole("tab")).toHaveCount(1);
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(dialog).toBeVisible();
	await expect(nav.getByRole("tab")).toHaveCount(10);
	await standard.click();
	// Theme changes use the same settings controls as the user; all writes stay in the isolated profile; no model requests.
	await dialog.getByRole("tab", { name: "应用设置", exact: true }).click();
	await dialog.getByRole("tab", { name: "外观", exact: true }).click();
	await dialog.getByRole("radio", { name: "暗色", exact: true }).click();
	await dialog.getByRole("tab", { name: "模型与工具", exact: true }).click();
	await expect(standard).toHaveAttribute("aria-expanded", "false");
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("config-security-dark.png") });
	await window.setViewportSize({ width: 1000, height: 850 });
	await standard.click();
	await expect.poll(() => dialog.locator("[data-config-page]:visible").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("config-security-expanded.png") });
	await window.emulateMedia({ reducedMotion: "reduce" });
	await nav.getByRole("tab", { name: "源文件", exact: true }).click();
	await expect(dialog.locator(".cm-editor:visible")).toBeVisible();
	await expect.poll(() => dialog.locator("[data-config-page]:visible h2").evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
	expect(errors).toEqual([]);
});

test("provider cards and forms remain usable in narrow model settings", async ({ window }, testInfo) => {
	await window.setViewportSize({ width: 1600, height: 1100 });
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: "模型与工具", exact: true }).click();
	await dialog.locator(".config-sidebar").getByRole("tab", { name: "模型", exact: true }).click();
	await dialog.getByRole("button", { name: "+ 添加供应商", exact: true }).click();
	const form = dialog.locator(".provider-add-page");
	await form.getByRole("textbox", { name: "供应商名称", exact: true }).fill("演示供应商");
	await form.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://example.com/v1");
	await form.getByRole("button", { name: "+ 手动添加", exact: true }).click();
	await form.getByPlaceholder("model-id", { exact: true }).fill("preview-model");
	await window.setViewportSize({ width: 800, height: 900 });
	await expect(dialog.locator(".config-sidebar")).toHaveCSS("width", "176px");
	await expect.poll(() => form.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
	await form.getByRole("button", { name: "添加", exact: true }).click();
	await expect(form).toHaveCount(0);
	await window.setViewportSize({ width: 1600, height: 1100 });
	const card = dialog.locator(".config-provider-card").filter({ hasText: "演示供应商" });
	await expect(card).toBeVisible();
	await expect(card).toHaveCSS("border-radius", "16px");
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("config-models-light.png") });
});
