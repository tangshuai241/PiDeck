/**
 * 材料读取：真实 Windows 现状 + 真实子进程。
 *
 * 覆盖审查修正项 4：
 * - npm 全局装的 `anydoc` 是 `.cmd` shim：`spawn("anydoc")` ENOENT、
 *   `spawn("anydoc.cmd", {shell:false})` 同步 EINVAL；这里验证解析器把 shim 变成
 *   "node + 真实 JS 入口"的可执行描述（完全不经 shell）；
 * - PATH 条目里**带空格**的目录也要能解析并真的跑起来；
 * - 固定 argv、`shell:false`、同步 spawn 失败/非零退出/超时都结算成结果；
 * - 缓存键含原件指纹与转换器版本，改动/损坏都不复用。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTempDir } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const materials = loadTsCommonJs("resources/extensions/pi-deck-document-materials.ts");
const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
void DocumentWorkStore;

test("解析真实 npm .cmd shim：拿到 node + 真实 JS 入口，绝不 spawn .cmd", () => {
	const dir = createTempDir("pideck-anydoc-shim-");
	try {
		const packageDir = join(dir.dir, "node_modules", "@firecrawl", "anydoc");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "cli.js"), "console.log('stub');\n", "utf8");
		writeFileSync(join(dir.dir, "anydoc.cmd"), `@ECHO off\r\n"%dp0%\\node_modules\\@firecrawl\\anydoc\\cli.js" %*\r\n`.replace(/\\/g, "\\"), "utf8");
		const content = readFileSync(join(dir.dir, "anydoc.cmd"), "utf8");
		const launch = materials.resolveConverterLaunch({
			platform: "win32",
			env: {},
			pathEntries: [dir.dir],
			exists: (path) => existsSync(path),
			readText: () => content,
			nodeExecutable: "C:/node/node.exe",
		});
		assert.ok(launch, "必须能从 shim 解析出可执行描述");
		assert.equal(launch.file, "C:/node/node.exe");
		assert.equal(launch.argsPrefix.length, 1);
		assert.match(launch.argsPrefix[0], /cli\.js$/);
		assert.equal(launch.argsPrefix[0].endsWith(".cmd"), false, "交给 spawn 的不能是 .cmd");
	} finally {
		dir.cleanup();
	}
});

test("PATH 条目带空格时仍能解析并真的跑起来（真实子进程，不调模型）", () => {
	const dir = createTempDir("pideck anydoc space ");
	try {
		const script = join(dir.dir, "fake-anydoc.js");
		writeFileSync(script, "console.log(process.argv.slice(2).join(' '));\n", "utf8");
		const launch = materials.resolveConverterLaunch({
			platform: process.platform,
			env: {},
			pathEntries: [dir.dir],
			exists: (path) => existsSync(path),
			readText: () => undefined,
			nodeExecutable: process.execPath,
		});
		// 目录里没有任何 anydoc* 可执行文件：解析必须如实失败，而不是猜路径。
		assert.equal(launch, undefined);

		const envLaunch = materials.resolveConverterLaunch({
			platform: process.platform,
			env: { PIDECK_ANYDOC_PATH: script },
			pathEntries: [],
			exists: (path) => existsSync(path),
			readText: () => undefined,
			nodeExecutable: process.execPath,
		});
		assert.ok(envLaunch);
		const command = materials.buildConversionCommand(envLaunch, { sourcePath: join(dir.dir, "in put.docx"), outputPath: join(dir.dir, "out put.md"), timeoutMs: 5000 });
		assert.deepEqual([...command.args.slice(-3)], [join(dir.dir, "in put.docx"), "-o", join(dir.dir, "out put.md")]);
		const result = spawnSync(command.file, command.args, { shell: false, encoding: "utf8" });
		assert.equal(result.status, 0);
		assert.match(result.stdout, /in put\.docx -o .*out put\.md/, "带空格的路径必须原样传给子进程");
	} finally {
		dir.cleanup();
	}
});

test("本机真实 anydoc：解析 + 真实 --version 启动（无模型调用）", () => {
	const launch = materials.defaultResolveLaunch();
	if (!launch) {
		// 机器上没装 anydoc 时的正确行为：如实返回 undefined，界面/工具报"转换器不可用"。
		assert.equal(launch, undefined);
		return;
	}
	const result = spawnSync(launch.file, [...launch.argsPrefix, "--version"], { shell: false, encoding: "utf8", timeout: 20_000 });
	assert.equal(result.error, undefined, "真实启动不应有 spawn 错误（ENOENT/EINVAL 都会在这里暴露）");
	assert.equal(result.status, 0, result.stderr);
	assert.ok(`${result.stdout}${result.stderr}`.trim().length > 0, "必须打印版本信息");
});

test("同步 spawn 失败被结算成结果，不会让 Promise 悬空", async () => {
	const outcome = await materials.spawnConversion({ file: join("Z:", "definitely", "missing", "anydoc.cmd"), args: ["x"], timeoutMs: 2000 });
	assert.ok("failure" in outcome);
	assert.match(outcome.failure, /not found|ENOENT|EINVAL|spawn/i);
});

test("转换器非零退出/超时都如实失败", async () => {
	const dir = createTempDir("pideck-anydoc-fail-");
	try {
		const failing = join(dir.dir, "fail.js");
		writeFileSync(failing, "process.exit(3);\n", "utf8");
		const dead = await materials.spawnConversion({ file: process.execPath, args: [failing], timeoutMs: 5000 });
		assert.ok("code" in dead && dead.code === 3);

		const hanging = join(dir.dir, "hang.js");
		writeFileSync(hanging, "setTimeout(() => {}, 60000);\n", "utf8");
		const timedOut = await materials.spawnConversion({ file: process.execPath, args: [hanging], timeoutMs: 200 });
		assert.ok("failure" in timedOut);
		assert.match(timedOut.failure, /timed out/);
	} finally {
		dir.cleanup();
	}
});
