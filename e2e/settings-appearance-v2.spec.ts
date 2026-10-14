import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";
import palettes from "../src/renderer/src/themes/t3-palettes.json";

test("settings switches expose their visible labels", async ({ window }) => {
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: "常规", exact: true }).click();
	const switches = dialog.getByRole("switch");
	await expect(switches.first()).toBeVisible();
	for (const control of await switches.all()) await expect(control).toHaveAccessibleName(/\S/);
});

test("T3 palettes preview, animate, cancel and persist in the desktop settings", async ({ window }, testInfo) => {
	await window.setViewportSize({ width: 1600, height: 1100 });
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: "外观", exact: true }).click();
	await expect(dialog.locator("[data-theme-orb]")).toHaveCount(12);
	const original = await window.locator("html").getAttribute("data-appearance");
	for (const palette of palettes) {
		await dialog.getByRole("radio", { name: palette.label, exact: true }).click();
		await expect(dialog.getByRole("radio", { name: palette.label, exact: true })).toBeChecked();
		await expect(window.locator("html")).toHaveAttribute("data-appearance", palette.id);
		for (const [mode, label] of [
			["light", "浅色"],
			["dark", "暗色"],
		] as const) {
			await dialog.getByRole("radio", { name: label, exact: true }).click();
			await expect(window.locator("html")).toHaveAttribute("data-theme", mode);
			await expect(window.locator("html")).toHaveAttribute("data-appearance", palette.id);
			for (const [token, expected] of [
				["--color-bg-app", palette[mode].canvas],
				["--color-accent", palette[mode].messageAction],
			]) {
				// Vite minifies Oklch lightness to percentages; compare browser-parsed colors.
				await expect
					.poll(
						() =>
							window.locator("html").evaluate(
								(root, { token, expected }) => {
									const probe = document.createElement("span");
									probe.style.color = expected;
									const canonical = probe.style.color;
									probe.style.color = getComputedStyle(root).getPropertyValue(token).trim();
									return canonical !== "" && probe.style.color === canonical;
								},
								{ token, expected },
							),
						{ message: `${palette.id} ${mode} ${token}` },
					)
					.toBe(true);
			}
		}
	}
	const pigment = dialog.locator('[data-theme-orb="light"] > span').first();
	await expect.poll(() => pigment.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe("running");
	const transform = await pigment.evaluate((element) => getComputedStyle(element).transform);
	await expect.poll(() => pigment.evaluate((element) => getComputedStyle(element).transform)).not.toBe(transform);
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("appearance-iris-dark.png") });
	await dialog.getByRole("radio", { name: "浅色", exact: true }).click();
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("appearance-iris-light.png") });
	await window.emulateMedia({ reducedMotion: "reduce" });
	await expect.poll(() => pigment.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
	await window.emulateMedia({ reducedMotion: "no-preference" });
	const appearancePanel = dialog.getByRole("tabpanel", { name: "外观", exact: true });
	await appearancePanel.evaluate((element) => element.scrollTo(0, element.scrollHeight));
	await expect.poll(() => pigment.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe("paused");
	await appearancePanel.evaluate((element) => element.scrollTo(0, 0));
	await expect.poll(() => pigment.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe("running");
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	await expect(window.locator("html")).toHaveAttribute("data-appearance", original ?? "classic-green");
	await dialog.getByRole("radio", { name: "Grove", exact: true }).click();
	await dialog.getByRole("radio", { name: "暗色", exact: true }).click();
	await dialog.getByRole("button", { name: "保存", exact: true }).click();
	if (await dialog.isVisible()) await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();
	const reopened = await openSettings(window);
	await reopened.getByRole("tab", { name: "外观", exact: true }).click();
	await expect(reopened.getByRole("radio", { name: "Grove", exact: true })).toBeChecked();
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("appearance-grove-dark.png") });
	await reopened.getByRole("tab", { name: "常规", exact: true }).click();
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("general-grove-dark.png") });
	const search = reopened.getByRole("textbox", { name: "搜索设置…" });
	await search.fill("外观");
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(reopened).toBeVisible();
	await window.setViewportSize({ width: 1000, height: 800 });
	await reopened.getByRole("tab", { name: "外观", exact: true }).click();
	await expect.poll(() => reopened.getByRole("tabpanel", { name: "外观", exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await window.screenshot({ animations: "disabled", path: testInfo.outputPath("appearance-narrow.png") });
	expect(errors).toEqual([]);
});
