import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let server: ViteDevServer | undefined;
let cacheDir: string | undefined;
let baseUrl = "";

/** Renderer-only fixture avoids real accounts, model calls and installed app data. */
test.beforeAll(async () => {
	cacheDir = await mkdtemp(join(tmpdir(), "pideck-alignment-vite-"));
	server = await createServer({
		configFile: false,
		root: process.cwd(),
		cacheDir,
		plugins: [tailwindcss()],
		optimizeDeps: { entries: ["e2e/fixtures/alignment-card.html"] },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		server: { host: "127.0.0.1", port: 0, strictPort: false },
		logLevel: "error",
	});
	await server.listen();
	const url = server.resolvedUrls?.local[0];
	if (!url) throw new Error("Missing alignment fixture URL");
	baseUrl = url;
});

test.afterAll(async () => {
	await server?.close();
	if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

// Optional branded browser for local machines without a downloaded Playwright Chromium.
// Playwright still creates its own isolated profile; this never opens the user\'s browser profile.
test.use({ viewport: { width: 640, height: 760 }, channel: process.env.PIDECK_E2E_BROWSER_CHANNEL === "msedge" ? "msedge" : undefined });

for (const theme of ["light", "dark"]) {
	test(`alignment uses production ${theme} theme, scrolls without shrinking, and exposes existing-style actions`, async ({ page }, testInfo) => {
		await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?theme=${theme}`);
		const card = page.getByTestId("alignment-card");
		await expect(card).toBeVisible();
		await expect(card.getByText("本次要求", { exact: true })).toBeVisible();
		await expect(card.getByText("待确认", { exact: true })).toBeVisible();
		const scroll = card.locator(".max-h-56");
		const metrics = await scroll.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
		expect(metrics.client).toBeGreaterThan(100);
		expect(metrics.scroll).toBeGreaterThan(metrics.client);
		await scroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(card.getByText("完成标准", { exact: true })).toBeVisible();
		const colors = await card.evaluate((element) => ({
			text: getComputedStyle(element).color,
			surface: getComputedStyle(element.closest("section") ?? element).backgroundColor,
		}));
		expect(colors.text).not.toBe(colors.surface);
		expect(colors.surface).not.toBe("rgba(0, 0, 0, 0)");
		const approve = card.getByRole("button", { name: "按这个执行", exact: true });
		await expect(approve).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath(`alignment-${theme}.png`) });
		await approve.click();
		await expect(page.getByTestId("alignment-action")).toHaveText("approved:brief-theme-123:2");
		await card.getByRole("button", { name: "修改要求", exact: true }).click();
		await expect(page.getByTestId("alignment-action")).toHaveText("revised");
		const title = card.getByRole("button", { name: "本次要求", exact: true });
		await title.click();
		await expect(title).toHaveAttribute("aria-expanded", "false");
		await expect(approve).toBeVisible();
	});
}

test("unresolved questions and busy execution cannot be approved", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?questions=1`);
	await expect(page.getByTestId("alignment-card").getByRole("button", { name: "按这个执行", exact: true })).toBeDisabled();
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?busy=1`);
	const card = page.getByTestId("alignment-card");
	await expect(card.getByRole("button", { name: "按这个执行", exact: true })).toBeDisabled();
	await expect(card.getByRole("button", { name: "修改要求", exact: true })).toBeDisabled();
	await expect(card.getByRole("button", { name: "退出对齐", exact: true })).toBeDisabled();
});
