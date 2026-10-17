import { test, expect } from "./mock-pi-fixture";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openFirstSession } from "./open-session";

/**
 * 对话内交互图表 E2E（mock pi 真实 RPC + 真实 Electron）：
 * mock 推 `render_chart` 工具的开始/结束帧（带 `details.tpaChart`），
 * 桌面端解码后渲染常显图表卡。
 *
 * 覆盖（方案 9.1）：G-A2 悬停、G-A3 图例（含全部隐藏后仍可逐项恢复）、
 * G-A4 数据表、G-A5 放大、G-A6 折叠后可见、G-A8 关联改图、G-A9 重启恢复、
 * G-A10 零值/缺失值、G-A11 窄分屏、G-A12 真实导出（PNG/CSV 落盘内容）。
 * 键盘：图例开关可用 Enter 操作（G-A11 的键盘可操作部分）。
 */

const repoRoot = resolve(__dirname, "..");
const CHART_ID = "chart-tool-e2e-chart-1";
const PIE_CHART_ID = "chart-tool-e2e-chart-pie";
const REVISE_CHART_ID = "chart-tool-e2e-chart-2";

const card = (window: Page) => window.locator(`[data-chart-id="${CHART_ID}"]`);
const cardById = (window: Page, chartId: string) => window.locator(`[data-chart-id="${chartId}"]`);

async function sendPrompt(window: Page, prompt: string, expectChartId = CHART_ID) {
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type(prompt);
	await window.keyboard.press("Enter");
	await expect(cardById(window, expectChartId)).toBeVisible({ timeout: 30_000 });
}

/**
 * 等本轮彻底结束再交互。
 *
 * 为什么必须等：流式结束后主进程会把消息重投影成历史形状，卡片 DOM 会被整段替换
 * （实测 scrollIntoViewIfNeeded 报 element is not attached to the DOM），
 * 在替换窗口里做悬停/滚动会随机失败。
 */
async function waitForRunSettled(window: Page) {
	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", { timeout: 30_000 });
	await expect(window.locator("[data-final-answer]").first()).toBeVisible({ timeout: 15_000 });
	await window.waitForTimeout(400);
}

test("chart card: hover, legend (including hiding everything), data table, zoom, folding, keyboard", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await sendPrompt(window, "CHART 按月画一下支出");
	await waitForRunSettled(window);

	await expect(card(window)).toContainText("月度支出");
	await expect(card(window)).toContainText("人工费与材料费对比");
	await expect(card(window)).toContainText("材料.xlsx");
	await expect(card(window).locator(".recharts-bar-rectangle").first()).toBeVisible({ timeout: 15_000 });

	// 悬停某一柱：提示框给出该月份的数值与单位
	await card(window).locator(".recharts-bar-rectangle").first().hover();
	await expect(card(window).locator(".recharts-tooltip-wrapper")).toContainText("元", { timeout: 10_000 });

	// 图例切换（点击）与键盘（Enter）等价
	const laborToggle = card(window).getByRole("button", { name: /人工费/ });
	const materialToggle = card(window).getByRole("button", { name: /材料费/ });
	await expect(materialToggle).toHaveAttribute("aria-pressed", "true");
	await materialToggle.click();
	await expect(materialToggle).toHaveAttribute("aria-pressed", "false");
	await materialToggle.click();
	await expect(materialToggle).toHaveAttribute("aria-pressed", "true");

	await laborToggle.focus();
	await window.keyboard.press("Enter");
	await expect(laborToggle).toHaveAttribute("aria-pressed", "false");
	await window.keyboard.press(" ");
	await expect(laborToggle).toHaveAttribute("aria-pressed", "true");

	// 全部隐藏：图例必须留着，才能逐项恢复（不能只剩「重置整张图」这一条路）
	await laborToggle.click();
	await materialToggle.click();
	await expect(laborToggle).toHaveAttribute("aria-pressed", "false");
	await expect(materialToggle).toHaveAttribute("aria-pressed", "false");
	await expect(card(window).getByRole("button", { name: /人工费/ })).toBeVisible();
	await expect(card(window).getByRole("button", { name: /材料费/ })).toBeVisible();
	await expect(card(window).locator(".recharts-bar-rectangle")).toHaveCount(0);
	await laborToggle.click();
	await expect(laborToggle).toHaveAttribute("aria-pressed", "true");
	await expect(card(window).locator(".recharts-bar-rectangle").first()).toBeVisible();
	await materialToggle.click();
	await expect(materialToggle).toHaveAttribute("aria-pressed", "true");

	// 数据表：零值显示为 0、缺失值显示为破折号
	await card(window).getByRole("button", { name: "查看数据" }).click();
	const table = card(window).locator("table");
	await expect(table).toBeVisible({ timeout: 10_000 });
	await expect(table).toContainText("人工费 (元)");
	await expect(table.locator("tbody tr").nth(1)).toContainText("0");
	await expect(table.locator("tbody tr").nth(1)).toContainText("—");

	// 放大：对话框共用同一份数据，关闭后回到卡片
	await card(window).getByRole("button", { name: "放大" }).click();
	const dialog = window.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog).toContainText("月度支出");
	await window.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0, { timeout: 10_000 });

	// 折叠执行过程：图表成果在大折叠栏外，收起后仍可见（G-A6）
	const foldToggle = window.locator(".execution-summary-toggle").first();
	if ((await foldToggle.count()) > 0 && (await foldToggle.getAttribute("aria-expanded")) === "true") await foldToggle.click();
	await expect(card(window)).toBeVisible();
	await expect(window.locator(`.execution-summary-details [data-chart-id="${CHART_ID}"]`)).toHaveCount(0);
	const toolRow = window.locator(".tool-card").first();
	if ((await toolRow.count()) > 0) await expect(toolRow).toBeHidden();
});

test("chart card: a follow-up message revises the chart and keeps the original", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 第一句：生成原图（柱状）
	await sendPrompt(window, "CHART 按月画一下支出");
	await waitForRunSettled(window);
	await expect(card(window).locator(".recharts-bar-rectangle").first()).toBeVisible({ timeout: 15_000 });

	// 第二句（同一会话）：自然语言改图 → Pi 生成关联原图的新结果
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type("CHART_REVISE 换成折线");
	await window.keyboard.press("Enter");
	await expect(cardById(window, REVISE_CHART_ID)).toBeVisible({ timeout: 30_000 });
	await waitForRunSettled(window);

	// 新图带关联标记且是折线；原图保留、没有被覆盖，两张图身份各自唯一
	const revised = cardById(window, REVISE_CHART_ID);
	await expect(revised).toContainText("月度支出（折线）");
	await expect(revised).toContainText("基于原图修改");
	await expect(revised.locator(".recharts-line").first()).toBeVisible({ timeout: 15_000 });
	await expect(card(window)).toBeVisible();
	await expect(card(window).locator(".recharts-bar-rectangle").first()).toBeVisible();
	await expect(card(window)).toContainText("月度支出");
	expect(await card(window).count()).toBe(1);
	expect(await revised.count()).toBe(1);
});

test("chart card: pie tooltip keeps category, unit and share", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await sendPrompt(window, "CHART_PIE 画支出占比", PIE_CHART_ID);
	await waitForRunSettled(window);

	const pie = cardById(window, PIE_CHART_ID);
	await expect(pie).toContainText("支出占比");
	await expect(pie.locator(".recharts-pie-sector").first()).toBeVisible({ timeout: 15_000 });
	await pie.scrollIntoViewIfNeeded();
	const ringPoint = await pie.locator(".recharts-surface").evaluate((svg) => {
		const rect = svg.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		// 甜甜圈扇区的包围盒中心落在空心处，直接按元素 hover 会命中外层 svg；
		// 这里在圆环带上采样，取第一个真正命中扇区路径的点。
		for (let radius = 40; radius <= 115; radius += 4) {
			for (let degree = -180; degree <= 180; degree += 5) {
				const radian = (degree * Math.PI) / 180;
				const x = cx + Math.cos(radian) * radius;
				const y = cy + Math.sin(radian) * radius;
				const hit = document.elementFromPoint(x, y);
				if (hit?.closest(".recharts-pie-sector")) return { x, y };
			}
		}
		return null;
	});
	expect(ringPoint).not.toBeNull();
	await window.mouse.move(ringPoint?.x ?? 0, ringPoint?.y ?? 0);
	const pieTooltip = pie.locator(".recharts-tooltip-wrapper");
	// 采样点命中哪一块扇区取决于角度，这里断言「内容形状正确」而不是写死某一块：
	// 类别是夹具里的月份、系列名在、数值带单位、占比带百分号。
	let tooltipText = "";
	await expect
		.poll(
			async () => {
				tooltipText = (await pieTooltip.innerText()).trim();
				return tooltipText.length > 0;
			},
			{ timeout: 10_000 },
		)
		.toBe(true);
	expect(tooltipText).toMatch(/0[123]/);
	expect(tooltipText).toContain("人工费");
	expect(tooltipText).toMatch(/\d+ 元/);
	expect(tooltipText).toContain("占比");
	expect(tooltipText).toMatch(/%/);
});

test("chart card: exports PNG and CSV through the real handler and writes real files", async ({ app, window }) => {
	test.setTimeout(180_000);
	// 只替换系统保存对话框（原生窗口 Playwright 驱动不了）。
	// chartIpc 的参数校验、文件名清洗与真实落盘仍走生产实现，断言也直接读磁盘文件。
	const exportDir = mkdtempSync(join(tmpdir(), "pideck-chart-export-"));
	await app.evaluate(async ({ dialog }, dir) => {
		dialog.showSaveDialog = async (options) => {
			const extension = options?.filters?.[0]?.extensions?.[0] === "png" ? "png" : "csv";
			return { canceled: false, filePath: `${dir}/chart.${extension}` };
		};
	}, exportDir);

	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await sendPrompt(window, "CHART 按月画一下支出");
	await waitForRunSettled(window);

	await card(window).getByRole("button", { name: "保存图片" }).click();
	const pngPath = join(exportDir, "chart.png");
	await expect.poll(() => existsSync(pngPath), { timeout: 30_000 }).toBe(true);
	const png = readFileSync(pngPath);
	expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	expect(png.length).toBeGreaterThan(2000);
	expect(statSync(pngPath).size).toBe(png.length);

	await card(window).getByRole("button", { name: "导出 CSV" }).click();
	const csvPath = join(exportDir, "chart.csv");
	await expect.poll(() => existsSync(csvPath), { timeout: 20_000 }).toBe(true);
	const csvLines = readFileSync(csvPath, "utf8")
		.split("\n")
		.map((line) => line.replace(/\r$/, ""));
	expect(csvLines).toEqual(["月份,人工费 (元),材料费 (元)", "01,100,80", "02,0,", "03,120,90"]);

	// 隐藏一个系列后再导出：文件只剩可见系列（导出反映当前视图）
	await card(window)
		.getByRole("button", { name: /材料费/ })
		.click();
	await card(window).getByRole("button", { name: "导出 CSV" }).click();
	await expect.poll(() => readFileSync(csvPath, "utf8").split("\n")[0].trim(), { timeout: 20_000 }).toBe("月份,人工费 (元)");
});

test("chart card: stays readable in a narrow conversation column", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await sendPrompt(window, "CHART 按月画一下支出");
	await waitForRunSettled(window);

	// 窗口宽度有 880 下限，所以窄栏靠「窗口收到最小 + 打开右侧抽屉」压出来，
	// 这正是用户在窄分屏下的真实排布。
	await app.evaluate(async ({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].setSize(880, 900);
	});
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toBeVisible({ timeout: 15_000 });
	await expect.poll(async () => window.locator(".message-timeline").evaluate((node) => node.clientWidth), { timeout: 15_000 }).toBeLessThan(700);

	const viewportWidth = await window.evaluate(() => window.innerWidth);
	const box = await card(window).boundingBox();
	expect(box).not.toBeNull();
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewportWidth + 1);
	// 图形不越出卡片，控件在窄栏里仍可用
	const svgWidth = await card(window)
		.locator(".recharts-surface")
		.evaluate((node) => node.getBoundingClientRect().width);
	expect(svgWidth).toBeLessThanOrEqual((box?.width ?? 0) + 1);
	await expect(card(window).getByRole("button", { name: /人工费/ })).toBeVisible();
	await expect(card(window).getByRole("button", { name: "查看数据" })).toBeVisible();
	await card(window).getByRole("button", { name: "查看数据" }).click();
	await expect(card(window).locator("table")).toBeVisible({ timeout: 10_000 });
});

/** 与 history-restore.spec.ts 同构的自管双次 launch（图表恢复需要同一 userData 与项目目录）。 */
async function launchApp(userDataRoot: string): Promise<ElectronApplication> {
	const env = {
		...process.env,
		CI: "1",
		...(process.platform === "win32" ? { APPDATA: userDataRoot } : process.platform === "darwin" ? { HOME: userDataRoot } : { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
	};
	delete env.ELECTRON_RENDERER_URL;
	return electron.launch({
		args: [join(repoRoot, "out", "main", "index.js"), `--user-data-dir=${join(userDataRoot, "profile")}`],
		env,
	});
}

test("chart card: survives an app restart through session history", async () => {
	test.setTimeout(240_000);
	const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-chart-"));
	const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-chart-"));
	const shimPath = join(userDataRoot, "mock-pi.cmd");
	writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${join(repoRoot, "e2e", "mock-pi.cjs")}" %*\r\n`);
	mkdirSync(join(userDataRoot, "profile"), { recursive: true });
	writeFileSync(join(userDataRoot, "profile", "settings.json"), JSON.stringify({ customPiPath: shimPath, piEnvironmentChecked: true, dshHomeDir: join(userDataRoot, "dsh-home") }));
	writeFileSync(join(userDataRoot, "profile", "projects.json"), JSON.stringify([{ id: "e2e-chart-restore", name: "chart-restore", path: projectDir, lastOpenedAt: Date.now(), sortOrder: 0 }]));

	let app1: ElectronApplication | undefined;
	let app2: ElectronApplication | undefined;
	try {
		app1 = await launchApp(userDataRoot);
		const window1 = await app1.firstWindow();
		await window1.waitForLoadState("domcontentloaded");
		await expect(window1.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await sendPrompt(window1, "CHART 按月画一下支出");
		// 等本轮真正结束：mock 在流式收尾时才把 user/toolResult/assistant 写进会话文件。
		// 只等 "Mock 回复：" 会假通过——前缀在第一个 chunk 就出现，此时关应用会把 mock 杀掉，
		// 会话文件只剩 0 字节（实测），历史里自然没有图表可恢复。
		await waitForRunSettled(window1);
		await app1.close();
		app1 = undefined;

		app2 = await launchApp(userDataRoot);
		const window2 = await app2.firstWindow();
		await window2.waitForLoadState("domcontentloaded");
		await expect(window2.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

		// 历史会话在侧栏：打开后图表随原生 toolResult 恢复，不重新请求模型。
		const historyRow = window2.locator(".conversation", { hasText: "CHART" }).first();
		await expect(historyRow).toBeVisible({ timeout: 30_000 });
		await historyRow.click();
		await expect(window2.locator(".message-timeline")).toContainText("CHART", { timeout: 20_000 });
		await expect(cardById(window2, CHART_ID)).toBeVisible({ timeout: 30_000 });
		await expect(cardById(window2, CHART_ID)).toContainText("月度支出");

		// 恢复后的图表仍可交互：数据表能打开
		await cardById(window2, CHART_ID).getByRole("button", { name: "查看数据" }).click();
		await expect(cardById(window2, CHART_ID).locator("table")).toContainText("人工费 (元)", { timeout: 10_000 });
	} finally {
		await app1?.close();
		await app2?.close();
	}
});
