import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";

// Exercise only the local design build; never connects to TPA or a model.
const output = resolve(process.argv[2] || "out/android-design");
const failures = [];
const checks = [];
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
	try {
		const name = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
		const file = resolve(output, `.${name === "/" ? "/index.html" : name}`);
		const rel = relative(output, file);
		if (isAbsolute(rel) || rel.startsWith("..")) { res.writeHead(403).end(); return; }
		res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
		res.end(await readFile(file));
	} catch { res.writeHead(404).end(); }
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const address = server.address();
assert(address && typeof address !== "string");
let browser;
try {
	browser = await chromium.launch({ channel: "msedge", headless: true });
	const page = await browser.newPage({ viewport: { width: 1260, height: 1060 } });
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
	await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
	await page.screenshot({ path: join(output, "01-overview.png"), fullPage: true, animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
	checks.push("390px: no horizontal overflow");
	await page.screenshot({ path: join(output, "02-home-light.png"), fullPage: true, animations: "disabled" });
	await page.getByRole("button", { name: "继续对话", exact: true }).click();
	await page.getByRole("button", { name: "确认并继续", exact: true }).click();
	await page.getByRole("button", { name: /本周工作周报/ }).waitFor();
	checks.push("confirm -> streamed response -> artifact");
	await page.screenshot({ path: join(output, "03-chat-light.png"), fullPage: true, animations: "disabled" });
	await page.getByRole("button", { name: /本周工作周报/ }).click();
	await page.getByRole("heading", { name: "周报 · 内容预览" }).waitFor();
	await page.screenshot({ path: join(output, "04-artifact.png"), fullPage: true, animations: "disabled" });
	await page.getByRole("button", { name: "回到对话改稿" }).click();
	const input = page.getByRole("textbox");
	assert.match(await input.inputValue(), /周报 v1/);
	checks.push("artifact -> revision in original conversation");
	await input.fill("这条消息应当保留");
	await page.getByRole("navigation").getByRole("button", { name: "设备", exact: true }).click();
	await page.getByRole("button", { name: "模拟断网" }).click();
	await page.getByRole("navigation").getByRole("button", { name: "对话", exact: true }).click();
	assert.equal(await input.inputValue(), "这条消息应当保留");
	assert(await page.getByRole("button", { name: "发送消息", exact: true }).isDisabled());
	checks.push("offline: draft retained, sending disabled");
	await page.screenshot({ path: join(output, "05-offline.png"), fullPage: true, animations: "disabled" });
	await page.getByRole("navigation").getByRole("button", { name: "设备", exact: true }).click();
	await page.getByRole("button", { name: "恢复连接" }).click();
	await page.getByRole("navigation").getByRole("button", { name: "对话", exact: true }).click();
	assert.equal(await input.inputValue(), "这条消息应当保留");
	assert(await page.getByRole("button", { name: "发送消息", exact: true }).isEnabled());
	checks.push("reconnect: no automatic draft submission");
	await page.getByRole("button", { name: "发送消息", exact: true }).click();
	await page.getByRole("button", { name: "停止生成" }).click();
	assert.equal(await input.inputValue(), "");
	checks.push("explicit send and stop");
	await page.getByRole("button", { name: "切换明暗主题" }).click();
	assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
	await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
	await page.screenshot({ path: join(output, "06-chat-dark.png"), fullPage: true, animations: "disabled" });
	checks.push("dark theme toggles");
	await page.getByRole("button", { name: "返回对话列表" }).click();
	await page.getByRole("button", { name: /阅读与想法/ }).click();
	assert.equal(await page.getByTestId("timeline").getByText("把这周的工作整理成一份周报，沿用之前的结构。", { exact: true }).count(), 0);
	checks.push("separate conversation does not show prior conversation content");
	await input.fill("阅读会话草稿");
	await page.getByRole("button", { name: "返回对话列表" }).click();
	await page.getByRole("button", { name: "继续对话", exact: true }).click();
	assert.equal(await input.inputValue(), "");
	assert.equal(await page.getByTestId("timeline").getByText("这条消息应当保留", { exact: true }).count(), 1);
	await page.getByRole("button", { name: "返回对话列表" }).click();
	await page.getByRole("button", { name: /阅读与想法/ }).click();
	assert.equal(await input.inputValue(), "阅读会话草稿");
	checks.push("conversation history and drafts survive switching");
	await page.getByRole("navigation").getByRole("button", { name: "设备", exact: true }).click();
	await page.getByRole("button", { name: "撤销配对演示" }).click();
	await page.getByRole("button", { name: "确认撤销", exact: true }).click();
	assert(await page.getByRole("button", { name: "恢复连接" }).isDisabled());
	await page.getByRole("button", { name: "重新配对演示" }).click();
	assert(await page.getByRole("button", { name: "模拟断网" }).isEnabled());
	checks.push("revocation and pairing simulation");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ width: 320, height: 700 });
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
	checks.push("320px and reduced-motion layout");
	assert.deepEqual(failures, []);
	checks.push("no browser runtime or console errors");
	await writeFile(join(output, "verification.json"), JSON.stringify({ kind: "browser prototype only", checks, modelCalls: 0, realRemoteConnections: 0, androidDeviceTests: 0 }, null, 2));
	console.log(JSON.stringify({ checks: checks.length, passed: checks, output }, null, 2));
} finally {
	await browser?.close();
	await new Promise((done) => server.close(done));
}

// Make a file://-openable review copy with all scripts, styles and fonts embedded.
let html = await readFile(join(output, "index.html"), "utf8");
const script = html.match(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/);
const style = html.match(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/);
assert(script && style);
const js = await readFile(resolve(output, script[1]), "utf8");
let css = await readFile(resolve(output, style[1]), "utf8");
const urls = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1]))];
for (const font of urls) {
	const bytes = await readFile(resolve(dirname(resolve(output, style[1])), font));
	css = css.replaceAll(`url(${font})`, `url(data:font/woff2;base64,${bytes.toString("base64")})`);
}
html = html.replace(script[0], () => `<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`);
html = html.replace(style[0], () => `<style>${css}</style>`);
await writeFile(join(output, "TPA-Android-preview.html"), html);

const standaloneBrowser = await chromium.launch({ channel: "msedge", headless: true });
try {
	const standalone = await standaloneBrowser.newPage();
	const { pathToFileURL } = await import("node:url");
	await standalone.goto(pathToFileURL(join(output, "TPA-Android-preview.html")).href);
	await standalone.getByRole("button", { name: "继续对话", exact: true }).click();
	await standalone.getByRole("button", { name: "确认并继续", exact: true }).waitFor();
	console.log("Standalone file:// preview verified");
} finally { await standaloneBrowser.close(); }
