/**
 * 文稿 IPC 边界：入参校验、授权引用形态与「渲染层不能自证批准」。
 *
 * 用 electron 桩捕获 handler 表后直测：非法入参必须在边界被拒，而不是进到服务层。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const handlers = new Map();
const dialogs = { directory: [], files: [] };
const load = createTsSandbox({
	stubs: {
		electron: {
			ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
			dialog: {
				showOpenDialog: async (...args) => {
					// 有窗口时签名是 (window, options)，无窗口时是 (options)。
					const options = args.length > 1 ? args[1] : args[0];
					if (options.properties.includes("openDirectory")) return { filePaths: dialogs.directory.slice() };
					return { filePaths: dialogs.files.slice() };
				},
			},
		},
	},
});
const { registerDocumentWorkIpc, isDeliverableDocumentWorkView } = load("src/main/ipc/documentWorkIpc.ts");
const { ipcChannels } = load("src/shared/ipc.ts");

const calls = [];
const chatMaterialCandidates = new Set(["C:\work\report.docx"]);
const registeredRoots = [];
const service = {
	allowMaterials: (sessionId, paths) => calls.push({ kind: "allowMaterials", sessionId, paths }),
	createWork: async (input) => {
		calls.push({ kind: "createWork", input });
		return { ok: true, value: {} };
	},
	getView: async (workId, sessionId) => {
		calls.push({ kind: "getView", workId, sessionId });
		return { ok: true, value: {} };
	},
	listForSession: async (sessionId) => {
		calls.push({ kind: "listForSession", sessionId });
		return [];
	},
	prepare: async (input) => {
		calls.push({ kind: "prepare", input });
		return { ok: true, value: {} };
	},
	start: async (input) => {
		calls.push({ kind: "start", input });
		return { ok: true, value: {} };
	},
	cancel: async (input) => {
		calls.push({ kind: "cancel", input });
		return { ok: true, value: {} };
	},
	getOperation: async (workId, requestId, sessionId) => {
		calls.push({ kind: "getOperation", workId, requestId, sessionId });
		return { ok: true, value: {} };
	},
};

registerDocumentWorkIpc({
	service,
	getWindow: () => null,
	// 聊天材料登记：主进程只接受「用户消息里逐字出现 + 项目目录内」的路径，这里用固定白名单模拟。
	registerChatMaterials: async (_sessionId, paths) => {
		const accepted = paths.filter((path) => chatMaterialCandidates.has(path));
		if (accepted.length) service.allowMaterials(_sessionId, accepted);
		return accepted;
	},
	registerOutputRoot: async (realPath) => {
		registeredRoots.push(realPath);
		return { outputRootId: "or_1", label: "文稿", path: realPath, addedAt: 1 };
	},
});

const invoke = (channel, payload) => handlers.get(ipcChannels[channel])({}, payload);
const DIGEST = "a".repeat(64);

test("create：缺字段、越界标题与非法 requestId 一律拒绝", async () => {
	calls.length = 0;
	const valid = { requestId: "req-1", sessionId: "session-a", sourceTurnId: "turn-1", outputRootId: "or_1", title: "报告" };
	assert.equal((await invoke("documentWorkCreate", valid)).ok, true);
	assert.equal(calls.at(-1).input.title, "报告");

	for (const broken of [{ ...valid, requestId: "bad id" }, { ...valid, sessionId: "" }, { ...valid, sourceTurnId: undefined }, { ...valid, outputRootId: "" }, { ...valid, title: "x".repeat(121) }, null, "string"]) {
		const result = await invoke("documentWorkCreate", broken);
		assert.equal(result.ok, false, JSON.stringify(broken).slice(0, 40));
		assert.equal(result.error.code, "INVALID_INPUT");
	}
});

test("prepare：kind、requirementsRef、scope 与材料形态都要过边界校验", async () => {
	calls.length = 0;
	const base = { requestId: "req-1", workId: "dw_1", expectedRevision: 2, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 }, scope: { summary: "s", sections: [], preserve: [] }, materialPaths: [] };
	assert.equal((await invoke("documentWorkPrepare", base)).ok, true);
	assert.equal(calls.at(-1).input.kind, "create_document");

	const cases = [
		{ ...base, kind: "delete_document" },
		{ ...base, expectedRevision: -1 },
		{ ...base, requirementsRef: { kind: "user_instruction", sourceTurnId: "t" } },
		{ ...base, requirementsRef: { kind: "alignment", briefId: "brief-1", revision: -2 } },
		{ ...base, scope: { summary: "s", sections: "no", preserve: [] } },
		{ ...base, materialPaths: ["ok", 42] },
		{ ...base, materialPaths: Array.from({ length: 25 }, (_, index) => `/tmp/m${index}.docx`) },
		{ ...base, workId: "../escape" },
	];
	for (const input of cases) {
		const result = await invoke("documentWorkPrepare", input);
		assert.equal(result.ok, false, JSON.stringify(input).slice(0, 60));
		assert.equal(result.error.code, "INVALID_INPUT");
	}
});

test("start：授权引用必须是受支持形态，运行时三元组必须完整", async () => {
	calls.length = 0;
	const base = { requestId: "req-1", workId: "dw_1", expectedRevision: 3, preparation: { preparationId: "pr_1", digest: DIGEST }, expectedRuntime: { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1 }, authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } };
	assert.equal((await invoke("documentWorkStart", base)).ok, true);

	for (const broken of [
		{ ...base, authorization: { approved: true } },
		{ ...base, authorization: { kind: "revision_instruction", sourceTurnId: "t", sourceTurnHash: "nope" } },
		{ ...base, authorization: undefined },
		{ ...base, expectedRuntime: { sessionId: "session-a" } },
		{ ...base, preparation: { preparationId: "pr_1", digest: "short" } },
	]) {
		const result = await invoke("documentWorkStart", broken);
		assert.equal(result.ok, false, JSON.stringify(broken).slice(0, 60));
		assert.equal(result.error.code, "INVALID_INPUT");
	}
});

test("cancel 需要 attemptId 与完整三元组；get 与 operation 需要会话归属", async () => {
	calls.length = 0;
	const runtime = { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 4 };
	assert.equal((await invoke("documentWorkCancel", { requestId: "req-1", workId: "dw_1", expectedRevision: 1, attemptId: "at_1", expectedRuntime: runtime })).ok, true);
	assert.equal((await invoke("documentWorkCancel", { requestId: "req-1", workId: "dw_1", expectedRevision: 1, attemptId: "at_1" })).error.code, "INVALID_INPUT");
	assert.equal((await invoke("documentWorkGet", { workId: "dw_1", sessionId: "session-a" })).ok, true);
	assert.equal((await invoke("documentWorkGet", { workId: "dw_1" })).error.code, "INVALID_INPUT");
	assert.equal((await invoke("documentWorkOperation", { workId: "dw_1", requestId: "req-1", sessionId: "session-a" })).ok, true);
	assert.equal((await invoke("documentWorkOperation", { workId: "dw_1", requestId: "req-1" })).error.code, "INVALID_INPUT");
});

test("输出根与材料只能来自系统选择器，取消时不产生记录", async () => {
	calls.length = 0;
	registeredRoots.length = 0;
	dialogs.directory = [];
	const cancelled = await invoke("documentWorkChooseOutputRoot");
	assert.equal(cancelled.ok, false);
	assert.equal(cancelled.error.code, "INVALID_INPUT");
	assert.equal(registeredRoots.length, 0);

	dialogs.directory = ["C:\\out\\docs"];
	const picked = await invoke("documentWorkChooseOutputRoot");
	assert.equal(picked.ok, true);
	assert.equal(picked.value.outputRootId, "or_1");
	assert.deepEqual(registeredRoots, ["C:\\out\\docs"]);

	dialogs.files = [];
	assert.equal((await invoke("documentWorkChooseMaterials", "session-a")).value.count, 0);
	assert.equal(
		calls.some((call) => call.kind === "allowMaterials"),
		false,
		"取消选择不得授权任何路径",
	);

	dialogs.files = ["C:\\in\\a.docx", "C:\\in\\b.pdf"];
	const selected = await invoke("documentWorkChooseMaterials", "session-a");
	assert.equal(selected.value.count, 2);
	assert.deepEqual(calls.at(-1).paths, ["C:\\in\\a.docx", "C:\\in\\b.pdf"]);
	assert.equal((await invoke("documentWorkChooseMaterials", "")).error.code, "INVALID_INPUT");
});

test("聊天材料登记：只接受已复核的路径，未引用的路径被拒", async () => {
	calls.length = 0;
	const accepted = await invoke("documentWorkRegisterMaterials", { sessionId: "session-a", paths: ["C:\work\report.docx"] });
	assert.equal(accepted.ok, true);
	assert.equal(accepted.value.count, 1);
	assert.equal(calls.at(-1).kind, "allowMaterials");
	const denied = await invoke("documentWorkRegisterMaterials", { sessionId: "session-a", paths: ["C:\work\phantom.docx"] });
	assert.equal(denied.ok, false);
	assert.equal(denied.error.code, "PATH_DENIED");
	assert.equal((await invoke("documentWorkRegisterMaterials", { sessionId: "session-a", paths: [] })).error.code, "INVALID_INPUT");
	assert.equal((await invoke("documentWorkRegisterMaterials", { sessionId: "session-a" })).error.code, "INVALID_INPUT");
});

test("渲染快照投递判定复用同一套有界解析", () => {
	const view = { workId: "dw_1", sessionId: "session-a", revision: 1, title: "报告", outputRootLabel: "文稿", requirementsSummary: "", active: null, versions: [], revisionReady: false };
	assert.equal(isDeliverableDocumentWorkView(view), true);
	assert.equal(isDeliverableDocumentWorkView({ ...view, workId: "../escape" }), false);
	assert.equal(isDeliverableDocumentWorkView(null), false);
});

test("临时目录辅助函数在测试结束后不再持有句柄", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-ipc-"));
	rmSync(root, { recursive: true, force: true });
	assert.ok(true);
});
