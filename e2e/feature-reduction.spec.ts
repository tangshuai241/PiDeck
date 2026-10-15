import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

// Retired settings are seeded in an isolated profile; no accounts, agents or model calls are used.
test.use({ seedSettings: { acpEnabled: true, webServiceEnabled: true, telemetryEnabled: true, defaultAgentBackend: "dsh" } });

test("retired services have no desktop API or settings entry and retained integrations stay accessible", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const snapshot = await window.evaluate(async () => {
		const api = window.piDesktop;
		const settings = await api.settings.get();
		const prompts = await api.yaoPrompts.list({ page: 1, pageSize: 5 });
		return { retiredApis: ["acp", "announcements", "promptStore", "skillStore", "skillHub"].filter((name) => name in api), acpEnabled: settings.acpEnabled, webEnabled: settings.webServiceEnabled, telemetryEnabled: settings.telemetryEnabled, backend: settings.defaultAgentBackend, promptCount: prompts.total };
	});
	expect(snapshot.retiredApis).toEqual([]);
	expect(snapshot.acpEnabled).toBe(false);
	expect(snapshot.webEnabled).toBe(false);
	expect(snapshot.telemetryEnabled).toBe(false);
	expect(snapshot.backend).toBe("dsh");
	expect(snapshot.promptCount).toBeGreaterThan(0);
	const modal = await openSettings(window);
	await expect(modal.getByRole("tab", { name: "Web 服务", exact: true })).toHaveCount(0);
	await expect(modal.getByRole("tab", { name: "ACP 工具", exact: true })).toHaveCount(0);
	for (const name of ["外部连接", "桌面宠物", "图片生成", "视频生成"]) await expect(modal.getByRole("tab", { name, exact: true })).toBeVisible();
	await modal.getByRole("tab", { name: "开发选项", exact: true }).click();
	await expect(modal.getByText("TPA 应用更新来自自己的发布仓库。资源更新仍可使用上游镜像。", { exact: true })).toBeVisible();
	await expect(modal.getByText("遥测", { exact: true })).toHaveCount(0);
	await modal.getByRole("tab", { name: "模型与工具", exact: true }).click();
	const config = modal.getByRole("tabpanel", { name: "Pi 配置管理", exact: true });
	await config.getByText("提示词模板", { exact: true }).click();
	await config.getByText("社区提示词库", { exact: true }).click();
	const cards = config.locator(".prompt-store-card");
	await expect(cards.first()).toBeVisible();
	await cards.first().click();
	await expect(config.locator(".prompt-store-preview-content pre")).not.toBeEmpty();
});
