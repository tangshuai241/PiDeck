import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let server: ViteDevServer | undefined;
let cacheDir: string | undefined;
let baseUrl = "";

/** Continuous transitions use production hooks/atoms and mocked IPC, never real accounts or model calls. */
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
// Branded Edge uses an isolated Playwright profile, not the user's logged-in profile.
test.use({ viewport: { width: 640, height: 760 }, channel: process.env.PIDECK_E2E_BROWSER_CHANNEL === "msedge" ? "msedge" : undefined });

for (const theme of ["light", "dark"]) {
	test(`final confirmation belongs to chat and requires authoritative approval in ${theme} theme`, async ({ page }, testInfo) => {
		await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?theme=${theme}`);
		const card = page.getByTestId("alignment-card");
		await expect(card).toHaveAttribute("data-phase", "ready");
		await expect(page.getByTestId("chat-flow").getByTestId("alignment-card")).toHaveCount(1);
		await expect(page.getByTestId("fixture-composer").getByTestId("alignment-card")).toHaveCount(0);
		await expect(card.getByText("需求整理完成，请确认")).toBeVisible();
		const approve = card.getByRole("button", { name: "确认要求，开始执行", exact: true });
		await expect(approve).toBeEnabled();
		const scroll = card.locator(".max-h-96");
		const metrics = await scroll.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
		expect(metrics.client).toBeGreaterThan(100);
		expect(metrics.scroll).toBeGreaterThan(metrics.client);
		await scroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(card.getByText("完成标准", { exact: true })).toBeVisible();
		const colors = await card.evaluate((element) => ({ text: getComputedStyle(element).color, surface: getComputedStyle(element).backgroundColor }));
		expect(colors.text).not.toBe(colors.surface);
		expect(colors.surface).not.toBe("rgba(0, 0, 0, 0)");
		await page.screenshot({ path: testInfo.outputPath(`alignment-${theme}.png`) });
		await card.getByRole("button", { name: "收起要求", exact: true }).click();
		await expect(card.getByRole("button", { name: "查看要求", exact: true })).toHaveAttribute("aria-expanded", "false");
		await expect(approve).toBeVisible();
		await approve.click();
		await expect(page.getByTestId("alignment-action")).toHaveText("/align approve brief-theme-123 2");
		await expect(card).toHaveAttribute("data-phase", "confirming");
		await expect(card.getByRole("button", { name: "确认要求，开始执行", exact: true })).toHaveCount(0);
		await page.getByTestId("ack-approval").click();
		await expect(card).toHaveAttribute("data-phase", "approved");
	});
}

test("no input means no progress or confirmation", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?idle=1`);
	await expect(page.getByTestId("alignment-card")).toHaveCount(0);
	await expect(page.locator(".animate-spin")).toHaveCount(0);
});

test("working has a chat notice and only the existing responding animation", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?working=1`);
	const card = page.getByTestId("alignment-card");
	await expect(card).toHaveAttribute("data-phase", "working");
	await expect(card).toContainText("正在根据你的消息整理要求");
	await expect(card.getByText("完成标准", { exact: true })).toHaveCount(0);
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(card.locator(".animate-spin")).toHaveCount(0);
});

test("unresolved questions and busy execution cannot be approved", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?questions=1`);
	const card = page.getByTestId("alignment-card");
	await expect(card).toHaveAttribute("data-phase", "questions");
	await expect(card.getByText("需求整理完成，请确认")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "确认要求，开始执行", exact: true })).toHaveCount(0);
	await expect(card).toContainText("还需要你回答");
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?busy=1`);
	await expect(card).toHaveAttribute("data-phase", "working");
	await expect(card.getByRole("button")).toHaveCount(0);
});

test("ordinary send immediately retires the old sheet; an ended response without a new brief is resumable", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html`);
	const card = page.getByTestId("alignment-card");
	await expect(card).toHaveAttribute("data-phase", "ready");
	await page.getByTestId("send-revision").click();
	await expect(card).toHaveAttribute("data-phase", "sending");
	await expect(card.getByText("需求整理完成，请确认")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "确认要求，开始执行", exact: true })).toHaveCount(0);
	await page.getByTestId("accept-send").click();
	await expect(card).toHaveAttribute("data-phase", "working");
	await page.getByTestId("finish-without-brief").click();
	await expect(card).toHaveAttribute("data-phase", "incomplete");
	await expect(card.getByRole("button", { name: "继续整理要求", exact: true })).toBeVisible();
	await page.getByTestId("publish-revised").click();
	await expect(card).toHaveAttribute("data-phase", "ready");
	await expect(card).toContainText("一份 Excel 成品。");
	await card.getByRole("button", { name: "确认要求，开始执行", exact: true }).click();
	await expect(page.getByTestId("alignment-action")).toHaveText("/align approve brief-theme-123 3");
});

for (const theme of ["light", "dark"]) {
	for (const width of [360, 640]) {
		test(`alignment mode exit fits one compact mode control in ${theme} theme at ${width}px`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 760 });
			await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?mode-bar=1&idle=1&theme=${theme}`);
			const bar = page.getByTestId("production-composer-bar");
			const cluster = bar.locator(".composer-mode-cluster");
			const exit = bar.getByRole("button", { name: "退出对齐", exact: true });
			const selector = cluster.getByRole("combobox", { name: "需求对齐", exact: true });
			await expect(selector).toHaveCount(1);
			const metrics = await exit.evaluate((element) => {
				const box = element.getBoundingClientRect();
				const icon = element.querySelector("svg")?.getBoundingClientRect();
				const select = element.parentElement?.querySelector('[role="combobox"]')?.getBoundingClientRect();
				return {
					width: box.width,
					height: box.height,
					iconWidth: icon?.width,
					iconHeight: icon?.height,
					iconOffsetX: icon ? Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2) : 100,
					iconOffsetY: icon ? Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) : 100,
					selectHeight: select?.height,
					centerOffset: select ? Math.abs(select.y + select.height / 2 - box.y - box.height / 2) : 100,
					background: getComputedStyle(element).backgroundColor,
				};
			});
			expect(metrics.width).toBe(24);
			expect(metrics.height).toBe(24);
			expect(metrics.iconWidth).toBe(12);
			expect(metrics.iconHeight).toBe(12);
			expect(metrics.iconOffsetX).toBeLessThanOrEqual(0.5);
			expect(metrics.iconOffsetY).toBeLessThanOrEqual(0.5);
			expect(metrics.selectHeight).toBe(28);
			expect(metrics.centerOffset).toBeLessThanOrEqual(0.5);
			expect(metrics.background).toBe("rgba(0, 0, 0, 0)");
			await bar.screenshot({ path: testInfo.outputPath(`alignment-mode-${theme}-${width}.png`) });
			await exit.click();
			await expect(page.getByTestId("alignment-action")).toHaveText("/align off");
			await expect(exit).toHaveCount(0);
		});
	}
}

test("disabled alignment mode exit cannot send a cancellation request", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html?mode-bar=1&idle=1&disabled=1`);
	const bar = page.getByTestId("production-composer-bar");
	await expect(bar.getByRole("button", { name: "退出对齐", exact: true })).toBeDisabled();
	await expect(bar.getByRole("combobox", { name: "需求对齐", exact: true })).toBeDisabled();
	await expect(page.getByTestId("alignment-action")).toHaveText("");
});

test("a queued revision retires the confirmation before processing starts", async ({ page }) => {
	await page.goto(`${baseUrl}e2e/fixtures/alignment-card.html`);
	await expect(page.getByTestId("alignment-card")).toHaveAttribute("data-phase", "ready");
	await page.getByTestId("queue-revision").click();
	await expect(page.getByTestId("alignment-card")).toHaveAttribute("data-phase", "queued");
	await expect(page.getByTestId("alignment-card").getByRole("button")).toHaveCount(0);
});
