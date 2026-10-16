/**
 * 待办 IPC / preload / 通道三处同步契约测试（P02）。
 *
 * 守护 AGENTS 硬规则：通道常量、main handler、preload 白名单漏一处即运行时 undefined；
 * 以及两条边界：渲染共享契约文件不得出现凭据字段；账号只由主进程推导（入参没有账号字段）。
 * 正则空白容忍：源码格式化不得让断言失效。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSources, mainIpcSource } from "./helpers/mainIpcSources.mjs";

const CHANNELS = {
	personalTodoGetStatus: "personal-todo:get-status",
	personalTodoList: "personal-todo:list",
	personalTodoGet: "personal-todo:get",
	personalTodoSubmit: "personal-todo:submit",
	personalTodoRetry: "personal-todo:retry",
	personalTodoResolveConflict: "personal-todo:resolve-conflict",
	personalTodoChanged: "personal-todo:changed",
};

const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const ipcModuleSource = readFileSync("src/main/ipc/personalTodoIpc.ts", "utf8");
const serviceSource = readFileSync("src/main/personal-workbench/PersonalTodoService.ts", "utf8");
const runnerSource = readFileSync("src/main/personal-workbench/personalTodoRunner.ts", "utf8");
const sharedTypesSource = readFileSync("src/shared/types/personalTodo.ts", "utf8");
const mainSource = mainIpcSources.find((entry) => entry.path === "src/main/index.ts").source;

test("通道常量在 shared/ipc.ts 定义，且 main/preload 三处同步", () => {
	for (const [name, value] of Object.entries(CHANNELS)) {
		assert.match(ipcSource, new RegExp(`${name}\\s*:\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `shared/ipc.ts 缺 ${name}`);
	}
	for (const name of ["personalTodoGetStatus", "personalTodoList", "personalTodoGet", "personalTodoSubmit", "personalTodoRetry", "personalTodoResolveConflict"]) {
		assert.match(ipcModuleSource, new RegExp(`ipcChannels\\.${name}`), `main handler 缺 ${name}`);
		assert.match(preloadSource, new RegExp(`ipcChannels\\.${name}`), `preload 白名单缺 ${name}`);
	}
	assert.match(preloadSource, /ipcChannels\.personalTodoChanged/, "preload 缺变化推送订阅");
	assert.match(mainSource, /ipcChannels\.personalTodoChanged/, "main 装配缺变化推送");
});

test("main 薄装配：注册 IPC、退出清理、账号变化联动，不把业务写进 index.ts", () => {
	assert.match(mainSource, /registerPersonalTodoIpc\(\{/, "main/index.ts 未装配待办 IPC");
	assert.match(mainSource, /new PersonalTodoService\(\{/, "main/index.ts 未装配待办服务");
	assert.match(mainSource, /quitCleanup\.register\(\s*"personal-todo"/, "缺少退出清理登记");
	assert.match(mainSource, /personalTodoService\?\.handleIdentityMayHaveChanged\(\)/, "账号变化未联动待办作用域");
	assert.doesNotMatch(mainSource, /personal-todo:get-status/, "通道不得在 main/index.ts 里写字符串字面量");
});

test("启动恢复装配：云端身份装载完成后恢复待办队列，且发送语义仍在 Service", () => {
	assert.match(mainSource, /cloudMemoryService\s*\.\s*initialize\(\)/, "main 缺云端记忆初始化");
	assert.match(mainSource, /personalTodoService\?\.resumePending\(\)/, "初始化完成后未恢复待传队列");
	assert.match(serviceSource, /async\s+resumePending\s*\(/, "Service 缺 resumePending");
	assert.match(serviceSource, /runner\.kick\(\)/, "resumePending 必须复用既有发送器");
});

test("desktopApi.personalTodo 暴露约定方法，且不暴露账号/凭据入参", () => {
	const block = preloadSource.slice(preloadSource.indexOf("\tpersonalTodo: {"), preloadSource.indexOf("\t},\n};\n\nfunction subscribe"));
	assert.ok(block.length > 0, "preload 未定义 personalTodo API");
	for (const method of ["getStatus", "list", "get", "submit", "retry", "resolveConflict", "onChanged"]) {
		assert.match(block, new RegExp(`\\b${method}\\s*:`), `preload 缺 personalTodo.${method}`);
	}
	assert.match(preloadSource, /import type \{[^}]*PersonalTodoChangedEvent[^}]*\} from "\.\.\/shared\/types\/personalTodo"/s, "preload 未复用共享 DTO 类型");
});

test("共享 DTO 不含凭据字段，账号隔离键由 scope 携带", () => {
	assert.doesNotMatch(sharedTypesSource, /(^|[^A-Za-z])(protectedToken|protectedPassword|credential|apiKey|bearerToken)\s*[:?]/i, "共享契约出现凭据字段");
	assert.doesNotMatch(sharedTypesSource, /\bpassword\s*[:?]/i, "共享契约出现密码字段");
	assert.match(sharedTypesSource, /accountKey\s*:/, "账号隔离键缺失");
	assert.match(sharedTypesSource, /cloudInstanceId\s*:/, "云实例隔离键缺失");
	for (const field of ["revision", "linkedTaskIds", "subtodos", "source", "deadline", "urgency", "subtodoProgress"]) {
		assert.match(sharedTypesSource, new RegExp(`\\b${field}\\??\\s*:`), `DTO 缺字段 ${field}`);
	}
});

test("IPC handler 只做校验与转发，凭据不出现在 IPC 模块", () => {
	assert.match(ipcModuleSource, /parsePersonalTodoSubmitInput|parsePersonalTodoQuery/, "handler 未做入参校验");
	assert.doesNotMatch(ipcModuleSource, /token|password|authorization/i, "IPC 模块不得接触凭据");
	assert.match(ipcModuleSource, /PERSONAL_TODO_IPC_CHANNELS/, "缺少给装配/契约测试的通道清单");
	assert.match(runnerSource, /buildMutateBody/, "发送器未经 wire 适配发写请求");
	assert.match(mainIpcSource, /personal-todo/, "main IPC 源码集合应包含待办域");
});
