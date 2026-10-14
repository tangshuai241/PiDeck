/**
 * 阅读 IPC / preload / 通道三处同步契约测试（P03）。
 *
 * 守护 AGENTS 硬规则（通道常量、main handler、preload 白名单漏一处即运行时 undefined），
 * 以及三条边界：凭据只在主进程（IPC/共享类型不含密码字段名）、渲染层不直连服务、
 * 主进程薄装配（服务 + IPC + 退出清理）。
 * 正则空白容忍：源码格式化不得让断言失效。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSources } from "./helpers/mainIpcSources.mjs";

const CHANNELS = {
	readingGetStatus: "reading:get-status",
	readingConnect: "reading:connect",
	readingDisconnect: "reading:disconnect",
	readingListLibrary: "reading:list-library",
	readingGetEdition: "reading:get-edition",
	readingGetChapter: "reading:get-chapter",
	readingResolveQuote: "reading:resolve-quote",
	readingListNotes: "reading:list-notes",
	readingReadNote: "reading:read-note",
	readingWriteNote: "reading:write-note",
	readingListNoteDrafts: "reading:list-note-drafts",
	readingDiscardNoteDraft: "reading:discard-note-draft",
	readingResumeNoteDraft: "reading:resume-note-draft",
	readingGetPosition: "reading:get-position",
	readingSavePosition: "reading:save-position",
	readingHistorySources: "reading:history-sources",
	readingListHistory: "reading:list-history",
	readingReadHistorySession: "reading:read-history-session",
};

const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const readingIpcSource = readFileSync("src/main/ipc/readingIpc.ts", "utf8");
const sharedTypesSource = readFileSync("src/shared/types/reading.ts", "utf8");
const clientSource = readFileSync("src/main/personal-workbench/reading/readingHttpClient.ts", "utf8");
const mainSource = mainIpcSources.find((entry) => entry.path === "src/main/index.ts").source;

test("通道常量在 shared/ipc.ts 定义，且 main handler 与 preload 三处同步", () => {
	for (const [name, value] of Object.entries(CHANNELS)) {
		assert.match(ipcSource, new RegExp(`${name}\\s*:\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `shared/ipc.ts 缺 ${name}`);
		assert.match(readingIpcSource, new RegExp(`ipcChannels\\.${name}`), `main handler 缺 ${name}`);
		assert.match(preloadSource, new RegExp(`ipcChannels\\.${name}`), `preload 白名单缺 ${name}`);
	}
	assert.doesNotMatch(readingIpcSource, /"reading:/, "handler 不得写通道字符串字面量");
	for (const value of Object.values(CHANNELS)) {
		assert.equal(ipcSource.split(`"${value}"`).length - 1, 1, `通道字面量 ${value} 应只在常量表出现一次`);
	}
});

test("desktopApi.reading 暴露约定方法，且只复用共享 DTO 类型", () => {
	const start = preloadSource.indexOf("\treading: {");
	assert.ok(start > 0, "preload 未定义 reading API");
	const block = preloadSource.slice(start, preloadSource.indexOf("\t},\n};", start));
	for (const method of ["getStatus", "connect", "disconnect", "listLibrary", "getEdition", "getChapter", "resolveQuote", "listNotes", "readNote", "writeNote", "listNoteDrafts", "discardNoteDraft", "resumeNoteDraft", "getPosition", "savePosition", "historySources", "listHistory", "readHistorySession"]) {
		assert.match(block, new RegExp(`\\b${method}\\s*:`), `preload 缺 reading.${method}`);
	}
	assert.match(preloadSource, /import type \{[^}]*ReadingStatusResult[^}]*\} from "\.\.\/shared\/types\/reading"/s, "preload 未复用共享阅读类型");
	assert.doesNotMatch(block, /fetch\(|http:\/\//, "preload 不做网络请求，也不写死地址");
});

test("凭据边界：IPC 模块与共享契约输出里没有密码/cookie 字段", () => {
	assert.doesNotMatch(readingIpcSource, /password|cookie|authorization/i, "IPC 模块不得接触凭据");
	assert.doesNotMatch(sharedTypesSource, /protectedPassword|credentialStored:\s*string|cookie\s*:/i, "共享契约不得回传凭据/cookie");
	assert.match(sharedTypesSource, /password: string/, "连接入参允许一次密码（唯一出口是主进程）");
	assert.doesNotMatch(clientSource, /console\.log|appLogger/, "客户端不打印任何内容（含凭据）");
	assert.match(clientSource, /cookie/, "客户端内部持有 cookie 用于请求头");
	// 草稿引用只含 work/edition/noteId（不得携带路径或正文外的敏感字段）
	assert.doesNotMatch(readingIpcSource, /filePath|password/, "IPC 模块不接收文件路径或密码");
});

test("主进程薄装配：服务 + IPC + 退出清理；普通聊天不等阅读服务", () => {
	assert.match(mainSource, /registerReadingIpc\(\{/, "main/index.ts 未装配阅读 IPC");
	assert.match(mainSource, /new ReadingService\(\{/, "main/index.ts 未装配阅读服务");
	assert.match(mainSource, /quitCleanup\.register\(\s*"reading"/, "缺少退出清理登记");
	assert.doesNotMatch(mainSource, /reading:get-status/, "通道不得在 main/index.ts 里写字符串字面量");
	assert.doesNotMatch(mainSource, /getStatus\(\)\.then|probe:?\s*\(\)\s*=>\s*readingService/, "启动不主动探测阅读服务");
});
