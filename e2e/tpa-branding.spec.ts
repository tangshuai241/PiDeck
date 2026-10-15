import { test, expect } from "./mock-pi-fixture";

/** The visible rename uses the same saved-data contract and does not rename credential storage. */
test("TPA is the default visible client name and explicit test data remains isolated", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	await expect(window).toHaveTitle("TPA");
	await expect(window.getByRole("button", { name: "关于 TPA", exact: true })).toBeVisible();
	const info = await window.evaluate(() => window.piDesktop.app.info());
	expect(info.userDataDir).toMatch(/pideck-mockpi-[^\\/]+[\\/]profile$/);
	await window.getByRole("button", { name: "关于 TPA", exact: true }).click();
	await expect(window.getByText("TPA", { exact: true }).last()).toBeVisible();
});
