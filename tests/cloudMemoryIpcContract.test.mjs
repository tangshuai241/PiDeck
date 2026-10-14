/**
 * 云端记忆最小 IPC / preload 契约测试。
 *
 * 守护三处同步（AGENTS：通道常量、main handler、preload 白名单漏一处即运行时 undefined），
 * 以及两条安全边界：渲染层契约文件不得出现凭据字段名；本节点只读人格、不暴露发布通道。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSources } from "./helpers/mainIpcSources.mjs";

const CHANNEL_VALUES = {
	cloudMemoryGetStatus: "cloud-memory:get-status",
	cloudMemoryConnect: "cloud-memory:connect",
	cloudMemoryLogout: "cloud-memory:logout",
	cloudMemorySetEnabled: "cloud-memory:set-enabled",
	cloudMemorySetSyncEnabled: "cloud-memory:set-sync-enabled",
	cloudMemoryRefreshPersona: "cloud-memory:refresh-persona",
};

const PUSH_CHANNEL = { cloudMemoryStatusChanged: "cloud-memory:status-changed" };

const PRELOAD_METHODS = ["getStatus", "connect", "logout", "setEnabled", "setSyncEnabled", "refreshPersona", "onStatusChanged"];

test("shared/ipc.ts：六个通道常量与字符串一一对应", () => {
	const source = readFileSync("src/shared/ipc.ts", "utf8");
	for (const [name, value] of Object.entries(CHANNEL_VALUES)) {
		const pattern = new RegExp(`^[\\t ]*${name}:\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",`, "m");
		assert.match(source, pattern, `${name} 必须是 "${value}"`);
	}
});

test("状态推送：通道三处齐（常量/主进程发送/渲染层订阅并退订）", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	for (const [name, value] of Object.entries(PUSH_CHANNEL)) {
		assert.ok(ipc.includes(`${name}: "${value}",`), `${name} 通道常量必须存在`);
	}
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.ok(index.includes("mainWindow.webContents.send(ipcChannels.cloudMemoryStatusChanged)"), "主进程必须在状态变化时推送（不带状态内容）");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.ok(preload.includes("subscribe(ipcChannels.cloudMemoryStatusChanged, callback)"), "preload 必须暴露订阅并返回退订");
	const hook = readFileSync("src/renderer/src/hooks/settings/useCloudMemory.ts", "utf8");
	assert.ok(hook.includes("const unsubscribe = desktopApi.cloudMemory.onStatusChanged"), "hook 必须订阅");
	assert.ok(hook.includes("return unsubscribe;"), "hook 卸载必须退订");
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.ok(preview.includes("onStatusChanged: () => () => {}"), "非桌面端必须有空实现");
});

test("设置页存活刷新：低频轮询兜底（防重叠、卸载清理、不抹动作错误）", () => {
	const hook = readFileSync("src/renderer/src/hooks/settings/useCloudMemory.ts", "utf8");
	assert.ok(hook.includes("setInterval("), "挂载期必须有低频 getStatus 兜底");
	assert.ok(hook.includes("clearInterval(timer)"), "卸载必须清定时器");
	assert.ok(hook.includes("inFlight"), "轮询必须防重叠");
	const pollStart = hook.indexOf("兜底轮询");
	const block = hook.slice(pollStart, hook.indexOf("}, []);", pollStart));
	assert.ok(block.includes("setStatus(result.status)"), "轮询只更新状态");
	assert.ok(!block.includes("setError("), "轮询不得清掉最近一次动作错误");
	// 原生状态采纳也要推送：设置页开着时 pending/回执才不是死在旧值
	const service = readFileSync("src/main/cloudMemory/CloudMemoryService.ts", "utf8");
	assert.ok(service.includes("if (accepted) this.notifyStatusChanged();"), "native ingest 采纳后必须推送");
	// 后端最近错误仍要显示（不被一次成功轮询抹掉）
	const tab = readFileSync("src/renderer/src/components/app/settings/CloudMemorySettingsTab.tsx", "utf8");
	assert.ok(tab.includes("cloudMemory.error ?? status?.lastError"), "错误横幅必须合并后端最近错误");
});

test("main/ipc/cloudMemoryIpc.ts：六个 handler 全部注册，且不存在人格写入通道", () => {
	const entry = mainIpcSources.find((source) => source.path === "src/main/ipc/cloudMemoryIpc.ts");
	assert.ok(entry, "必须存在按域注册的 cloudMemoryIpc.ts");
	for (const name of Object.keys(CHANNEL_VALUES)) {
		assert.match(entry.source, new RegExp(`ipcChannels\\.${name}\\b`), `${name} 必须被 handler 引用`);
	}
	assert.match(entry.source, /ipc\.handle\(/, "handler 必须经 ipcMain.handle 注册");
	// 只读人格：不允许出现 PUT/publish/write 之类的语义（发布走云端用户确认入口）
	assert.doesNotMatch(entry.source, /personaPut|publishPersona|cloudMemorySavePersona/, "不得新增人格发布通道");
});

test("main handler 只做校验与适配：不 import fs/fetch，不触碰凭据字段", () => {
	const entry = mainIpcSources.find((source) => source.path === "src/main/ipc/cloudMemoryIpc.ts");
	assert.ok(entry);
	assert.doesNotMatch(entry.source, /from\s+"node:fs/, "IPC 层不得直接读写文件");
	assert.doesNotMatch(entry.source, /\bfetch\s*\(/, "IPC 层不得直接发网络请求");
	assert.doesNotMatch(entry.source, /protectedPassword|protectedToken|password/, "IPC 层不得触碰凭据字段");
});

test("preload：暴露六个最小方法，且不经 ipcRenderer 裸透传", () => {
	const source = readFileSync("src/preload/index.ts", "utf8");
	const group = source.match(/cloudMemory:\s*\{[\s\S]*?\n\t\},/);
	assert.ok(group, "preload 必须有 cloudMemory 分组");
	for (const method of PRELOAD_METHODS) {
		assert.match(group[0], new RegExp(`\\b${method}:\\s*\\(`), `preload 必须暴露 ${method}`);
	}
	for (const name of Object.keys(CHANNEL_VALUES)) {
		assert.match(group[0], new RegExp(`ipcChannels\\.${name}\\b`), `${name} 必须经通道常量调用`);
	}
	assert.doesNotMatch(group[0], /ipcRenderer\.(send|sendSync|on)\(/, "preload 只做 invoke 转发，不做裸透传");
});

test("main/index.ts：装配 registerCloudMemoryIpc 与 enabledBuiltInExtensions 写入入口", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /registerCloudMemoryIpc\(/, "index.ts 必须装配该域 IPC");
	assert.match(source, /CLOUD_MEMORY_EXTENSION_ENTRY/, "内置扩展名必须用常量，不散落字符串");
	assert.match(source, /setPiExtensionEnabled/, "必须注入设置写入入口");
	// 注入的写入入口只改 enabledBuiltInExtensions 列表
	assert.match(source, /const next = enabled \? \[\.\.\.current, CLOUD_MEMORY_EXTENSION_ENTRY\] : current\.filter/, "开关逻辑只针对该扩展名");
});

test("shared/types/cloudMemory.ts：渲染层契约不含凭据字段名", () => {
	const source = readFileSync("src/shared/types/cloudMemory.ts", "utf8");
	// 只审代码：注释里会解释「哪些字段不该出现」，那是文档不是契约
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
	assert.doesNotMatch(code, /protectedPassword|protectedToken/, "渲染层类型不得出现加密凭据字段");
	assert.doesNotMatch(code, /\btoken\b\s*:/, "渲染层类型不得携带令牌字段");
	assert.match(code, /credentialStored/, "只能以布尔状态表达「是否已保存凭据」");
});

test("renderer：设置 tab 已登记（atoms/layout/SettingsModal）且路径只有 desktopApi 一条", () => {
	const atoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
	assert.match(atoms, /"cloudmemory"/, "SettingsTabId 必须包含 cloudmemory");
	const layout = readFileSync("src/renderer/src/components/app/settings/settingsTabLayout.ts", "utf8");
	assert.match(layout, /id:\s*"cloudmemory"/, "LAYOUT 必须包含该 tab");
	assert.match(layout, /cloudmemory:\s*"settings\.tabs\.cloudmemory"/, "标题 key 必须登记");
	const modal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	assert.match(modal, /CloudMemorySettingsTab/, "SettingsModal 必须挂载该 tab");
	const tab = readFileSync("src/renderer/src/components/app/settings/CloudMemorySettingsTab.tsx", "utf8");
	assert.doesNotMatch(tab, /from\s+"electron"|from\s+"node:/, "渲染层不得直接访问 Electron/Node");
	assert.doesNotMatch(tab, /window\.piDesktop/, "渲染层必须经 desktopApi，不直接摸 preload 全局");
	// 用户可见错误按 code 走词典：不得把主进程 message 当界面文案
	assert.doesNotMatch(tab, /error\.message/, "不得回显主进程 message 作为界面文案");
	for (const code of ["invalidBaseUrl", "secureStorageUnavailable", "unauthorized", "scopeMissing", "principalMismatch", "offline", "personaUnverified", "internalError"]) {
		assert.match(tab, new RegExp(`settings\\.cloudMemory\\.errors\\.${code}`), `${code} 必须有词典键映射`);
	}
	assert.match(tab, /settings\.cloudMemory\.errors\.unknown/, "未知错误码必须有兜底键");
});

test("投影绑定：config 与 auth 带同一份 account/cloudInstanceId，且两者一起写", () => {
	const files = readFileSync("src/main/cloudMemory/cloudMemoryFiles.ts", "utf8");
	assert.match(files, /writeCloudMemoryAuthToken\([^)]*binding: \{ account: string; cloudInstanceId: string \}\)/, "令牌写入必须带账号/实例绑定");
	assert.match(files, /JSON\.stringify\(\{ token, account: binding\.account, cloudInstanceId: binding\.cloudInstanceId \}/, "令牌文件必须含 account/cloudInstanceId 字段");
	assert.match(files, /writeCloudMemoryProjection\s*\(/, "必须有原子投影提交（config+auth 一起写）");
	assert.match(files, /account: snapshot\.account, cloudInstanceId: snapshot\.cloudInstanceId/, "auth 与 config 必须用同一快照的绑定值");
	assert.match(files, /clearCloudMemoryAuthToken\(paths\)/, "config 写失败时必须回滚刚写的令牌");
});

test("后台刷新：service 用 node:timers 显式定时并可在 dispose 清掉", () => {
	const service = readFileSync("src/main/cloudMemory/CloudMemoryService.ts", "utf8");
	assert.match(service, /import \{ clearInterval, setInterval \} from "node:timers"/, "必须显式 import node:timers（vm 测试沙箱没有全局 setInterval）");
	assert.match(service, /setInterval\(\s*\(\s*\)\s*=>\s*\{\s*void this\.refreshPersona\(\)/, "必须有周期刷新任务");
	assert.match(service, /clearInterval\(this\.refreshTimer\)/, "dispose 必须清定时器");
	assert.match(service, /dispose\(\): void \{\s*this\.disposed = true;\s*this\.stopRefreshTimer\(\)/, "dispose 先停定时器再置 disposed");
});

test("原生状态消费：AgentManager 只转发、生命周期注销、不碰扩展文件", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /setCloudMemoryStatusSink\s*\(/, "必须有状态 sink setter");
	assert.match(agentManager, /message\.customType === NATIVE_STATUS_CUSTOM_TYPE/, "只认原生 custom message（display:false）的类型");
	assert.match(agentManager, /Reflect\.get\(message,\s*"details"\)/, "状态载荷只在 details 里读");
	// 生命周期：stop/restart/replace 都要注销（clearAgentState 是唯一清理漏斗）
	assert.match(agentManager, /private clearAgentState\(agentId: string\) \{[\s\S]{0,200}cloudMemoryStatusSink\?\.forget\(agentId\)/, "清理时必须注销该 agent 的状态");
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /agentManager\.setCloudMemoryStatusSink\(\{/, "main 装配必须注入 sink");
	assert.match(index, /ingestNativeStatus\(binding, payload\)/, "装配必须接 ingestNativeStatus");
	assert.match(index, /forget: \(agentId\) => cloudMemoryService\?\.forgetNativeStatus\(agentId\)/, "装配必须接 forgetNativeStatus");
});

test("原生状态：只经原生消息 + 作用域过滤 + 不读队列文件/日志/GUI 桥", () => {
	const service = readFileSync("src/main/cloudMemory/CloudMemoryService.ts", "utf8");
	assert.match(service, /ingestNativeStatus\(binding: RuntimeBinding, payload: unknown\)/, "service 必须提供 ingest");
	assert.match(service, /getNativeSummary\(\): CloudMemoryNativeSummary \| null/, "service 必须提供聚合摘要入口");
	const adapter = readFileSync("src/main/cloudMemory/cloudMemoryNativeStatus.ts", "utf8");
	assert.match(adapter, /getScope: \(\) =>/, "作用域由适配器向 Service 取（换账号即换 scope）");
	assert.doesNotMatch(adapter, /from "electron"|node:fs|gui-bridge|BridgeServer/, "状态适配不得依赖 GUI 桥或文件系统");
	for (const source of [service, adapter]) {
		assert.doesNotMatch(source, /readFile.*sync-outbox|outbox.*readFile|cloud-memory\.log/, "不得读队列文件/扩展日志当状态来源");
	}
	const projection = readFileSync("src/main/cloudMemory/cloudMemoryStatusProjection.ts", "utf8");
	assert.doesNotMatch(projection, /from "electron"|node:fs|gui-bridge|BridgeServer/, "投影模块不得依赖 GUI 桥或文件系统");
	assert.match(projection, /runtimeGeneration/, "绑定必须包含 runtimeGeneration");
});

test("设置页：移除误导的模式切换、未知不显示 0、不暴露内部 reason 码", () => {
	const tab = readFileSync("src/renderer/src/components/app/settings/CloudMemorySettingsTab.tsx", "utf8");
	assert.doesNotMatch(tab, /recallMode|syncMode === "project"/, "个人/项目召回模式切换必须移除");
	assert.doesNotMatch(tab, /settings\.cloudMemory\.sync\.placeholder/, "占位文案已由真实状态字段替换");
	assert.match(tab, /sync\.unknown/, "未知状态必须有独立文案");
	assert.match(tab, /native === null \|\| native\.pendingCount === null/, "未知待传计数不得渲染成 0");
	assert.match(tab, /scope\.archive/, "必须说明两类会话都会归档");
	assert.match(tab, /scope\.wsl/, "必须说明 WSL 首版不支持");
	assert.doesNotMatch(tab, /status\?\.native\?\.statuses|native\.statuses/, "不得把内部 status 码直接渲染到界面");
	assert.doesNotMatch(tab, /native\?\.reason|\.reason\b/, "不得暴露内部 reason 码");
});

test("同步相位：每个固定枚举值都有界面词典键（不显示原始码）", () => {
	const projection = readFileSync("src/main/cloudMemory/cloudMemoryStatusProjection.ts", "utf8");
	const declared = projection.match(/NATIVE_SYNC_STATES\s*=\s*\[([^\]]+)\]/);
	assert.ok(declared, "投影必须声明相位枚举");
	const states = [...declared[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
	const tab = readFileSync("src/renderer/src/components/app/settings/CloudMemorySettingsTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const state of states) {
		// 枚举里每个相位都必须在映射表里有条目（键名可以是 camelCase，但相位名必须出现）
		assert.ok(tab.includes(`${state}:`), `${state} 必须映射到 i18n 键`);
	}
	const mapped = [...tab.matchAll(/settings\.cloudMemory\.sync\.state\.([A-Za-z]+)"/g)].map((match) => match[1]);
	assert.ok(mapped.length >= states.length, "映射条目不得少于固定枚举");
	for (const suffix of [...mapped, "unknownState"]) {
		assert.ok(zh.includes(`"settings.cloudMemory.sync.state.${suffix}"`), `${suffix} 缺中文文案`);
		assert.ok(en.includes(`"settings.cloudMemory.sync.state.${suffix}"`), `${suffix} 缺英文文案`);
	}
	assert.match(tab, /syncStates/, "相位集合必须参与展示");
});
