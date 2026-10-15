import { test, expect } from "./mock-pi-fixture";
import { openSettings } from "./open-session";

// This fixture gives every process in a project the same mock file; a standby
// would falsely look like the stopped conversation instead of an empty runtime.
test.use({ seedSettings: { standbyRuntimeEnabled: false } });

/** Actual click -> IPC -> stdio command -> native rename -> catalog -> visible tab. */
test("generates a title from its own session without a new conversation turn", async ({ window }) => {
	const pageErrors: string[] = [];
	window.on("pageerror", (error) => pageErrors.push(error.message));
	test.setTimeout(120000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
	await composer.click();
	await window.keyboard.type("管理两个 OpenCode 账号额度");
	await window.keyboard.press("Enter");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 30000 });
	const button = window.getByTestId("generate-session-title").first();
	await expect(button).toBeEnabled({ timeout: 15000 });
	const before = await timeline.innerText();
	await button.click();
	await expect(window.getByRole("tab", { name: /双账号额度管理/ })).toBeVisible({ timeout: 15000 });
	await expect.poll(() => timeline.innerText()).toBe(before);
	const records = await window.evaluate(async () => {
		const runtimes = await window.piDesktop.sessions.listRuntimes();
		const runtime = runtimes[0];
		if (!runtime) throw new Error("missing runtime");
		return window.piDesktop.sessions.listCatalog(runtime.projectId, { scan: false });
	});
	expect(records.some((record) => record.title === "双账号额度管理")).toBe(true);
	expect(pageErrors).toEqual([]);
	await window.mouse.move(800, 500);
	await window.screenshot({ path: test.info().outputPath("generated-title.png") });
});

test("a saved session can generate a title after its Pi process has stopped", async ({ window }) => {
	test.setTimeout(120000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
	await composer.click();
	await window.keyboard.type("管理两个 OpenCode 账号额度");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", { timeout: 30000 });
	const button = window.getByTestId("generate-session-title").first();
	await expect(button).toBeEnabled({ timeout: 15000 });
	await window.evaluate(async () => {
		const runtime = (await window.piDesktop.sessions.listRuntimes())[0];
		if (!runtime) throw new Error("missing session runtime");
		const result = await window.piDesktop.sessions.stopRuntime(runtime);
		if (!result.ok) throw new Error("could not stop session runtime");
	});
	// Opening saved history must not require the user to send another message to enable naming.
	await expect(button).toHaveAttribute("aria-label", "启动此会话并生成 AI 标题");
	await expect(button).toBeEnabled();
	await button.click();
	await expect(window.getByRole("tab", { name: /双账号额度管理/ })).toBeVisible({ timeout: 30000 });
	await expect(window.locator(".message-timeline")).not.toContainText("/pideck-title");
});

test("title model can be chosen and saved in common settings", async ({ window }) => {
	test.setTimeout(120000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: "常规", exact: true }).click();
	const control = dialog.getByRole("button", { name: "opencode-go/deepseek-v4.1-flash", exact: true });
	await expect(control).toBeVisible();
	await control.click();
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible();
	await picker.getByRole("combobox").fill("mock-model-pro");
	await picker.getByRole("option", { name: /Mock Model Pro/ }).click();
	await expect(dialog.getByRole("button", { name: "mock/mock-model-pro", exact: true })).toBeVisible();
	// Picking only changes the draft until the user uses the standard Save button.
	expect((await window.evaluate(() => window.piDesktop.settings.get())).sessionTitleModel?.provider).toBe("opencode-go");
	await dialog.getByRole("button", { name: "保存", exact: true }).click();
	await expect.poll(() => window.evaluate(() => window.piDesktop.settings.get().then((settings) => settings.sessionTitleModel))).toEqual({ provider: "mock", modelId: "mock-model-pro" });
	await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();
	const reopened = await openSettings(window);
	await reopened.getByRole("tab", { name: "常规", exact: true }).click();
	await expect(reopened.getByRole("button", { name: "mock/mock-model-pro", exact: true })).toBeVisible();
});
