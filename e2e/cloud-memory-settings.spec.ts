/**
 * 云端记忆设置页真实 Electron 验收（N04 UI 验收，单用例）。
 *
 * 三段都是真的：
 * 1. 隔离 cloud server（workbench-cloud/tests/helpers.cjs）真实 HTTP：登录 → GET 人格 → CAS PUT 合成稿；
 * 2. 真实 Electron（out/main/index.js，隔离 userData，PIDECK_E2E=1）：全部动作走真实点击/输入，
 *    desktopApi 只用于读证据（getStatus / 文件与 DOM 的 contains 检查）；
 * 3. 断言连接状态、人格版本只读、开关、登出后需重连且密码不回填、未知同步不显示 0、
 *    凭据不落 DOM/渲染层/日志。
 *
 * 边界：不开 model_calls / Hindsight；不读生产数据；不 spawn pi；不生成 manifest；
 * 不打印任何令牌（只在 contains 断言里使用）。
 */
import { test, expect } from "./fixtures";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeSeedProject } from "./open-session";

const CLOUD_REPO = process.env.PIDECK_E2E_CLOUD_REPO ?? "E:/A PI/work/workbench-cloud";
const PERSONA_TEXT = "N04 approved fixture，先结论再依据";

type CloudServer = { port: number; stop: () => Promise<number | null>; getStderr: () => string };
type CloudFixture = {
	TEST_PASSWORD: string;
	mkTmp: (prefix?: string) => string;
	makeConfig: (dir: string, overrides?: Record<string, unknown>) => { configPath: string };
	startServer: (configPath: string) => Promise<CloudServer>;
	login: (port: number, username?: string, password?: string) => Promise<{ token: string }>;
	request: (port: number, method: string, path: string, options?: { token?: string; body?: unknown }) => Promise<{ status: number; json: unknown; text: string }>;
};
// CJS 边界：这是 cloud 仓的测试夹具模块（本仓 e2e 由 Playwright 以 CJS 转译，require 可用）。
const cloud = require(`${CLOUD_REPO}/tests/helpers.cjs`) as CloudFixture;

const seedProject = makeSeedProject("N04CloudMemory");
test.use({ seedProjects: [seedProject] });

let server: CloudServer | null = null;
let cloudDir = "";
let serverStopped = false;

/** 递归收集日志文件文本；只用于「密钥不落盘」检查，不打印内容。 */
function readLogText(root: string, budget = 2 * 1024 * 1024): string {
	if (!existsSync(root)) return "";
	let text = "";
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (text.length > budget) return;
			const path = join(dir, entry.name);
			try {
				if (entry.isDirectory()) walk(path);
				else if (entry.isFile() && statSync(path).size <= 512 * 1024) text += readFileSync(path, "utf8");
			} catch {
				// 日志可能正被占用（Windows）：跳过该文件，不影响「密钥不外泄」结论
			}
		}
	};
	walk(root);
	return text;
}

test.beforeAll(async () => {
	cloudDir = cloud.mkTmp("pideck-n04-cloud-");
	const { configPath } = cloud.makeConfig(cloudDir, {
		features: { personal_domain: true, chat: true, model_calls: false, hindsight_memory: false, hindsight_memory_write: false },
		limits: { body_max_bytes: 65536 },
	});
	server = await cloud.startServer(configPath);
	// 真实 HTTP 认证 + 真实 CAS 发布合成人格稿（不碰生产实例）
	const session = await cloud.login(server.port);
	const current = await cloud.request(server.port, "GET", "/api/cloud/persona", { token: session.token });
	const persona = current.json as { revision?: string; raw_revision?: string; store_revision?: number } | null;
	expect(current.status).toBe(200);
	const saved = await cloud.request(server.port, "PUT", "/api/cloud/persona", {
		token: session.token,
		body: {
			request_id: `n04-e2e-${Date.now()}`,
			text: PERSONA_TEXT,
			expected_revision: persona?.revision ?? null,
			expected_raw_revision: persona?.raw_revision ?? null,
			expected_store_revision: persona?.store_revision ?? 0,
		},
	});
	expect(saved.status, `persona CAS 保存失败：${JSON.stringify((saved.json as { error?: unknown } | null)?.error ?? null)}`).toBe(200);
});

test.afterAll(async () => {
	// 只停自己 fork 的进程：优雅退出码 0；非 0 时把 stderr 交给报告排查
	if (server) {
		const code = await server.stop();
		serverStopped = true;
		expect(code, `cloud fixture 未优雅退出，stderr=${server.getStderr().slice(0, 500)}`).toBe(0);
	}
	if (cloudDir) rmSync(cloudDir, { recursive: true, force: true });
	expect(serverStopped).toBe(true);
});

test("云端记忆：真实连接、人格只读、开关、登出与凭据不外泄", async ({ window, userDataRoot }) => {
	expect(server).not.toBeNull();
	const port = server?.port ?? 0;
	expect(port).toBeGreaterThan(0);

	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	window.on("pageerror", (error) => pageErrors.push(error.message));
	window.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});

	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("button", { name: /^设置/ }).first().click();
	const dialog = window.getByRole("dialog", { name: "设置" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("tab", { name: "云端记忆" }).click();
	// 只断言本 tab 的活动面板：其它 tab 是 hidden 保挂载，整 dialog 范围会掺入无关文案
	// 用可访问名定位本页签面板：设置壳与其它嵌套 Tab 也各有自己的 tabpanel
	const panel = dialog.getByRole("tabpanel", { name: "云端记忆" });
	await expect(panel).toBeVisible();

	// ── 未连接时的静态事实：两类会话都归档、项目标签、WSL 说明；未知不显示 0；无模式切换
	await expect(panel.getByText("归档范围：个人与项目会话的可见对话")).toBeVisible();
	await expect(panel.getByText("项目标签只用于资料分组", { exact: false }).first()).toBeVisible();
	await expect(panel.getByText("WSL 会话暂不支持云端记忆")).toBeVisible();
	await expect(panel.getByText("召回模式")).toHaveCount(0);
	await expect(panel.getByText("未知（尚未收到运行时状态）").first()).toBeVisible();
	await expect(panel.getByText("0 条待传（按设备去重）")).toHaveCount(0);

	// ── 真实点击连接（loopback cloud，隔离实例）
	await panel.getByPlaceholder("https://workbench.example.com").fill(`http://127.0.0.1:${port}`);
	await panel.locator('input[autocomplete="username"]').fill("admin");
	await panel.locator('input[autocomplete="current-password"]').fill(cloud.TEST_PASSWORD);
	await panel.getByRole("button", { name: "连接", exact: true }).click();

	await expect(panel.getByText("已连接")).toBeVisible({ timeout: 20_000 });
	// 连接后凭据文件已落盘（加密），读取仅用于「不外泄」比对，不打印
	const connectionDir = join(userDataRoot, "profile", "cloud-memory");
	const authFile = join(connectionDir, "auth.json");
	const connectionFile = join(connectionDir, "connection.json");
	expect(existsSync(authFile)).toBe(true);
	const tpaToken = (JSON.parse(readFileSync(authFile, "utf8")) as { token?: string }).token ?? "";
	expect(tpaToken.length).toBeGreaterThan(0);
	expect(readFileSync(connectionFile, "utf8").includes(cloud.TEST_PASSWORD)).toBe(false);

	// ── 人格版本只读：revision 摘要 + 展开正文；没有编辑器
	await expect(panel.getByText("确认绑定")).toHaveCount(0);
	await expect(panel.getByRole("button", { name: /发布|保存/ })).toHaveCount(0);
	await panel.getByRole("button", { name: "展开正文" }).click();
	const personaText = panel.locator("pre");
	await expect(personaText).toBeVisible();
	await expect(personaText).toContainText(PERSONA_TEXT);
	await expect(panel.locator("pre[contenteditable='true']")).toHaveCount(0);

	// ── 开关：真实点击同步范围与总开关，读回 aria-checked
	const syncSwitch = panel.getByRole("switch", { name: "同步个人与项目会话" });
	await syncSwitch.click();
	await expect(syncSwitch).toHaveAttribute("aria-checked", "false");
	await syncSwitch.click();
	await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
	const enableSwitch = panel.getByRole("switch", { name: "启用云端记忆" });
	await enableSwitch.click();
	await expect(enableSwitch).toHaveAttribute("aria-checked", "false");
	await expect(panel.getByText("未启用")).toBeVisible();
	await enableSwitch.click();
	await expect(enableSwitch).toHaveAttribute("aria-checked", "true");
	await expect(panel.getByText("已连接")).toBeVisible({ timeout: 20_000 });
	await expect(panel.getByText("需要新会话或重启运行时")).toBeVisible();

	// ── 登出：状态回到需重连，密码不回填，未知仍是未知
	await panel.getByRole("button", { name: "登出", exact: true }).click();
	await expect(panel.getByText("需要重新连接")).toBeVisible({ timeout: 20_000 });
	await expect(panel.locator('input[autocomplete="current-password"]')).toHaveValue("");
	await expect(panel.getByText("未知（尚未收到运行时状态）").first()).toBeVisible();
	await expect(panel.getByText("0 条待传（按设备去重）")).toHaveCount(0);

	// ── 凭据不外泄：DOM / 渲染层状态 / 日志
	const domText = (await window.evaluate(() => document.body.innerText)) ?? "";
	const storageText = await window.evaluate(() => JSON.stringify({ local: { ...localStorage } }));
	const statusJson = await window.evaluate(async () => {
		const api = (window as unknown as { piDesktop?: { cloudMemory?: { getStatus?: () => Promise<unknown> } } }).piDesktop;
		return JSON.stringify(await api?.cloudMemory?.getStatus?.());
	});
	expect(domText.includes(cloud.TEST_PASSWORD)).toBe(false);
	expect(domText.includes(tpaToken)).toBe(false);
	expect(storageText.includes(tpaToken)).toBe(false);
	expect(statusJson.includes(tpaToken)).toBe(false);
	expect(statusJson.includes(cloud.TEST_PASSWORD)).toBe(false);
	const logText = readLogText(join(userDataRoot, "profile", "logs"));
	expect(logText.includes(cloud.TEST_PASSWORD)).toBe(false);
	expect(logText.includes(tpaToken)).toBe(false);

	expect(pageErrors, `pageerror: ${pageErrors.join(" | ")}`).toEqual([]);
	const cloudConsoleErrors = consoleErrors.filter((text) => /cloud|memory|凭据|token/i.test(text));
	expect(cloudConsoleErrors, `console error: ${cloudConsoleErrors.join(" | ")}`).toEqual([]);
});
