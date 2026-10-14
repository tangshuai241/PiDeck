/**
 * 云端记忆 spawn 环境与 standby 指纹契约测试。
 *
 * 为什么是契约测试：spawn env 只能在真实 pi 子进程上端到端验证，而本节点不做联网/付费链路；
 * 这里用「指纹行为 + 源码契约」两层守护最容易漏的地方——
 * 注入变量写漏、WSL 路径不转换、provider 没接进 AgentManager、指纹没覆盖新输入。
 *
 * 正则一律空白容忍（`\\s*` + `^[\\t ]*` 锚点），避免格式改动把断言打红（AGENTS 硬性要求）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeStandbyFingerprint } = loadTsCommonJs("src/main/pi/standbyFingerprint.ts");

function fingerprintInput(overrides = {}) {
	return {
		projectPath: "C:/work/project",
		trustMarker: "prompt-free",
		piCliPath: "C:/pi/pi.cmd",
		offline: false,
		noExtensions: false,
		noSkills: false,
		piProxyEnabled: false,
		piProxyUrl: "",
		piProxyBypass: "",
		disabledExtensions: [],
		disabledSkills: [],
		disabledPrompts: [],
		extensionRoots: ["C:/app/resources/extensions/pi-deck-cloud-memory.ts"],
		bridgeAvailable: true,
		bridgeUrl: "43123",
		autoSessionTitle: true,
		...overrides,
	};
}

test("指纹：云端记忆身份（账号/实例/启用/范围）与投影路径任一变化都必须改变指纹", () => {
	const base = computeStandbyFingerprint(fingerprintInput({ cloudMemoryIdentity: "v1|enabled:1|account:alice|instance:aaa|mode:personal|sync:1" }));
	const sameAgain = computeStandbyFingerprint(fingerprintInput({ cloudMemoryIdentity: "v1|enabled:1|account:alice|instance:aaa|mode:personal|sync:1" }));
	assert.equal(base, sameAgain);
	// 路径恒定但账号/实例变化：必须换指纹，旧 runtime 不能悄悄换账号
	assert.notEqual(base, computeStandbyFingerprint(fingerprintInput({ cloudMemoryIdentity: "v1|enabled:1|account:bob|instance:aaa|mode:personal|sync:1" })));
	assert.notEqual(base, computeStandbyFingerprint(fingerprintInput({ cloudMemoryIdentity: "v1|enabled:1|account:alice|instance:bbb|mode:personal|sync:1" })));
	assert.notEqual(base, computeStandbyFingerprint(fingerprintInput({ cloudMemoryIdentity: "v1|enabled:0|account:alice|instance:aaa|mode:personal|sync:1" })));
	// 未装配（空串）与已装配必须不同：否则关掉服务后池化进程还带旧投影
	assert.notEqual(base, computeStandbyFingerprint(fingerprintInput()));
});

test("PiProcess：非 WSL 显式注入，WSL 不注入（首版不支持，不假称可用）", () => {
	const source = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(source, /cloudMemoryPaths\?:/, "PiProcess options 必须声明 cloudMemoryPaths");
	// 注入必须同时受「有配置」与「非 wsl://」两个条件约束；不得对 Windows 路径做 /mnt 转换
	const block = source.split("env.PIDECK_CLOUD_MEMORY_CONFIG")[0].split("// 云端记忆").pop() ?? "";
	assert.match(block, /!command\.startsWith\("wsl:\/\/"\)/, "WSL 分支必须跳过注入");
	assert.match(source, /env\.PIDECK_CLOUD_MEMORY_CONFIG\s*=/, "必须注入 PIDECK_CLOUD_MEMORY_CONFIG");
	assert.match(source, /env\.PIDECK_CLOUD_MEMORY_DATA_DIR\s*=/, "必须注入 PIDECK_CLOUD_MEMORY_DATA_DIR");
	for (const variable of ["PIDECK_CLOUD_MEMORY_CONFIG", "PIDECK_CLOUD_MEMORY_DATA_DIR"]) {
		const line = source.split("\n").find((candidate) => candidate.includes(`env.${variable} =`));
		assert.ok(line, `${variable} 赋值行必须存在`);
		assert.doesNotMatch(line, /toWslLinuxPath\(/, `${variable} 不得臆造 WSL 路径（JSON 内部仍是 Windows 路径）`);
	}
});

test("AgentManager：提供 spawn 选项并接入身份指纹", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /setCloudMemoryPathsProvider\s*\(/, "必须有 setter 供 main/index 注入 provider");
	assert.match(source, /const cloudMemoryProfile = this\.cloudMemoryPathsProvider\?\.\(\)/, "createPiProcess 只取一次 profile");
	assert.match(source, /cloudMemoryPaths:\s*cloudMemoryProfile\s*\?\s*\{[^}]*configPath:\s*cloudMemoryProfile\.configPath/, "createPiProcess 必须带上投影路径");
	assert.match(source, /cloudMemoryIdentity:\s*this\.cloudMemoryPathsProvider\?\.\(\)\?\.identity\s*\?\?\s*""/, "指纹必须覆盖账号/实例身份");
});

test("main/index.ts：装配服务、注册 IPC、注入 provider、登记退出清理", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /new CloudMemoryService\s*\(/, "必须构造 CloudMemoryService");
	assert.match(source, /registerCloudMemoryIpc\s*\(\s*\{\s*ipc:\s*ipcMain/, "必须在 registerIpc() 内注册 handler");
	assert.match(source, /agentManager\.setCloudMemoryPathsProvider\(/, "必须把 spawn 档案提供者接到 AgentManager");
	assert.match(source, /getSpawnProfile\(\)/, "必须用带身份指纹的 getSpawnProfile");
	assert.match(source, /quitCleanup\.register\(\s*"cloud-memory"/, "必须登记退出清理（丢弃在飞结果）");
	// 只写 enabledBuiltInExtensions，不做别的设置改动
	assert.match(source, /enabledBuiltInExtensions:\s*next/, "开关只能写 enabledBuiltInExtensions");
});
