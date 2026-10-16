import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 真实 renderer 多入口回归（2026-10-16 部署阻断 R1）。
 *
 * 背景：DSH 移除提交在删 DSH external 时顺手删掉了 renderer 整块
 * `build.rollupOptions`（input index/pet/floater + 共用 manualChunks/cache），
 * electron-vite 退回默认单入口 index.html，打包产物缺 pet.html/floater.html；
 * 主进程仍加载这两个页面（PetWindow / FloatingController），桌宠与悬浮球窗口会 404。
 *
 * 这里直接求值仓库真实的 `electron.vite.config.ts`（stub 掉构建插件与依赖注入），
 * 断言三个入口都存在且源文件在磁盘上——不是对 verify 脚本喂临时夹具，
 * 因此配置被再次删改时本测试会变红。
 */
const REPO_ROOT = resolve(import.meta.dirname, "..");

const esmDefault = (value) => ({ __esModule: true, default: value });

const configModule = loadTsCommonJs("electron.vite.config.ts", {
	stubs: {
		"electron-vite": { defineConfig: (value) => value, externalizeDepsPlugin: () => ({ name: "externalize-deps" }) },
		"@vitejs/plugin-react": esmDefault(() => ({ name: "react" })),
		"@tailwindcss/vite": esmDefault(() => ({ name: "tailwindcss" })),
		vite: { transformWithEsbuild: async () => ({ code: "" }) },
		"./src/main/devIsolation": { readDevGitBranch: () => "test-branch", resolveDevVitePort: () => 5181 },
		"./scripts/hostPluginPreload": { hostPluginPreloadPlugin: () => ({ name: "host-plugin-preload" }) },
	},
});
const config = configModule.default ?? configModule;

test("renderer 入口保留 index/pet/floater 三个真实页面", () => {
	const rollupOptions = config?.renderer?.build?.rollupOptions;
	assert.ok(rollupOptions, "electron.vite.config.ts 必须保留 renderer.build.rollupOptions（多入口配置载体）");
	const input = rollupOptions.input;
	assert.ok(input && typeof input === "object" && !Array.isArray(input), "renderer.build.rollupOptions.input 必须声明多入口对象");
	assert.deepEqual(Object.keys(input).sort(), ["floater", "index", "pet"], "index / pet / floater 三个入口缺一不可");
	for (const [name, file] of Object.entries(input)) {
		assert.equal(typeof file, "string", `${name} 入口必须是路径字符串`);
		const absolute = isAbsolute(file) ? file : resolve(REPO_ROOT, file);
		assert.equal(existsSync(absolute), true, `${name} 入口源文件不存在：${absolute}`);
	}
});

test("renderer 共用构建缓存与 vendor 分块配置仍在", () => {
	const rollupOptions = config?.renderer?.build?.rollupOptions;
	assert.equal(rollupOptions?.cache, true, "增量构建缓存（cache: true）是共用配置，不能随 DSH 一起删除");
	assert.equal(typeof rollupOptions?.output?.manualChunks, "function", "vendor 分块（manualChunks）是共用配置，不能随 DSH 一起删除");
});
