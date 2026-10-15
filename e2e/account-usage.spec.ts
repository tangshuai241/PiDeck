import { test, expect } from "./fixtures";
import type { ElectronApplication } from "@playwright/test";
import type { QuotaAccount, QuotaAccountInput, QuotaSnapshot } from "../src/shared/types/accountUsage";

/** Real footer interaction with deterministic main-process data; no live provider requests. */
async function seedAccounts(app: ElectronApplication) {
	await app.evaluate(({ ipcMain }) => {
		let accounts: QuotaAccount[] = [
			{ id: "codex", provider: "codex", name: "Codex", visible: true, source: "local", region: "cn", hasCredential: false },
			{ id: "go-one", provider: "opencode-go", name: "Go 一号", visible: true, source: "manual", region: "cn", hasCredential: true },
			{ id: "go-two", provider: "opencode-go", name: "Go 二号", visible: true, source: "manual", region: "cn", hasCredential: true },
			{ id: "grok", provider: "grok", name: "Grok", visible: true, source: "local", region: "cn", hasCredential: false },
			{ id: "glm", provider: "glm", name: "GLM (ZCode)", visible: true, source: "local", region: "cn", hasCredential: false },
		];
		let nextId = 1;
		const refreshes: Array<string | undefined> = [];
		Reflect.set(globalThis, "__quotaRefreshes", refreshes);
		const snapshot = (): QuotaSnapshot => ({ accounts, results: Object.fromEntries(accounts.map((account, index) => [account.id, { status: "ready", updatedAt: Date.now(), windows: [{ key: "weekly", usedPercent: [13, 97, 26, 2, 65][index] ?? 0, resetsAt: Date.now() + 86400000 * 6 + 17 * 3600000 }] }])) });
		for (const channel of ["account-usage:list", "account-usage:save", "account-usage:remove", "account-usage:refresh"]) ipcMain.removeHandler(channel);
		ipcMain.handle("account-usage:list", snapshot);
		ipcMain.handle("account-usage:refresh", (_event, id?: string) => {
			refreshes.push(id);
			return snapshot();
		});
		ipcMain.handle("account-usage:save", (_event, input: QuotaAccountInput) => {
			const account: QuotaAccount = { id: input.id ?? `new-${nextId++}`, provider: input.provider, name: input.name, source: input.source, visible: input.visible, region: input.region, hasCredential: true };
			accounts = input.id ? accounts.map((row) => (row.id === input.id ? account : row)) : [...accounts, account];
			return snapshot();
		});
		ipcMain.handle("account-usage:remove", (_event, id: string) => {
			accounts = accounts.filter((account) => account.id !== id);
			return snapshot();
		});
	});
}

test("footer shows independent quotas, opens details, and manages visible accounts", async ({ app, window }) => {
	const pageErrors: string[] = [];
	window.on("pageerror", (error) => pageErrors.push(error.message));
	await seedAccounts(app);
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	const footer = window.getByTestId("account-usage-bar");
	await expect(footer.getByTestId("quota-bar-account")).toHaveCount(5);
	await expect(footer.getByRole("button", { name: /Go 一号/ })).toContainText("剩余 3%");
	await expect(footer.getByRole("button", { name: /Go 二号/ })).toContainText("剩余 74%");
	const roster = footer.getByTestId("quota-bar-roster");
	await expect(roster.locator("[data-quota-provider-icon]")).toHaveCount(5);
	await expect(footer.getByRole("button", { name: "Go 二号", exact: true })).toHaveAttribute("title", "Go 二号");
	expect(await footer.getByRole("button", { name: "Go 二号", exact: true }).innerText()).not.toContain("Go 二号");
	const fontSize = await roster
		.getByTestId("quota-bar-account")
		.first()
		.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
	expect(fontSize).toBeLessThanOrEqual(11);
	const box = await footer.boundingBox();
	expect(box).not.toBeNull();
	expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - (await window.evaluate(() => innerHeight)))).toBeLessThanOrEqual(2);
	const rosterBox = await roster.boundingBox();
	expect(rosterBox).not.toBeNull();
	expect(Math.abs((rosterBox?.x ?? 0) + (rosterBox?.width ?? 0) / 2 - (await window.evaluate(() => innerWidth)) / 2)).toBeLessThanOrEqual(2);
	await footer.getByRole("button", { name: /Go 二号/ }).click();
	const details = window.getByTestId("quota-details");
	await expect(details).toBeVisible();
	await expect(details).toContainText("已用 26%");
	await expect(details).toContainText("后重置");
	await details.getByRole("button", { name: "刷新此账号" }).click();
	await expect(details).toContainText("剩余 74%");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "__quotaRefreshes"))).toEqual([undefined, "go-two"]);
	await window.screenshot({ path: test.info().outputPath("quota-details.png") });
	const detailsBox = await details.boundingBox();
	if (!detailsBox) throw new Error("Quota details are not visible");
	const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	const screenshotTop = Math.max(0, Math.floor(detailsBox.y) - 8);
	await window.screenshot({ path: test.info().outputPath("quota-footer-compact.png"), clip: { x: 0, y: screenshotTop, width: viewport.width, height: viewport.height - screenshotTop } });
	await window.keyboard.press("Escape");
	await footer.getByRole("button", { name: "额度", exact: true }).click();
	const manager = window.getByTestId("quota-account-manager");
	await expect(manager.getByTestId("quota-account-row")).toHaveCount(5);
	await manager.getByRole("switch", { name: "在底栏显示 Go 一号" }).click();
	await expect(manager.getByRole("switch", { name: "在底栏显示 Go 一号" })).not.toBeChecked();
	await manager.getByRole("button", { name: "添加账号", exact: true }).click();
	await manager.locator("#quota-name").fill("Go 三号");
	await manager.locator("#quota-credential").fill("test-only-key");
	await manager.getByRole("button", { name: "保存账号", exact: true }).click();
	await expect(manager.getByTestId("quota-account-row")).toHaveCount(6);
	await manager.getByRole("button", { name: "编辑 Go 三号", exact: true }).click();
	await expect(manager.locator("#quota-credential")).toHaveValue("");
	await manager.getByRole("button", { name: "取消", exact: true }).click();
	await manager.getByRole("button", { name: "移除 Go 三号", exact: true }).click();
	await expect(manager.getByTestId("quota-account-row")).toHaveCount(5);
	await window.keyboard.press("Escape");
	await expect(footer.getByTestId("quota-bar-account")).toHaveCount(4);
	await expect(footer.getByRole("button", { name: /Go 一号/ })).toHaveCount(0);
	await expect(footer.getByRole("button", { name: /Go 二号/ })).toBeVisible();
	expect(pageErrors).toEqual([]);
});
