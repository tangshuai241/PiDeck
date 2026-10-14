import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { makeSeedProject, seedProjectsOption } from "./open-session";

/**
 * 桥贡献的「扩展点」页（config.page 落点）端到端回归。
 *
 * 验证真 pi + 真内置扩展链路：`pi-deck-gui-bridge` 通过桥贡献了一个 `config.page`，
 * 它必须出现在「配置管理」的侧栏导航里（原生项安全/扩展/技能/提示词模板仍在），
 * 点进去后扩展点清单渲染完整（可挂载点数、生成草稿、搜索框），并且能按签名搜索、
 * 自动展开分组、勾选后回写「已选 N 项」。
 *
 * 依赖真 pi 进程，因此先发一条消息把 pi 拉起来（composer 可编辑 ≠ pi 已 spawn）。
 */

test.setTimeout(300_000);

// 本会话的工作区（Chat 项目用 <userData>/chat-workspace，也可能是种子项目目录）
const seedProject = makeSeedProject("bridgeprobe");
const workspaceHints = ["chat-workspace", basename(seedProject.path)];

test.use({ seedProjects: seedProjectsOption([seedProject]) });

/** 打开一个真实会话（真 pi spawn）：优先 Chat 项目标题栏按钮，兜底侧栏「新建会话」。 */
async function ensureSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	// 首次启动可能自动弹出设置弹窗，会遮拦点击
	const modal = window.locator(".settings-modal");
	if (await modal.isVisible().catch(() => false)) {
		await modal
			.getByRole("button", { name: "关闭" })
			.first()
			.click()
			.catch(() => undefined);
		await expect(modal).toHaveCount(0, { timeout: 10_000 });
	}
	const chatBtn = window.getByRole("button", { name: "新会话", exact: true });
	if ((await chatBtn.count()) > 0) {
		await chatBtn.first().click();
	} else {
		await window.getByText("新建会话", { exact: true }).first().click();
	}
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
}

/** 递归收集临时 profile 下的所有 .log 行（e2e 用 PIDECK_E2E_USER_DATA_DIR 隔离了 userData）。 */
function collectLogLines(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(full);
			else if (name.endsWith(".log")) {
				try {
					out.push(...readFileSync(full, "utf8").split("\n"));
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk(root);
	return out;
}

/**
 * 轮询等会话 pi 真正 spawn（composer 可编辑 ≠ pi 已起）。
 * 判据是主进程日志的 "Pi process spawned"（AgentManager 在握手完成后写入，带 cwd），
 * 且 cwd 指向本会话工作区 —— 否则可能命中别的 pi 进程（如启动期的监听进程），等待就白等了。
 */
async function waitForPiSpawn(window: Page, userDataRoot: string): Promise<boolean> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const lines = collectLogLines(userDataRoot);
		if (lines.some((l) => l.includes("Pi process spawned") && workspaceHints.some((hint) => l.includes(hint)))) return true;
		await window.waitForTimeout(2000);
	}
	return false;
}

test("配置管理里应出现桥贡献的「扩展点」页，并且能搜索、能勾选", async ({ window, userDataRoot }) => {
	await ensureSession(window);
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type("ping");
	await window.keyboard.press("Enter");

	expect(await waitForPiSpawn(window, userDataRoot), "pi 未在 120s 内 spawn（应用日志里没有带本会话工作区的 Pi process spawned）").toBe(true);

	// 给桥的轮询（~100ms）与扩展加载留足时间
	await window.waitForTimeout(30_000);

	// 开设置弹窗，验「收起态一行按钮 → 点开才加载」
	await window.setViewportSize({ width: 1440, height: 900 });
	await window.waitForTimeout(1500);
	const gear = window.locator('button[aria-label^="设置"]:visible').first();
	await gear.evaluate((el) => (el as HTMLElement).click());
	const modal = window.locator(".settings-modal").first();
	await modal.waitFor({ state: "visible", timeout: 15_000 });
	await window.screenshot({ path: "test-results/bridge-settings-opened.png" });

	// 切到「配置管理」分区（ConfigPane 就是 ConfigModal 的嵌入形态，侧栏即 Agent 能力组），
	// 验证新落点 `config.page`：面板现在是侧栏里一个独立整页，不再是设置弹窗底部那块。
	const cfgTab = modal.getByRole("tab", { name: "模型与工具", exact: true }).first();
	await expect(cfgTab).toBeVisible({ timeout: 15_000 });
	// 用真实鼠标点击：Radix Tabs 在 mousedown 上切页，`el.click()` 不会触发。
	await cfgTab.click();
	const cfgLayout = window.locator(".config-layout").first();
	await expect(cfgLayout).toBeVisible({ timeout: 20_000 });

	// 侧栏导航：桥贡献的「扩展点」与原生项并存（贡献经桥轮询 ~100ms 后才到，给足超时）
	await expect(modal).toContainText("扩展点", { timeout: 20_000 });
	for (const label of ["安全", "扩展", "技能", "提示词模板"]) {
		await expect(modal).toContainText(label);
	}
	await window.screenshot({ path: "test-results/bridge-config-sidebar.png" });

	// 点进「扩展点」页（同样是 Radix Tabs，必须真实点击）
	await modal.getByRole("tab", { name: "扩展点", exact: true }).first().click();
	// 限定在**可见**的 config 面板内查询：原生 config 页里 security / mcp 是 forceMount 的隐藏面板，
	// 各自带自己的 [role=switch]；不限定可见面板时 .first() 会命中 display:none 里的开关，点击永远重试。
	const page = modal.locator(".config-main:visible").first();
	await expect(page.getByText("生成草稿")).toBeVisible({ timeout: 20_000 });
	// 清单是运行时从 pi 的类型定义读出来的：读到 typesPath 才会显示「快照来源 pi …」，
	// 读不到会退化成「未读到 pi 类型定义」。这条即「清单已加载」的 UI 判据。
	await expect(page).toContainText(/共 \d+ 个可挂载点 · 快照来源 pi/);
	const search = page.getByPlaceholder("搜索名称 / 签名 / 说明").first();
	await expect(search).toBeVisible({ timeout: 10_000 });
	await window.screenshot({ path: "test-results/bridge-config-page.png" });

	// 搜索 → 分组自动展开 → 点第一个开关
	// （分组默认收起，不搜索时行根本不渲染；关键词要用真实签名前缀，
	//   GUI 扩展点的名称前缀是 `ctx.gui.`，所以取 `ctx.`）
	await search.fill("ctx.");
	await expect.poll(() => page.locator('[role="switch"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
	await window.screenshot({ path: "test-results/bridge-config-searched.png" });

	await page.locator('[role="switch"]').first().click();
	// 勾选后该点才补出「主要用来」输入框（ext-points 的 renderPanel: if (chosen)），页脚计数同步 +1
	await expect(page).toContainText("主要用来", { timeout: 20_000 });
	await expect(page).toContainText("已选 1 项");
	await window.screenshot({ path: "test-results/bridge-config-toggled.png" });
});
