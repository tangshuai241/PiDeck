import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

let server: ViteDevServer;
let origin: string;
test.use({ channel: "msedge", viewport: { width: 1440, height: 1000 } });

test.beforeAll(async () => {
	server = await createServer({
		configFile: false,
		root: resolve(__dirname, ".."),
		resolve: { alias: { "@": resolve(__dirname, "../src/renderer/src"), "@shared": resolve(__dirname, "../src/shared") } },
		plugins: [
			react(),
			tailwindcss(),
			{
				name: "isolated-todo-page",
				configureServer(vite) {
					vite.middlewares.use(async (req, res, next) => {
						if (req.url?.split("?")[0] !== "/__todo-ui") return next();
						const html = await vite.transformIndexHtml("/__todo-ui", '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/e2e/harness/personal-todo.tsx"></script></body></html>');
						res.setHeader("Content-Type", "text/html; charset=utf-8");
						res.end(html);
					});
				},
			},
		],
		server: { host: "127.0.0.1", port: 0 },
		optimizeDeps: { entries: [resolve(__dirname, "harness/personal-todo.tsx")] },
	});
	await server.listen();
	origin = server.resolvedUrls?.local[0] ?? "";
	if (!origin) throw new Error("isolated todo server did not bind");
});
test.afterAll(async () => {
	await server?.close();
});

test("列表单元格可弹出选择器，选中后只修改目标字段", async ({ page }, testInfo) => {
	await page.goto(`${origin}__todo-ui`);
	const row = page.locator('[data-todo-id="overdue"]');
	await row.getByRole("button", { name: "更改紧急度：核对预算与审批资料", exact: true }).click();
	await expect(page.getByRole("menuitemradio", { name: "紧急", exact: true })).toHaveAttribute("aria-checked", "true");
	await page.screenshot({ path: testInfo.outputPath("todo-priority-picker.png"), animations: "disabled" });
	await page.getByRole("menuitemradio", { name: "低", exact: true }).click();
	await expect(row.getByRole("button", { name: "更改紧急度：核对预算与审批资料", exact: true })).toContainText("低");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.at(-1))).toMatchObject({ kind: "patch", id: "overdue", patch: { urgency: 0 } });
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await row.getByRole("button", { name: "更改日期：核对预算与审批资料", exact: true }).click();
	await expect(page.locator('[data-slot="calendar"]')).toBeVisible();
	await expect
		.poll(() =>
			page
				.locator('[data-slot="calendar"] button[data-day]')
				.first()
				.evaluate((element) => element.getBoundingClientRect().width),
		)
		.toBeGreaterThanOrEqual(32);
	await expect
		.poll(() =>
			page
				.locator('[data-slot="calendar"] button[data-day]')
				.first()
				.evaluate((element) => element.getBoundingClientRect().height),
		)
		.toBeGreaterThanOrEqual(32);
	await page.screenshot({ path: testInfo.outputPath("todo-date-picker.png"), animations: "disabled" });
	await page.getByRole("button", { name: "明天", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.at(-1)?.kind)).toBe("patch");
	await expect(page.locator('[data-todo-group="upcoming"] [data-todo-id="overdue"]')).toBeVisible();
	await row.getByRole("button", { name: "更改状态：核对预算与审批资料", exact: true }).click();
	await page.screenshot({ path: testInfo.outputPath("todo-status-picker.png"), animations: "disabled" });
	await page.getByRole("menuitemradio", { name: /已取消/ }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.id === "overdue")?.item.status)).toBe("cancelled");
});

test("筛选内可嵌套选择分类与日期；减少动画设置覆盖字段浮层", async ({ page }) => {
	await page.goto(`${origin}__todo-ui`);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("button", { name: "筛选", exact: true }).click();
	await page.getByRole("button", { name: "分类", exact: true }).click();
	await page.getByRole("option", { name: "阅读", exact: true }).click();
	await expect(page.locator('[data-todo-id="raw"]')).toBeVisible();
	await expect(page.locator('[data-todo-id="overdue"]')).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "清空筛选", exact: true }).click();
	await page.getByRole("button", { name: "筛选", exact: true }).click();
	await page.getByRole("button", { name: "起始日期", exact: true }).click();
	const calendar = page.getByRole("dialog", { name: "起始日期", exact: true });
	await expect.poll(() => calendar.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
	await calendar.getByRole("button", { name: "今天", exact: true }).click();
	await expect(page.locator('[data-todo-id="today"]')).toBeVisible();
	await expect(page.locator('[data-todo-id="overdue"]')).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "清空筛选", exact: true }).click();
	await page.locator('[data-todo-id="overdue"]').getByRole("button", { name: "更改紧急度：核对预算与审批资料", exact: true }).click();
	await expect.poll(() => page.getByRole("menu").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
	await page.keyboard.press("Escape");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.length)).toBe(0);
});

test("分类失败保留输入；日期原文不被猜测，日历翻页和版本冲突可处理", async ({ page }) => {
	await page.goto(`${origin}__todo-ui`);
	const row = page.locator('[data-todo-id="overdue"]');
	await row.getByRole("button", { name: "更改紧急度：核对预算与审批资料", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "无紧急度", exact: true }).click();
	await expect(row).toContainText("无紧急度");
	await page.evaluate(() => {
		window.todoUiHarness.fail = true;
	});
	await row.getByRole("button", { name: "更改分类：核对预算与审批资料", exact: true }).click();
	const category = page.getByRole("textbox", { name: "搜索或输入分类", exact: true });
	await category.fill("研究记录");
	await category.press("Enter");
	await expect(page.getByRole("alert")).toContainText("当前离线");
	await expect(category).toHaveValue("研究记录");
	await page.evaluate(() => {
		window.todoUiHarness.fail = false;
	});
	await category.press("Enter");
	await expect(row).toContainText("研究记录");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.id === "overdue")?.item.urgency)).toBe(null);

	const rawRow = page.locator('[data-todo-id="raw"]');
	const before = await page.evaluate(() => window.todoUiHarness.submits.length);
	await rawRow.getByRole("button", { name: "更改日期：读完手边这本书", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "日期或原文", exact: true })).toHaveValue("下周");
	await page.keyboard.press("Escape");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.length)).toBe(before);
	await expect(rawRow).toContainText("下周");
	await row.getByRole("button", { name: "更改日期：核对预算与审批资料", exact: true }).click();
	await page.getByRole("button", { name: "下个月", exact: true }).click();
	await page.locator('[data-slot="calendar"] button[data-day]').filter({ hasText: /^15$/ }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.at(-1))).toMatchObject({ kind: "patch", id: "overdue", patch: { deadline: expect.stringMatching(/^\d{4}-\d{2}-15$/) } });
	await row.getByRole("button", { name: "更改日期：核对预算与审批资料", exact: true }).click();
	await page.getByRole("button", { name: "清除日期", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.id === "overdue")?.item.deadline)).toBe(null);

	await row.getByRole("button", { name: "更改紧急度：核对预算与审批资料", exact: true }).click();
	await page.evaluate(() => {
		const view = window.todoUiHarness.items.find((entry) => entry.item.id === "overdue");
		if (view) view.item = { ...view.item, revision: "external-change" };
	});
	await page.getByRole("menuitemradio", { name: "紧急", exact: true }).click();
	await expect(page.getByRole("menu").getByRole("alert")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.id === "overdue")?.item.urgency)).toBe(null);
	await page.keyboard.press("Escape");
});

test("新建与详情共用选择器；选择草稿字段不会提前发送保存", async ({ page }) => {
	await page.goto(`${origin}__todo-ui`);
	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	const panel = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "标题", exact: true }) });
	await panel.getByRole("textbox", { name: "标题", exact: true }).fill("选择器创建的待办");
	await panel.getByRole("button", { name: "紧急度", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "高", exact: true }).click();
	await panel.getByRole("button", { name: "日期", exact: true }).click();
	await page.getByRole("button", { name: "下周一", exact: true }).click();
	await panel.getByRole("button", { name: "分类", exact: true }).click();
	await page.getByRole("textbox", { name: "搜索或输入分类", exact: true }).fill("研究");
	await page.getByRole("textbox", { name: "搜索或输入分类", exact: true }).press("Enter");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.length)).toBe(0);
	await panel.getByRole("button", { name: "创建", exact: true }).click();
	await expect(panel).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.title === "选择器创建的待办")?.item)).toMatchObject({ category: "研究", urgency: 2, deadline: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
	await page.getByRole("button", { name: "选择器创建的待办", exact: true }).click();
	const detail = page.getByRole("dialog");
	await detail.getByRole("button", { name: "更改紧急度：选择器创建的待办", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "中", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.title === "选择器创建的待办")?.item.urgency)).toBe(1);
	await detail.getByRole("button", { name: "更改状态：选择器创建的待办", exact: true }).click();
	await page.keyboard.press("3");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.title === "选择器创建的待办")?.item.status)).toBe("cancelled");
	await expect(detail).toBeVisible();
});

test("列表直接新增子待办；子项编辑失败保留标题备注，成功后再清理", async ({ page }) => {
	await page.goto(`${origin}__todo-ui`);
	const row = page.locator('[data-todo-id="parent"]');
	await row.hover();
	await row.getByRole("button", { name: "添加子待办：完成待办页面改造", exact: true }).click();
	const input = row.getByRole("textbox", { name: "添加一层子待办", exact: true });
	await input.fill("行内新增子待办");
	await input.press("Enter");
	await expect(row).toContainText("行内新增子待办");
	await expect(input).toHaveValue("");
	await row.getByRole("button", { name: "完成待办页面改造", exact: true }).click();
	const panel = page.getByRole("dialog");
	await panel.getByRole("button", { name: "核对列表交互", exact: true }).click();
	await panel.getByRole("textbox", { name: "子待办标题", exact: true }).fill("修改后的子待办");
	await panel.getByRole("textbox", { name: "子待办备注", exact: true }).fill("完整备注\n第二行");
	await page.evaluate(() => {
		window.todoUiHarness.fail = true;
	});
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("alert")).toContainText("当前离线");
	await expect(panel.getByRole("textbox", { name: "子待办标题", exact: true })).toHaveValue("修改后的子待办");
	await expect(panel.getByRole("textbox", { name: "子待办备注", exact: true })).toHaveValue("完整备注\n第二行");
	await page.evaluate(() => {
		window.todoUiHarness.fail = false;
	});
	await panel.getByRole("textbox", { name: "子待办标题", exact: true }).press("Enter");
	await expect(panel.getByRole("button", { name: "修改后的子待办", exact: true })).toBeVisible();
	await expect(panel.getByRole("alert")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.find((view) => view.item.id === "parent")?.item.status)).toBe("open");
});

test("分组列表、详情抽屉、失败草稿、子待办、日期视图和小窗口", async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${origin}__todo-ui`);
	await expect(page.getByRole("heading", { name: "我的待办" })).toBeVisible();
	await expect(page.getByRole("button", { name: "核对预算与审批资料", exact: true })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator('[data-todo-group="completed"] button[aria-expanded]').first()).toHaveAttribute("aria-expanded", "false");
	await page.screenshot({ path: testInfo.outputPath("todo-list-light.png"), animations: "disabled" });

	const opener = page.getByRole("button", { name: "核对预算与审批资料", exact: true });
	await opener.click();
	const panel = page.getByRole("dialog");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("这是隔离测试中的背景说明。");
	await page.screenshot({ path: testInfo.outputPath("todo-detail.png"), animations: "disabled" });
	await panel.getByRole("button", { name: "展开宽栏", exact: true }).click();
	await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(900);
	await page.screenshot({ path: testInfo.outputPath("todo-detail-wide.png"), animations: "disabled" });
	await panel.getByRole("button", { name: "恢复窄栏", exact: true }).click();
	await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width)).toBe(580);
	await panel.getByRole("button", { name: "编辑", exact: true }).click();
	const title = panel.getByRole("textbox").first();
	await title.fill("预算修改草稿");
	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(opener).toBeFocused();
	await opener.click();
	await expect(panel.getByRole("textbox").first()).toHaveValue("预算修改草稿");
	await page.evaluate(() => {
		window.todoUiHarness.fail = true;
	});
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("textbox").first()).toHaveValue("预算修改草稿");
	await expect(panel).toContainText("当前离线；改动会留在本机待传队列，恢复后再确认。");
	await page.screenshot({ path: testInfo.outputPath("todo-detail-draft.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	await page.evaluate(() => {
		window.todoUiHarness.fail = false;
	});

	const parent = page.locator('[data-todo-id="parent"]');
	await parent.getByRole("button", { name: "完成：完成待办页面改造", exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.filter((operation) => operation.kind === "status").length)).toBe(0);
	await parent.getByRole("button", { name: "展开或收起子待办：完成待办页面改造" }).click();
	await parent.getByRole("button", { name: "完成：核对列表交互", exact: true }).click();
	await expect(parent).toContainText("1/1");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.find((operation) => operation.kind === "subtodoStatus"))).toMatchObject({ kind: "subtodoStatus", subtodoId: "sub-1", status: "done" });
	await expect(page.locator('[data-todo-group="upcoming"]')).toContainText("完成待办页面改造");

	await page.getByRole("button", { name: "在今天添加待办", exact: true }).click();
	await page.getByRole("textbox", { name: "新待办标题" }).fill("组内快速新增");
	await page.getByRole("textbox", { name: "新待办标题" }).press("Enter");
	await expect(page.locator('[data-todo-group="today"]')).toContainText("组内快速新增");
	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	await panel.getByRole("textbox", { name: "标题", exact: true }).fill("新建草稿保留");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	await expect(panel.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("新建草稿保留");
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "日历", exact: true }).click();
	await expect(page.locator("[data-todo-calendar]")).toBeVisible();
	await expect(page.getByRole("button", { name: "读完手边这本书", exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("todo-calendar.png"), animations: "disabled" });
	await page.getByRole("button", { name: "列表", exact: true }).click();
	await page.getByRole("textbox", { name: "搜索标题或备注" }).fill("设计讨论");
	await expect(page.locator("[data-todo-id]")).toHaveCount(1);
	await page.getByRole("button", { name: "清空筛选" }).click();
	await expect(page.locator('[data-todo-id="today"]')).toBeVisible();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("button", { name: "展开或收起今天", exact: true }).click();
	await expect(page.locator('[data-todo-group="today"] > [data-slot="collapsible-content"]')).not.toBeVisible();
	await expect.poll(() => page.locator('[data-todo-group="today"] > [data-slot="collapsible-content"]').evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
	await page.getByRole("button", { name: "展开或收起今天", exact: true }).click();
	await page.setViewportSize({ width: 800, height: 700 });
	await expect.poll(() => page.locator("[data-personal-todo-workspace]").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("todo-narrow.png"), animations: "disabled" });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await page.screenshot({ path: testInfo.outputPath("todo-list-dark.png"), animations: "disabled" });
	expect(errors).toEqual([]);
});

test("完成反馈后归组；新建失败与迟到结果不丢草稿或关闭另一事项", async ({ page }) => {
	await page.goto(`${origin}__todo-ui`);
	await expect(page.getByRole("heading", { name: "我的待办" })).toBeVisible();
	await page.getByRole("button", { name: "完成：整理今天的工作记录", exact: true }).click();
	await expect(page.locator('[data-todo-group="today"] [data-todo-id="today"]').getByRole("button", { name: "重新打开：整理今天的工作记录", exact: true })).toBeVisible();
	await expect(page.locator('[data-todo-group="today"] [data-todo-id="today"]')).toHaveCount(0);
	await page.getByRole("button", { name: "展开或收起已完成", exact: true }).click();
	await expect(page.locator('[data-todo-group="completed"]')).toContainText("整理今天的工作记录");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.filter((operation) => operation.kind === "status").length)).toBe(1);

	const panel = page.getByRole("dialog");
	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	await panel.getByRole("textbox", { name: "标题", exact: true }).fill("失败后继续填写");
	await page.evaluate(() => {
		window.todoUiHarness.fail = true;
	});
	await panel.getByRole("button", { name: "创建", exact: true }).click();
	await expect(panel).toContainText("当前离线；改动会留在本机待传队列，恢复后再确认。");
	await expect(panel.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("失败后继续填写");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	await expect(panel.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("失败后继续填写");
	await page.evaluate(() => {
		window.todoUiHarness.fail = false;
		window.todoUiHarness.delay = 1000;
	});
	await panel.getByRole("button", { name: "创建", exact: true }).click();
	await expect(panel.getByRole("button", { name: "创建", exact: true })).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "准备下周设计讨论", exact: true }).click();
	await expect(panel.getByRole("heading", { name: "准备下周设计讨论", exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.filter((view) => view.item.title === "失败后继续填写").length)).toBe(1);
	await expect(panel.getByRole("heading", { name: "准备下周设计讨论", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "新建待办", exact: true }).click();
	await expect(panel.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("");
	await panel.getByRole("textbox", { name: "标题", exact: true }).fill("发出的第一份草稿");
	await panel.getByRole("button", { name: "创建", exact: true }).click();
	await panel.getByRole("textbox", { name: "标题", exact: true }).fill("后来继续输入的内容");
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.items.filter((view) => view.item.title === "发出的第一份草稿").length)).toBe(1);
	await expect(panel.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("后来继续输入的内容");
	await expect(panel).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.todoUiHarness.submits.filter((operation) => operation.kind === "create").length)).toBe(3);
	await page.keyboard.press("Escape");
	await page.evaluate(() => {
		window.todoUiHarness.nextCursor = "next-page";
	});
	await page.getByRole("button", { name: "刷新", exact: true }).click();
	await expect(page.getByText(/当前已加载 .*分组、统计与排序仅涵盖当前结果/)).toBeVisible();
	await expect(page.getByRole("button", { name: "加载更多", exact: true })).toBeVisible();
});
