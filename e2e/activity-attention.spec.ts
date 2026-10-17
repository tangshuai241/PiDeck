import { test, expect } from "./mock-pi-fixture";
import { openFirstSession } from "./open-session";

/**
 * 活动区状态摘要 E2E（真实渲染 + mock pi RPC）：
 * 提问出现后活动页显示「待回答」计数与问题摘要，点击条目回到现有问答卡片。
 */

test("activity filters surface the pending question and jump back to the ask card", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type("ASK_SELECT 选一个");
	await window.keyboard.press("Enter");

	const askBar = window.locator(".ask-inline-bar");
	await expect(askBar).toBeVisible({ timeout: 15_000 });

	// 活动页：筛选条常驻，待回答按会话计数。
	await window.locator('[role="tab"]').filter({ hasText: "活动" }).first().click();
	const filters = window.locator(".activity-filters");
	await expect(filters).toBeVisible();
	const pendingFilter = filters.getByRole("tab", { name: /待回答/ });
	await expect(pendingFilter).toContainText("1");
	await pendingFilter.click();

	// 行内显示问题摘要（单题取请求标题）与静态待回答标记；等待回答时不再是旋转图标。
	const rows = window.locator(".activity-filtered-sessions");
	await expect(rows).toContainText("请选择操作");
	await expect(rows).toContainText("待回答");
	await expect(rows.locator(".session-activity-waiting")).toHaveCount(1);
	await expect(rows.locator(".session-activity-spinner")).toHaveCount(0);
	// 点击条目定位到现有问答卡片（不新开弹窗流程）。
	await rows.getByRole("button").first().click();
	await expect(askBar).toBeVisible();
	await expect(askBar).toContainText("请选择操作");
});
