/**
 * P04 阅读会话绑定：通道常量 / main handler / preload 三处同步契约 + 入参边界测试。
 *
 * 守护 AGENTS 硬规则：新增通道三处同步（ipc.ts、main handler、preload），漏一处运行时 undefined。
 * 正则全部空白容忍；同时锁住「绑定读写不新增第二通道」——只允许 4 条 reading:*-binding。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSources } from "./helpers/mainIpcSources.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

const CHANNELS = {
	readingListBindings: "reading:list-bindings",
	readingResolveBinding: "reading:resolve-binding",
	readingBindSession: "reading:bind-session",
	readingUnbindSession: "reading:unbind-session",
};

const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const readingIpcSource = readFileSync("src/main/ipc/readingIpc.ts", "utf8");
const mainSource = mainIpcSources.find((entry) => entry.path === "src/main/index.ts").source;

test("绑定通道常量在 shared/ipc.ts 定义，main handler 与 preload 三处同步", () => {
	for (const [name, value] of Object.entries(CHANNELS)) {
		assert.match(ipcSource, new RegExp(`${name}\\s*:\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `shared/ipc.ts 缺 ${name}`);
		assert.match(readingIpcSource, new RegExp(`ipcChannels\\.${name}`), `main handler 缺 ${name}`);
		assert.match(preloadSource, new RegExp(`ipcChannels\\.${name}`), `preload 白名单缺 ${name}`);
		assert.equal(ipcSource.split(`"${value}"`).length - 1, 1, `通道字面量 ${value} 应只在常量表出现一次`);
	}
	assert.equal(readingIpcSource.includes('"reading:'), false, "handler 不得写通道字符串字面量");
});

test("READING_IPC_CHANNELS 清单包含绑定通道（与注册防漏）", () => {
	const { READING_IPC_CHANNELS } = loadTsCommonJs("src/main/ipc/readingIpc.ts", { stubs: { electron: {} } });
	for (const value of Object.values(CHANNELS)) assert.ok(READING_IPC_CHANNELS.includes(value), `通道清单缺 ${value}`);
	assert.equal(READING_IPC_CHANNELS.length, 22, "P03 的 18 条 + P04 的 4 条绑定通道");
});

test("handler 只做校验与适配：调用 Service 的四个方法并返回其契约结果", () => {
	assert.match(readingIpcSource, /service\.listBindings\(\)/);
	assert.match(readingIpcSource, /service\.resolveBinding\(parsed\.ref\)/);
	assert.match(readingIpcSource, /service\.bindSession\(parsed\.input\)/);
	assert.match(readingIpcSource, /service\.unbindSession\(parsed\.ref\)/);
	// 校验失败必须原样返回 parsed（即结构化 invalidInput），不得继续调用 Service
	assert.match(readingIpcSource, /const parsed = parseReadingBindingRef\(raw\);\s*\n\s*if \(!parsed\.ok\) return parsed;/);
	assert.match(readingIpcSource, /const parsed = parseReadingBindSessionInput\(raw\);\s*\n\s*if \(!parsed\.ok\) return parsed;/);
});

test("preload 暴露四个绑定方法，且使用共享 DTO 类型（无 any）", () => {
	const start = preloadSource.indexOf("\treading: {");
	assert.ok(start > 0, "preload 未定义 reading API");
	const block = preloadSource.slice(start, preloadSource.indexOf("\t},\n};", start));
	for (const method of ["listBindings", "resolveBinding", "bindSession", "unbindSession"]) {
		assert.match(block, new RegExp(`\\b${method}\\s*:`), `preload 缺 reading.${method}`);
	}
	assert.match(block, /ReadingBindingRef/);
	assert.match(block, /ReadingBindSessionInput/);
	assert.equal(/:\s*any\b/.test(block), false, "绑定 API 不得使用 any");
});

test("装配：ReadingService 注入 SessionCatalog 存在性检查（不新开权限渠道）", () => {
	assert.match(mainSource, /sessionExists:\s*\(sessionId\)\s*=>\s*Boolean\(sessionCatalog\.get\(sessionId\)\)/);
	// 绑定链路不得引入新的 pi 进程/agent/桥用途
	assert.doesNotMatch(readingIpcSource, /agentManager|BridgeServer|spawn\(/);
});

test("入参校验：binding ref 与 bind 输入拒绝非法 id / 缺字段", () => {
	const { parseReadingBindingRef, parseReadingBindSessionInput } = loadTsCommonJs("src/main/personal-workbench/reading/readingValidation.ts");
	const ref = parseReadingBindingRef({ workId: "w1", editionId: "e1" });
	assert.equal(ref.ok, true);
	assert.deepEqual(plain(ref.ref), { workId: "w1", editionId: "e1" });

	for (const bad of [null, {}, { workId: "w1" }, { workId: "w1", editionId: "" }, { workId: "w/../1", editionId: "e1" }, { workId: "w1", editionId: "x".repeat(200) }]) {
		const parsed = parseReadingBindingRef(bad);
		assert.equal(parsed.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
		assert.equal(parsed.error.code, "invalidInput");
	}

	const input = parseReadingBindSessionInput({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	assert.equal(input.ok, true);
	assert.deepEqual(plain(input.input), { workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	for (const bad of [
		{ workId: "w1", editionId: "e1", sessionId: "", projectId: "proj-1" },
		{ workId: "w1", editionId: "e1", projectId: "proj-1" },
		{ workId: "w1", editionId: "e1", sessionId: "sess-a" },
		{ workId: "w1", editionId: "e1", sessionId: "sess/a", projectId: "proj-1" },
	]) {
		const parsed = parseReadingBindSessionInput(bad);
		assert.equal(parsed.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
		assert.equal(parsed.error.code, "invalidInput");
	}
});
