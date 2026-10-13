/**
 * 对齐期间的文稿元数据绑定守卫（真实验收缺陷回归）。
 *
 * 现象（live-acceptance/word-v1-true-bound-confirm.json、word-v1-bound-record-api.json）：
 * 用户在卡片上选好保存目录后，绑定失败并弹出「请求参数不合法」，操作 dw_3e297d1cdc7b4481b7b78d3c
 * 的 e5f2329d 被记成 RUNTIME_CHANGED（「会话运行进程已变化」）——但同一会话的运行三元组
 * （agent29e18777 / gen1）根本没变，日志里 bind 与 release 的派发结果都是 accepted:false。
 *
 * 原因：AgentManager.sendPrompt 的对齐输入守卫只放行「非斜杠文本」与 `/align ...`；而文稿链路
 * 必须在 `/align approve` 之前先发 `/tpa-work bind <payload>`（绑定元数据），于是宿主自己的
 * 命令在真实链路上被策略拦下，调用方又把任何 accepted:false 一律归成 RUNTIME_CHANGED。
 *
 * 本测试只假两样东西：pi 传输层（client.request 与 RPC 请求记录）与最小会话目录；
 * AgentManager 的守卫、SessionRuntimeCoordinator 的绑定/派发、AlignmentProjection 的
 * 历史水合都是生产模块（对齐快照经真实会话 JSONL 读盘恢复，不塞私有字段）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { AgentManager } = loadTsCommonJs(`${ROOT}/src/main/pi/AgentManager.ts`);
const { mainProcessT } = loadTsCommonJs(`${ROOT}/src/shared/i18n/mainProcessCopy.ts`);
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);
const alignmentPolicy = loadTsCommonJs(`${ROOT}/src/shared/alignment.ts`);
const { SessionRuntimeCoordinator } = createTsSandbox({
	stubs: {
		"../../shared/sessionIdentity": loadTsCommonJs(`${ROOT}/src/shared/sessionIdentity.ts`),
		"../../shared/types": {},
	},
})(`${ROOT}/src/main/sessions/SessionRuntimeCoordinator.ts`);

const SESSION_ID = "4aad9111-401e-46fc-93e8-c3e4d98615a2";
const AGENT_ID = "agent-29e18777";
const NATIVE_SESSION = "pi-native-9c31";
const BRIEF_ID = "brief-live";
const REVISION = 3;
const translate = (key) => mainProcessT("zh-CN", key);

/** 会话 JSONL 里的 ready 对齐快照：字段形态与扩展发布的一致。 */
const READY_ALIGNMENT = {
	schemaVersion: 1,
	briefId: BRIEF_ID,
	revision: REVISION,
	phase: "ready",
	briefRevision: REVISION,
	brief: { goal: "桥梁监测安排 正式 Word 报告（DOCX）交付：全文只含四段，两个标题用 Heading 1，正文宋体 12 磅。", scope: [], materials: [], deliverable: "Word 文档（DOCX）", preserve: [], acceptance: ["四个段落逐字一致"], questions: [] },
};

/** 真实验收那条绑定载荷的同等形态（主进程构造，扩展校验）。 */
function bindingPayload(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: "dw_3e297d1cdc7b4481b7b78d3c",
		attemptId: "at_e5f2329d0000000000000000",
		preparationId: "pr_e5f2329d0000000000000000",
		digest: "a".repeat(64),
		sessionId: SESSION_ID,
		nativeSessionId: NATIVE_SESSION,
		kind: "create_document",
		workDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c",
		stagingDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\staging\\at_e5f2329d0000000000000000",
		materialCacheDirectory: "C:\\userData\\material-cache",
		materials: [],
		scope: { summary: "四段结构", sections: [], preserve: [] },
		requirements: { summary: "四段结构，两个 Heading 1" },
		...overrides,
	};
}

function bindCommand(overrides = {}) {
	return `/tpa-work bind ${shared.encodeBindingPayload(bindingPayload(overrides))}`;
}

/**
 * 只假 pi 传输层：任何 RPC 都走这里，测试据此断言「命令到达了 pi 几次」。
 * 扩展可用性走真实的 get_commands 预检链路（与生产同一个 promptMatchesRegisteredExtensionCommand）。
 */
function createPiTransport(options = {}) {
	const requests = [];
	const extensionCommands = options.extensionCommands ?? [
		{ name: "align", source: "extension" },
		{ name: "tpa-work", source: "extension" },
	];
	const transport = {
		requests,
		prompts: () => requests.filter((request) => request.type === "prompt").map((request) => request.message),
		client: {
			request: async (payload) => {
				requests.push(payload);
				if (options.onRequest) await options.onRequest(payload, options.context ?? {});
				switch (payload.type) {
					case "get_commands":
						return { success: true, data: { commands: extensionCommands.map((command) => ({ ...command })) } };
					case "get_state":
						return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: NATIVE_SESSION } };
					case "get_session_stats":
						return { success: true, data: {} };
					case "prompt":
						return { success: true, data: { disposition: "handled" } };
					default:
						return { success: true, data: {} };
				}
			},
		},
	};
	return transport;
}

/**
 * 真实宿主链路：AgentMeria 守卫 + 协调器绑定/派发 + 会话文件里的对齐快照。
 * `hydration: false` 用于「没有对齐在途」的对照场景。
 */
async function createHarness(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-binding-guard-"));
	const sessionPath = join(root, "session.jsonl");
	// 会话 JSONL 必须是真实的父子链（session → 用户轮 → 对齐快照）：索引沿 parentId 找活动分支，
	// 平铺或缺少 id 的行不会进分支，水合就会静默拿不到快照。
	const sessionEntries = [
		{ type: "session", id: "root", timestamp: "2026-10-12T10:00:00.000Z", cwd: "C:/project", version: 3 },
		{ type: "message", id: "m1", parentId: "root", timestamp: "2026-10-12T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "请制作《桥梁监测安排》正式 Word 报告（DOCX）" }] } },
		{ type: "custom_message", id: "c1", parentId: "m1", customType: "pi-deck-alignment-state", content: "", display: false, details: { alignment: options.alignment ?? READY_ALIGNMENT } },
	];
	writeFileSync(sessionPath, `${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	// onRequest 的对照场景要能改 tab（模拟预检期间 runtime 被替换），因此先给一个可变上下文。
	const context = {};
	const transport = createPiTransport({ ...options, context });
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 20_000 }) },
		{},
		undefined,
		undefined,
		undefined,
		translate,
	);
	const tab = { id: AGENT_ID, projectId: "project-1", cwd: "C:/project", title: "Session", status: "idle", deckSessionId: SESSION_ID, sessionId: NATIVE_SESSION, runtimeGeneration: 0, sessionPath, sessionEnvironment: "native", sessionSource: "pi", createdAt: 1 };
	const runtime = { tab, process: { isRunning: () => true, getDiagnostics: () => null, client: transport.client } };
	manager.agents.set(AGENT_ID, runtime);
	const entry = { id: SESSION_ID, projectId: "project-1", title: "Session", source: "pi", environment: "native", backend: "pi", status: "active", filePath: sessionPath, createdAt: 1, updatedAt: 1 };
	const catalog = {
		get: (sessionId) => (sessionId === SESSION_ID ? { ...entry } : undefined),
		getRecord: (sessionId) => (sessionId === SESSION_ID ? { ...entry, preview: "", messageCount: 1 } : undefined),
		update: async () => ({ ...entry }),
		attachRuntime: async () => ({ ...entry }),
	};
	const gateway = {
		backend: "pi",
		capabilities: new Set(),
		list: () => manager.list(),
		sendPrompt: (input) => manager.sendPrompt(input),
		getMessages: (agentId) => manager.getMessages(agentId),
		create: async () => {
			throw new Error("本测试不创建新运行时");
		},
		restart: async () => {
			throw new Error("本测试不重启运行时");
		},
		stop: async () => undefined,
		rename: async () => tab,
		abort: async () => undefined,
		compact: async () => ({}),
		getRuntimeState: async () => ({ value: {} }),
		// 激活路径需要的最小无副作用能力（真实实现里这些是 pi RPC；本测试只关心守卫是否放行）。
		publishRuntimeState: async () => undefined,
		setModel: async () => undefined,
		setThinking: async () => undefined,
		setPermission: async () => undefined,
		getAvailableModels: async () => [],
		getCommands: async () => [],
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, gateway, (input) => manager.sendPrompt(input), undefined);
	const generation = coordinator.bindExistingAgent(SESSION_ID, AGENT_ID);
	if (options.hydration !== false) {
		// 生产路径：读会话文件恢复对齐快照（应用重启后渲染层看到 ready 的同一链路）。
		await manager.getRuntimeState(AGENT_ID);
	}
	Object.assign(context, { tab, manager, transport });
	return {
		manager,
		tab,
		transport,
		context,
		coordinator,
		root,
		target: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: generation },
		send: (message, requestId = `req-${Math.random().toString(16).slice(2)}`) => coordinator.send({ sessionId: SESSION_ID, requestId, message, expectedRuntime: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: generation } }),
		// AgentRuntimeState 的 alignment 在顶层（不是 state 子对象）。
		alignmentPhase: async () => (await manager.getRuntimeState(AGENT_ID))?.alignment?.phase,
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("ready 对齐下精确的 bind 载荷到达 pi 一次，且不恢复工具、不触发批准", async () => {
	const harness = await createHarness();
	try {
		assert.equal(await harness.alignmentPhase(), "ready", "夹具必须先把 ready 快照水合进投影");
		const message = bindCommand();
		const result = await harness.send(message, "dwbind_e5f2329d");
		assert.equal(result.accepted, true, JSON.stringify(result));
		assert.equal(result.delivery === "unknown", false);
		assert.deepEqual(harness.transport.prompts(), [message], "精确的绑定命令必须原样到达 pi 一次");
		// 只允许「可用性预检 + 绑定命令」这两类请求：没有工具恢复、没有本地写入、没有模型回合。
		const kinds = [...new Set(harness.transport.requests.map((request) => request.type))];
		assert.deepEqual(kinds.sort(), ["get_commands", "get_session_stats", "get_state", "prompt"].sort());
		assert.equal(harness.transport.requests.filter((request) => /tool|write|bash|edit|artifact/.test(String(request.type))).length, 0);
		// 绑定只是元数据：对齐仍然是 ready，批准只能由用户走 /align approve。
		assert.equal(await harness.alignmentPhase(), "ready");
	} finally {
		harness.close();
	}
});

test("release/unbind/status 同样放行；同一 runtime 上按绑定→批准顺序各发一次", async () => {
	const harness = await createHarness();
	try {
		assert.equal((await harness.send("/tpa-work release", "dwrelease_1")).accepted, true);
		assert.equal((await harness.send("/tpa-work unbind", "dwunbind_1")).accepted, true);
		assert.equal((await harness.send("/tpa-work status", "dwstatus_1")).accepted, true);
		const approve = `/align approve ${BRIEF_ID} ${REVISION}`;
		assert.equal((await harness.send(approve, "dwapprove_1")).accepted, true);
		assert.deepEqual(harness.transport.prompts(), ["/tpa-work release", "/tpa-work unbind", "/tpa-work status", approve]);
		assert.equal(harness.transport.prompts().filter((message) => message.startsWith("/align approve")).length, 1, "守卫不得自己补发批准");
	} finally {
		harness.close();
	}
});

test("语法不符的元数据控制、未知斜杠与执行命令：对齐期间一律拒绝且不转发", async () => {
	const harness = await createHarness();
	try {
		const rejected = [
			// 语法不精确的元数据控制先被对齐输入守卫挡下（reason=alignment_blocked）；
			// 语法精确但身份/载荷不符的才走到文稿命令闸（reason=invalid_input）。
			["多余参数", `${bindCommand()} extra`, "alignment_blocked"],
			["未知动作", "/tpa-work evil", "alignment_blocked"],
			["载荷非法", "/tpa-work bind not-a-payload!!", "alignment_blocked"],
			["载荷超长", `/tpa-work bind ${"A".repeat(64 * 1024 * 2)}`, "alignment_blocked"],
			["裸命令", "/tpa-work", "alignment_blocked"],
			["换行后接动作", "/tpa-work\nstatus", "alignment_blocked"],
			["回车换行后接绑定", `/tpa-work\r\nbind ${shared.encodeBindingPayload(bindingPayload())}`, "alignment_blocked"],
			["NBSP 分隔", "/tpa-work\u00a0status", "alignment_blocked"],
			["动作后多余 token", "/tpa-work status extra", "alignment_blocked"],
			// 执行触发不是元数据：对齐期间必须仍然被策略挡下（只放行 bind/release/unbind/status）。
			["执行命令", "/tpa-work execute AAAA", "alignment_blocked"],
			["别的会话的载荷", bindCommand({ nativeSessionId: "pi-native-other" }), "invalid_input"],
			["稳定会话 id 不符", bindCommand({ sessionId: "another-session" }), "invalid_input"],
			["载荷缺摘要", bindCommand({ digest: "" }), "invalid_input"],
			["载荷缺工作 id", bindCommand({ workId: "" }), "invalid_input"],
			["普通斜杠命令", "/plan 先规划一下", "alignment_blocked"],
			["未知命令", "/definitely-not-registered", "alignment_blocked"],
			["bash 执行", "!rm -rf C:/out", "alignment_blocked"],
			// 非斜杠文本是对齐期间用户答问的正常通道，不在本用例的拒绝集里（见下一个用例）。
		];
		for (const [label, message, reason] of rejected) {
			const result = await harness.send(message);
			assert.equal(result.accepted, false, label);
			assert.equal(result.reason, reason, label);
		}
		assert.equal(harness.transport.prompts().length, 0, "被拒的输入一条都不许到达 pi");
	} finally {
		harness.close();
	}
});

test("对齐期间非斜杠文本仍然放行（用户答问行为不变）", async () => {
	const harness = await createHarness();
	try {
		assert.equal((await harness.send("没有待决定项，按你的方案来")).accepted, true);
		assert.equal(harness.transport.prompts().length, 1);
	} finally {
		harness.close();
	}
});

test("改稿执行命令：真宿主守卫放行一次、扩展缺位时结构化拒绝且绝不转发", async () => {
	const binding = {
		schemaVersion: 1,
		workId: "dw_3e297d1cdc7b4481b7b78d3c",
		attemptId: "at_dc62c11fac92421dbcc1b90d",
		preparationId: "pr_dc62c11fac92421dbcc1b90d",
		digest: "a".repeat(64),
		sessionId: SESSION_ID,
		nativeSessionId: NATIVE_SESSION,
		kind: "revise_document",
		workDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c",
		stagingDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\staging\\at_dc62c11fac92421dbcc1b90d",
		materialCacheDirectory: "C:\\userData\\material-cache",
		materials: [],
		scope: { summary: "把第二节改短", sections: [], preserve: [] },
		requirements: { summary: "把第二节改短" },
	};
	const command = `/tpa-work execute ${shared.encodeBindingPayload(binding)}`;
	// 普通（非对齐）模式 + 扩展在位：真 AgentManager 守卫必须原样放行一次。
	const withExtension = await createHarness({ hydration: false });
	try {
		const result = await withExtension.send(command, "dwexecute_1");
		assert.equal(result.accepted, true, JSON.stringify(result));
		assert.deepEqual(withExtension.transport.prompts(), [command]);
	} finally {
		withExtension.close();
	}
	// 扩展缺位：结构化拒绝，绝不把载荷当普通提示交给模型。
	const withoutExtension = await createHarness({ hydration: false, extensionCommands: [] });
	try {
		const result = await withoutExtension.send(command, "dwexecute_2");
		assert.equal(result.accepted, false);
		assert.equal(result.reason, "extension_unavailable");
		assert.equal(withoutExtension.transport.prompts().length, 0);
	} finally {
		withoutExtension.close();
	}
});

test("扩展不可用：结构化拒绝、绝不把载荷当普通提示交给模型", async () => {
	const withoutDocumentWork = await createHarness({ extensionCommands: [{ name: "align", source: "extension" }] });
	try {
		const result = await withoutDocumentWork.send(bindCommand(), "dwbind_no_ext");
		assert.equal(result.accepted, false);
		assert.equal(result.reason, "extension_unavailable");
		assert.equal(result.error, mainProcessT("zh-CN", "mainAgent.documentWorkUnavailable"));
		assert.equal(withoutDocumentWork.transport.prompts().length, 0);
	} finally {
		withoutDocumentWork.close();
	}

	const withoutAnyExtension = await createHarness({ extensionCommands: [] });
	try {
		const alignment = await withoutAnyExtension.send(`/align approve ${BRIEF_ID} ${REVISION}`, "dwapprove_no_ext");
		assert.equal(alignment.accepted, false);
		assert.equal(alignment.reason, "extension_unavailable");
		assert.equal(alignment.error, mainProcessT("zh-CN", "mainAgent.alignmentUnavailable"));
		const bind = await withoutAnyExtension.send(bindCommand(), "dwbind_no_ext");
		assert.equal(bind.reason, "extension_unavailable");
		assert.equal(withoutAnyExtension.transport.prompts().length, 0);
	} finally {
		withoutAnyExtension.close();
	}
});

test("预检期间 runtime 换代：按身份变化拒绝，且不把旧命令发出去", async () => {
	const control = { flipNextPreflight: false };
	const harness = await createHarness({
		onRequest: async (request, context) => {
			// get_commands 是守卫里 await 的那一步：在这里模拟「预检期间 runtime 被替换」。
			if (request.type === "get_commands" && control.flipNextPreflight) {
				control.flipNextPreflight = false;
				context.tab.runtimeGeneration += 1;
			}
		},
	});
	try {
		control.flipNextPreflight = true;
		const result = await harness.send(bindCommand(), "dwbind_racing_restart");
		assert.equal(result.accepted, false);
		assert.equal(result.reason, "runtime_changed");
		assert.equal(result.error, mainProcessT("zh-CN", "mainAgent.alignmentRuntimeChanged"));
		assert.equal(harness.transport.prompts().length, 0);
	} finally {
		harness.close();
	}
});

test("没有对齐在途时：普通命令与文本照旧转发，文稿元数据仍要过语法与扩展预检", async () => {
	const harness = await createHarness({ hydration: false });
	try {
		assert.equal((await harness.send("/plan 先看仓库结构")).accepted, true);
		assert.equal((await harness.send("帮我把 docx 管线的类型拆开")).accepted, true);
		// 命令名后面接换行/NBSP/多余 token：命令名级闸门必须先认出来，再按严格语法拒掉，
		// 绝不允许它们绕过可用性预检、被当成普通提示发给模型。
		for (const [label, message] of [
			["换行", "/tpa-work\nstatus"],
			["回车换行后接绑定", `/tpa-work\r\nbind ${shared.encodeBindingPayload(bindingPayload())}`],
			["NBSP", "/tpa-work\u00a0status"],
			["多余 token", "/tpa-work status extra"],
			["非法载荷", "/tpa-work bind not-a-payload!!"],
		]) {
			const result = await harness.send(message);
			assert.equal(result.accepted, false, label);
			assert.equal(result.reason, "invalid_input", label);
		}
		// 精确形态依旧可用（空格或制表分隔都算精确语法）。
		assert.equal((await harness.send("/tpa-work status")).accepted, true);
		assert.equal((await harness.send("/tpa-work\tstatus")).accepted, true);
		assert.equal((await harness.send(bindCommand())).accepted, true);
		assert.deepEqual(harness.transport.prompts(), ["/plan 先看仓库结构", "帮我把 docx 管线的类型拆开", "/tpa-work status", "/tpa-work\tstatus", bindCommand()]);
	} finally {
		harness.close();
	}
});

test("共享策略与守卫同一口径：只有精确元数据控制能过对齐输入守卫", () => {
	const allowed = [bindCommand(), "/tpa-work release", "/tpa-work unbind", "/tpa-work status", "普通文本", "/align approve brief-live 3"];
	for (const message of allowed) assert.equal(alignmentPolicy.isAlignmentReadOnlyInputAllowed(message), true, message);
	const blocked = ["/tpa-work", "/tpa-work bind", "/tpa-work bind a b", "/tpa-work status extra", "/tpa-work unknown", "/tpa-work\nstatus", "/tpa-work\u00a0status", "/tpa-work execute AAAA", "!ls", "/plan"];
	for (const message of blocked) assert.equal(alignmentPolicy.isAlignmentReadOnlyInputAllowed(message), false, message);
	// execute 是执行触发，不是元数据控制：解析器不得把它当成可放行的控制命令。
	assert.equal(alignmentPolicy.parseDocumentWorkMetadataControl("/tpa-work execute AAAA"), undefined);
	// 命令名检测要宽于严格语法：换行/NBSP/多余 token 都必须先被认成「文稿命令」，再由严格解析拒掉。
	for (const message of ["/tpa-work", "/tpa-work\nstatus", "/tpa-work\r\nbind x", "/tpa-work\u00a0status", "/tpa-work status extra", "/tpa-work\tstatus"]) {
		assert.equal(alignmentPolicy.isDocumentWorkMetadataCommandName(message), true, message);
	}
	// 不是同一个命令名（`-`/`_`/字母数字续写）不得命中。
	for (const message of ["/tpa-work-x", "/tpa_work", "/tpa-workbench", "tpa-work status", "普通文本"]) {
		assert.equal(alignmentPolicy.isDocumentWorkMetadataCommandName(message), false, message);
	}
});
