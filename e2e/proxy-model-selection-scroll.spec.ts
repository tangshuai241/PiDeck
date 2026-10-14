import { test, expect } from "./mock-pi-fixture";

/**
 * 模型名单第一次从空变为非空时，不能让代理设置面板插入局部 dirty 横幅或重排工具条，
 * 否则浏览器会调整滚动坐标，表现为点击「全选」后页面跳动。
 */
test("代理模型分组首次全选保持设置滚动位置", async ({ window }) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("button", { name: "设置" }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByRole("tab", { name: "网络代理" }).click();

	const panel = modal.getByRole("tabpanel", { name: "网络代理" });
	await expect(panel.getByText("按模型走代理", { exact: true })).toBeVisible({ timeout: 20_000 });
	const providerRow = panel.locator('[data-proxy-model-provider="mock"]');
	await expect(providerRow).toBeVisible({ timeout: 20_000 });

	// 将目标组放到滚动面板中部，复现用户在长设置页中点全选的场景。
	await panel.evaluate((element) => {
		const row = element.querySelector<HTMLElement>('[data-proxy-model-provider="mock"]');
		if (!row) throw new Error("mock provider row was not rendered");
		const rowTop = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
		const maxScrollTop = element.scrollHeight - element.clientHeight;
		element.scrollTop = Math.max(1, Math.min(maxScrollTop, rowTop - element.clientHeight / 2));
	});

	const selectAll = providerRow.getByRole("button", { name: "全选" });
	await expect(selectAll).toBeVisible();
	const before = await selectAll.evaluate((button) => {
		const panel = button.closest<HTMLElement>(".settings-panel");
		if (!panel) throw new Error("settings panel was not found");
		return {
			relativeTop: button.getBoundingClientRect().top - panel.getBoundingClientRect().top,
			scrollTop: panel.scrollTop,
		};
	});
	expect(before.scrollTop).toBeGreaterThan(0);

	await selectAll.click();
	await expect(providerRow.getByRole("button", { name: "取消全选" })).toBeVisible();
	const after = await providerRow.getByRole("button", { name: "取消全选" }).evaluate((button) => {
		const panel = button.closest<HTMLElement>(".settings-panel");
		if (!panel) throw new Error("settings panel was not found");
		return {
			relativeTop: button.getBoundingClientRect().top - panel.getBoundingClientRect().top,
			scrollTop: panel.scrollTop,
		};
	});

	// 既不改变实际滚动位置，也不让点击控件在视口内跳位。
	expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(1);
	expect(Math.abs(after.relativeTop - before.relativeTop)).toBeLessThan(1);
	// 模型名单已有明确的选中数和全局保存/取消反馈，不应再插入会改变布局的局部横幅。
	await expect(panel.locator(".setting-proxy-unsaved-bar")).toHaveCount(0);
});
