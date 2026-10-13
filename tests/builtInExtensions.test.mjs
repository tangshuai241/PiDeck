import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

let builtInExtensionsModule = null;

/**
 * 统一走 loadTsCommonJs：builtInExtensions.ts 现已依赖 ./builtInExtensionsManifest
 * （覆盖层清单校验），裸 require 解析不了无扩展名的 .ts 相对导入。
 * 模块级缓存保证多次调用共享同一实例（覆盖层可用性缓存住在模块内）。
 */
function loadBuiltInExtensionsModule() {
	if (!builtInExtensionsModule) {
		builtInExtensionsModule = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
	}
	return builtInExtensionsModule;
}

function sameArgs(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
}

test("appendBuiltInExtensionArgs adds repeated --extension flags", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc"], ["C:\\app\\resources\\extensions\\pi-deck-todo.ts", "C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts"]);
	sameArgs(next, ["--mode", "rpc", "--extension", "C:\\app\\resources\\extensions\\pi-deck-todo.ts", "--extension", "C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts"]);
});

test("appendBuiltInExtensionArgs skips when noExtensions is true", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc", "--no-extensions"], ["/tmp/pi-deck-todo.ts"], { noExtensions: true });
	sameArgs(next, ["--mode", "rpc", "--no-extensions"]);
});

test("listActiveBuiltInExtensionPaths respects removedBuiltIn and missing files", () => {
	const { listActiveBuiltInExtensionPaths, BUILT_IN_EXTENSIONS, HIDDEN_BUILT_IN_EXTENSIONS, isHiddenBuiltInExtension } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-builtin-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	// 只写入 ask + todo，故意不写 plan/nul，验证缺失跳过
	writeFileSync(join(extDir, "pi-deck-ask-question.ts"), "// ask\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo\n", "utf8");

	try {
		const paths = listActiveBuiltInExtensionPaths({ appPath: root, resourcesPath: root, isDev: true }, ["pi-deck-todo.ts"]);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-ask-question.ts"));
		// Alignment is an entry point; its state parser must be packaged but never injected as an extension.
		assert.equal(BUILT_IN_EXTENSIONS.length, 18);
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-alignment-mode.ts"));
		assert.ok(!BUILT_IN_EXTENSIONS.includes("pi-deck-alignment-state.ts"));
		// 文稿入口也是入口点；它的镜像类型文件必须随包分发，但不作为独立扩展注入。
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-document-work.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-document-materials.ts"));
		assert.ok(!BUILT_IN_EXTENSIONS.includes("pi-deck-document-work-types.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-gui-bridge.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-ext-points.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-goal-mode.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-session-title.ts"));
		assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-trash-guard.ts"));
		// 桥的辅助模块**不得**进 -e 注入表（它们不是扩展入口，只是被 import 的模块）；
		// 但它们必须仍在 extensions-manifest.json 里，否则热更新覆盖层会缺依赖。
		assert.ok(!BUILT_IN_EXTENSIONS.includes("pi-deck-gui-bridge-types.ts"));
		assert.ok(!BUILT_IN_EXTENSIONS.includes("pi-deck-gui-bridge-serialize.ts"));
		// 顺序有语义：桥在最前（先包装 ctx.ui），扩展点面板紧随其后（要用桥挂出来的 ctx.gui）
		assert.equal(BUILT_IN_EXTENSIONS[0], "pi-deck-gui-bridge.ts");
		assert.equal(BUILT_IN_EXTENSIONS[1], "pi-deck-ext-points.ts");
		// 已隐藏集合：仍留在 BUILT_IN_EXTENSIONS（白名单校验 + 启动迁移清理历史部署副本要用），
		// 但 listActiveBuiltInExtensionPaths 会无条件跳过，见下一个用例。
		assert.equal(JSON.stringify([...HIDDEN_BUILT_IN_EXTENSIONS]), JSON.stringify(["pi-deck-gui-bridge.ts", "pi-deck-ext-points.ts"]));
		assert.equal(isHiddenBuiltInExtension("pi-deck-gui-bridge.ts"), true);
		assert.equal(isHiddenBuiltInExtension("pi-deck-ext-points.ts"), true);
		assert.equal(isHiddenBuiltInExtension("pi-deck-ask-question.ts"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hidden built-ins (gui-bridge/ext-points) are never injected, not even when opted in", () => {
	const { listActiveBuiltInExtensionPaths, HIDDEN_BUILT_IN_EXTENSIONS, isHiddenBuiltInExtension, DEFAULT_DISABLED_BUILT_IN_EXTENSIONS, isDefaultDisabledBuiltInExtension } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-hidden-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(join(extDir, "pi-deck-gui-bridge.ts"), "// bridge\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-ext-points.ts"), "// panel\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-ask-question.ts"), "// ask\n", "utf8");
	try {
		// 默认：仅 ask 注入，桥/面板不注入
		let paths = listActiveBuiltInExtensionPaths({ appPath: root, resourcesPath: root, isDev: true }, []);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-ask-question.ts"));
		// 回归：历史 enabledBuiltInExtensions 残留（两个都在 opt-in 里）也不能让它们复活
		paths = listActiveBuiltInExtensionPaths({ appPath: root, resourcesPath: root, isDev: true }, [], ["pi-deck-gui-bridge.ts", "pi-deck-ext-points.ts"]);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-ask-question.ts"));
		// 隐藏组与「默认关（可 opt-in）」组当前同名，但语义不同：隐藏组连 opt-in 都不认
		assert.equal(JSON.stringify([...HIDDEN_BUILT_IN_EXTENSIONS]), JSON.stringify(["pi-deck-gui-bridge.ts", "pi-deck-ext-points.ts"]));
		assert.equal(isHiddenBuiltInExtension("pi-deck-ext-points.ts"), true);
		assert.equal(isHiddenBuiltInExtension("pi-deck-ask-question.ts"), false);
		assert.equal(JSON.stringify([...DEFAULT_DISABLED_BUILT_IN_EXTENSIONS]), JSON.stringify(["pi-deck-gui-bridge.ts", "pi-deck-ext-points.ts"]));
		assert.equal(isDefaultDisabledBuiltInExtension("pi-deck-gui-bridge.ts"), true);
		assert.equal(isDefaultDisabledBuiltInExtension("pi-deck-ask-question.ts"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("internal shell proxy adapter is always injected even if user-facing built-ins are removed", () => {
	const { listActiveBuiltInExtensionPaths, INTERNAL_BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-internal-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(join(extDir, "pi-deck-shell-proxy.ts"), "// shell proxy\n", "utf8");
	try {
		const paths = listActiveBuiltInExtensionPaths({ appPath: root, resourcesPath: root, isDev: true }, [...INTERNAL_BUILT_IN_EXTENSIONS]);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pi-deck-shell-proxy.ts"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("built-in extension removal has a registered IPC handler", () => {
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const extensionsTab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(storeIpc, /ipcChannels\.extensionsRemoveBuiltIn[\s\S]*extensionManager\.removeBuiltIn\(source\)/);
	assert.match(storeIpc, /ipcChannels\.extensionsRestoreBuiltIn[\s\S]*extensionManager\.restoreBuiltIn\(source\)/);
	assert.doesNotMatch(extensionsTab, /extension\.enabled === false \? "disabled"/);
	assert.doesNotMatch(extensionsTab, /t\("common\.enabled"\)|t\("common\.disabled"\)/);
});

test("AgentManager no longer deploys built-ins via ensurePiDeckExtension", () => {
	const index = readFileSync("src/main/index.ts", "utf8");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const processSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.doesNotMatch(index, /async function ensurePiDeckExtension/);
	assert.doesNotMatch(storeIpc, /ensurePiDeckExtension/);
	assert.match(index, /migrateLegacyBuiltInExtensions/);
	assert.match(processSource, /appendBuiltInExtensionArgs/);
	assert.match(processSource, /--extension/);
});

test("TPA entries always use bundled files while upstream extensions can use a verified overlay", async () => {
	const { createHash } = await import("node:crypto");
	const { resolveBuiltInExtensionPath, invalidateBuiltInExtensionsOverlayCache } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "tpa-overlay-protection-"));
	const overlayDir = join(root, "overlay");
	mkdirSync(overlayDir);
	const names = ["pi-deck-alignment-mode.ts", "pi-deck-document-work.ts", "pi-deck-document-materials.ts", "pi-deck-ask-question.ts"];
	const files = names.map((name) => {
		const content = "// upstream stale content\n";
		writeFileSync(join(overlayDir, name), content);
		return { name, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
	});
	writeFileSync(join(overlayDir, "extensions-manifest.json"), JSON.stringify({ schemaVersion: 1, version: "9.9.9", files }));
	const roots = { appPath: root, resourcesPath: root, isDev: true, overlayDir };
	try {
		invalidateBuiltInExtensionsOverlayCache();
		for (const name of names.slice(0, 3)) assert.equal(resolveBuiltInExtensionPath(name, roots), join(root, "resources", "extensions", name));
		assert.equal(resolveBuiltInExtensionPath(names[3], roots), join(overlayDir, names[3]));
	} finally {
		invalidateBuiltInExtensionsOverlayCache();
		rmSync(root, { recursive: true, force: true });
	}
});
