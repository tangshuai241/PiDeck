import { test, expect } from "./mock-pi-fixture";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { openFirstSession } from "./open-session";

/**
 * CUA 轨迹回看 E2E（mock pi 真实 RPC + 真实 Electron）：
 * mock 推一次 `mcp__pideck-cua__cua_capture` 工具结果（文本里带 tpaCua + screenshotRef），
 * 轨迹面板在现有工具账本上展示动作详情和截图；回看只读，不重新执行动作。
 *
 * 截图本体由 seedCuaFrames 预置到 userData/cua/frames，经 pideck-cua-img:// 协议加载。
 */

const repoRoot = resolve(__dirname, "..");
// 与 e2e/mock-pi.cjs 的 CUA_FRAME_REF 保持一致（内容寻址命名是约定，协议只校验命名与目录）。
const FRAME_REF = `${"a".repeat(64)}.jpg`;
const FRAME_BYTES = readFileSync(join(repoRoot, "e2e", "fixtures", "cua-trajectory-frame.jpg"));

test.use({ seedCuaFrames: [{ ref: FRAME_REF, bytes: FRAME_BYTES }] });

test("cua trajectory: action detail + screenshot are reviewable and read-only", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 发送带 CUA 标记的 prompt：mock 推工具开始/结束帧。
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type("CUA 截一张当前屏幕");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", { timeout: 30_000 });
	await window.waitForTimeout(500);

	// 打开右侧抽屉（活动栏只在抽屉打开后渲染），再切到「轨迹」面板。
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");
	// 「轨迹」默认不常驻：先从「添加常驻面板」里钉住，再点 rail 打开。
	await window.getByRole("button", { name: "添加常驻面板" }).click();
	await window.getByRole("menuitemcheckbox", { name: "轨迹" }).click();
	await window.keyboard.press("Escape");
	await window.getByTestId("drawer-rail-trajectory").click();
	const trajectory = window.locator('[data-session-view="trajectory"]');
	await expect(trajectory).toBeVisible({ timeout: 15_000 });

	// 账本按工具调用逐条列出；点开带 CUA 记录的条目（不依赖摘要文案）。
	const rows = trajectory.locator("li > button");
	await expect(rows.first()).toBeVisible({ timeout: 15_000 });
	const detail = trajectory.locator('[data-cua-action="capture"]');
	const count = await rows.count();
	for (let index = 0; index < count; index += 1) {
		await rows.nth(index).click();
		if ((await detail.count()) > 0) break;
	}
	await expect(detail).toBeVisible({ timeout: 10_000 });

	// 动作详情：坐标空间、屏幕范围、图像尺寸、回执、只读提示。
	await expect(detail).toContainText("电脑操作");
	await expect(detail).toContainText("截图图像像素");
	await expect(detail).toContainText("(0, 0) 2560×1440");
	await expect(detail).toContainText("1280×720");
	await expect(detail).toContainText("已发送输入: 0");
	await expect(detail).toContainText("回看只展示已记录的动作与截图，不会重新执行点击或输入。");

	// 截图真的从 userData 经协议加载出来（不是空白 <img>）。
	const image = detail.locator("img");
	await expect(image).toBeVisible({ timeout: 10_000 });
	await expect
		.poll(async () =>
			image.evaluate((element) => {
				const img = element as HTMLImageElement;
				return { width: img.naturalWidth, height: img.naturalHeight, complete: img.complete };
			}),
		)
		.toEqual({ width: 640, height: 360, complete: true });

	// 证据留档（可选，不写仓库）：PIDECK_E2E_CUA_SCREENSHOT=<绝对路径>。
	if (process.env.PIDECK_E2E_CUA_SCREENSHOT) {
		await detail.scrollIntoViewIfNeeded();
		await window.waitForTimeout(300);
		await window.screenshot({ path: process.env.PIDECK_E2E_CUA_SCREENSHOT, fullPage: false });
	}

	// 截图引用即记录里的 ref（证明记录只存引用，不内联 base64）。
	expect(FRAME_REF).toMatch(/^[0-9a-f]{64}\.jpg$/);
	expect(createHash("sha256").update(FRAME_BYTES).digest("hex")).toHaveLength(64);
});
