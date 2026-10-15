import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const output = resolve("E:/A PI/output/TPA/android-reference-v2");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const errors = [];
const checks = [];
const server = createServer(async (request, response) => {
	try {
		const name = new URL(request.url || "/", "http://localhost").pathname;
		const file = resolve(output, `.${name === "/" ? "/index.html" : name}`);
		const rel = relative(output, file);
		if (isAbsolute(rel) || rel.startsWith("..")) {
			response.writeHead(403).end();
			return;
		}
		response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
		response.end(await readFile(file));
	} catch {
		response.writeHead(404).end();
	}
});
await new Promise((done, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", done);
});
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
	const context = await browser.newContext({ viewport: { width: 480, height: 1067 }, deviceScaleFactor: 3, permissions: ["clipboard-read", "clipboard-write"] });
	const page = await context.newPage();
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	const base = `http://127.0.0.1:${address.port}/`;
	const screens = [
		["01-conversations", ""],
		["02-workspaces", "?sheet=workspace"],
		["03-schedules", "?screen=tasks"],
		["04-schedule-editor", "?screen=task-new"],
		["05-projects", "?screen=projects"],
		["06-project-conversations", "?screen=project"],
		["07-new-conversation", "?screen=project&sheet=new-chat"],
		["08-chat", "?screen=chat"],
	];
	for (const [name, query] of screens) {
		await page.goto(base + query, { waitUntil: "networkidle" });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.screenshot({ path: join(output, `${name}.png`), animations: "disabled", fullPage: true });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
		checks.push(`${name}: rendered without horizontal overflow`);
	}
	await page.getByRole("button", { name: "返回", exact: true }).click();
	await page.getByRole("button", { name: "选择工作区", exact: true }).click();
	await page.getByRole("dialog").getByRole("heading", { name: "tangshuai241@gmail.com" }).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "定时任务", exact: true }).click();
	await page.getByRole("button", { name: "新建定时任务", exact: true }).last().click();
	await page.getByRole("textbox", { name: "给这个定时任务起个名字", exact: true }).fill("每天检查工作记录");
	await page.getByRole("textbox", { name: /每次运行时让 Agent/ }).fill("整理本周记录");
	await page.getByRole("button", { name: "保存定时任务", exact: true }).click();
	await page.getByText("表单已保留在本次预览中，尚未创建真实定时任务。", { exact: true }).waitFor();
	await page.getByRole("button", { name: "知道了", exact: true }).click();
	assert.equal(await page.getByRole("textbox", { name: "给这个定时任务起个名字", exact: true }).inputValue(), "每天检查工作记录");
	checks.push("workspace sheet and schedule form navigation; preview does not create real tasks");
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("button", { name: "项目", exact: true }).click();
	await page.getByRole("button", { name: /workbench E:/ }).click();
	await page.getByText("没有匹配的对话", { exact: true }).waitFor();
	await page.getByRole("button", { name: "新建对话", exact: true }).click();
	await page.getByRole("dialog").getByRole("heading", { name: "新建对话", exact: true }).waitFor();
	await page.getByRole("textbox", { name: "消息输入框" }).fill("继续电脑里的同一段对话");
	await page.getByRole("button", { name: "发送消息", exact: true }).click();
	await page.getByText("消息保留在本次预览中，尚未发送到真实电脑。", { exact: true }).waitFor();
	checks.push("project -> new-conversation sheet; no real sending");
	await page.goto(base + "?screen=chat", { waitUntil: "networkidle" });
	assert(await page.getByRole("button", { name: "发送消息", exact: true }).isDisabled());
	await page.getByRole("textbox", { name: "消息输入框" }).fill("原型草稿");
	assert(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled());
	await page.getByRole("button", { name: "复制消息", exact: true }).click();
	assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "你好");
	checks.push("chat input and real clipboard copy");
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		for (const [, query] of screens) {
			await page.goto(base + query, { waitUntil: "domcontentloaded" });
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}: ${query}`);
		}
		checks.push(`${width}px: all screens fit`);
	}
	assert.deepEqual(errors, []);
	checks.push("no runtime or console errors");
} finally {
	await browser.close();
	await new Promise((done) => server.close(done));
}

// The portable review copy embeds assets and preserves ?screen= / ?sheet= links.
let html = await readFile(join(output, "index.html"), "utf8");
const script = html.match(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/);
const style = html.match(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/);
assert(script && style);
const js = await readFile(resolve(output, script[1]), "utf8");
let css = await readFile(resolve(output, style[1]), "utf8");
for (const font of [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1]))]) {
	const bytes = await readFile(resolve(dirname(resolve(output, style[1])), font));
	css = css.replaceAll(`url(${font})`, `url(data:font/woff2;base64,${bytes.toString("base64")})`);
}
html = html.replace(script[0], () => `<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`).replace(style[0], () => `<style>${css}</style>`);
const portable = join(output, "TPA-reference-preview.html");
await writeFile(portable, html);
const standalone = await chromium.launch({ channel: "msedge", headless: true });
try {
	const page = await standalone.newPage();
	await page.goto(pathToFileURL(portable).href + "?screen=projects");
	await page.getByRole("button", { name: /workbench E:/ }).waitFor();
	checks.push("portable file preview opens directly");
} finally {
	await standalone.close();
}
await writeFile(join(output, "verification.json"), JSON.stringify({ checks, modelCalls: 0, serverChanges: 0, androidTests: 0, kind: "screenshot recreation browser preview" }, null, 2));
const reviewItems = [
	["对话首页", "01-conversations", ""],
	["工作区弹层", "02-workspaces", "?sheet=workspace"],
	["定时任务", "03-schedules", "?screen=tasks"],
	["定时任务编辑", "04-schedule-editor", "?screen=task-new"],
	["项目列表", "05-projects", "?screen=projects"],
	["项目内对话", "06-project-conversations", "?screen=project"],
	["新建对话", "07-new-conversation", "?screen=project&sheet=new-chat"],
	["聊天页面", "08-chat", "?screen=chat"],
];
await writeFile(
	join(output, "TPA-review.html"),
	`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TPA · 截图复现</title><body style="margin:0;padding:32px;background:#f9f9f9;color:#202124;font:16px/1.7 system-ui,sans-serif"><main style="max-width:1100px;margin:auto"><h1 style="font-size:26px;font-weight:500">TPA · 截图复现预览</h1><p>点击画面进入可操作预览。8 个画面均按你提供的截图重建。当前不连接电脑或云端。</p><p>系统状态栏使用原图顶部；页面主体为组件。Windows 的后备字体和部分图标与手机截图仍有差异。</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:24px">${reviewItems.map(([label, shot, query]) => `<section><a href="TPA-reference-preview.html${query.replaceAll("&", "&amp;")}" style="color:inherit;text-decoration:none"><p>${label}</p><img src="${shot}.png" alt="${label}复现截图" style="display:block;width:100%;border:1px solid #e8e8e8;border-radius:12px"></a></section>`).join("")}</div></main></body></html>`,
);
console.log(JSON.stringify({ checks: checks.length, output }, null, 2));
