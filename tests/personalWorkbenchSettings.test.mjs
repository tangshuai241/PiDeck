/**
 * 个人工作台折叠偏好的持久化契约：偏好必须真正经过 SettingsStore 落盘与读回，
 * 而不是只加一个 TS 字段。
 *
 * 用临时 userData 目录加载真实 SettingsStore（electron/日志/菜单依赖用替身），验证四件事：
 * 旧 settings.json 缺字段默认展开、update 后新实例能读回、脏值（字符串）回落展开、
 * 非法类型不进内存态。标题栏/菜单等其它设置字段不在本测试范围内。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const KEY = "personalWorkbenchCollapsed";

function createSandbox(userDataDir) {
	const load = createTsSandbox({
		stubs: {
			// 真实 SettingsStore 只用到这三处宿主能力：settings 路径、菜单重建、审计日志。
			electron: {
				app: { getPath: () => userDataDir },
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
			},
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../git/gitExecutable": { setConfiguredGitPath: () => {} },
		},
	});
	return load("src/main/settings/SettingsStore.ts").SettingsStore;
}

async function withUserData(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-personal-workbench-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("缺字段的旧 settings.json 读回默认展开", async () => {
	await withUserData(async (dir) => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
		const store = new (createSandbox(dir))();
		const settings = await store.load();
		assert.equal(settings[KEY], false, "缺字段必须默认展开，入口不能默认隐身");
		assert.equal(settings.theme, "dark", "既有字段不受影响");
	});
});

test("折叠偏好 update 后真正落盘，新实例 load 能读回", async () => {
	await withUserData(async (dir) => {
		const SettingsStore = createSandbox(dir);
		const store = new SettingsStore();
		await store.load();
		await store.update({ [KEY]: true });

		const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
		assert.equal(persisted[KEY], true, "update 必须把折叠态写进 settings.json");

		const reopened = new SettingsStore();
		const settings = await reopened.load();
		assert.equal(settings[KEY], true, "重启后必须读回用户选择");
	});
});

test("脏值与非法入参都不写进内存态：布尔之外一律按展开处理", async () => {
	await withUserData(async (dir) => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ [KEY]: "yes" }), "utf8");
		const SettingsStore = createSandbox(dir);
		const store = new SettingsStore();
		const loaded = await store.load();
		assert.equal(loaded[KEY], false, "字符串脏值回落默认展开");

		// 渲染层以外的来源也可能调用 update；非法类型不得覆盖已保存的偏好
		await store.update({ [KEY]: "true" });
		assert.equal((await store.get())[KEY], false, "非法值保持原设置");
	});
});
