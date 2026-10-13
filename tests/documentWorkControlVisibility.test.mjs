/**
 * 宿主协议命令的时间线可见性（真机缺陷回归）。
 *
 * 现象（live-acceptance/routing-fixed-v2.json、continue-live-ui.json）：
 * 主进程派发的内部控制命令 `/tpa-work bind <payload>`、`/tpa-work execute <payload>`、
 * `/tpa-work release`（以及文稿链路里的 `/align approve …`）在时间线上显示成了**用户气泡**。
 * 原因是 `AgentManager.sendPrompt` 无条件把 `input.message` 写成一条 user 消息：
 * 协议命令与编码载荷都不是用户说的话，既误导用户，也污染「最新用户轮」的来源。
 *
 * 修法是一个**主进程内部**的投递选项：照常校验、照常 RPC 发送、照常触发模型、
 * 照常保留 expectedRuntime 栅栏与分发租约/幂等回执，只是不生成乐观用户气泡。
 * 渲染层不能设置它：公开 IPC 入参过白名单，伪造字段被丢弃。
 *
 * 本文件只假 pi 传输面；AgentManager 与 SessionRuntimeCoordinator 都是生产模块。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { AgentManager } = loadTsCommonJs(`${ROOT}/src/main/pi/AgentManager.ts`);
const { mainProcessT } = loadTsCommonJs(`${ROOT}/src/shared/i18n/mainProcessCopy.ts`);
const { sanitizeRendererPromptInput, INTERNAL_CONTROL } = loadTsCommonJs(`${ROOT}/src/main/sessions/internalPromptDelivery.ts`);
const INTERNAL = { [INTERNAL_CONTROL]: true };
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);
const { SessionRuntimeCoordinator } = createTsSandbox({
	stubs: {
		"../../shared/sessionIdentity": loadTsCommonJs(`${ROOT}/src/shared/sessionIdentity.ts`),
		"../../shared/types": {},
	},
})(`${ROOT}/src/main/sessions/SessionRuntimeCoordinator.ts`);

const SESSION_ID = "bda00c3a-6fdb-41ed-a304-d66b9da0de48";
const AGENT_ID = "agent-control-visibility";
const NATIVE_SESSION = "01a13060-c75f-763b-8976-1a43262478e7";
const translate = (key) => mainProcessT("zh-CN", key);

/** 真实宿主链路：真 AgentManager（假 pi 传输面）+ 真协调器；只假 RPC 面。 */
function createHarness() {
	const root = mkdtempSync(join(tmpdir(), "pideck-control-visibility-"));
	const sessionPath = join(root, "session.jsonl");
	writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: "root", timestamp: "2026-10-13T00:00:00.000Z", cwd: "C:/project", version: 3 })}\n`, "utf8");
	const requests = [];
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
	const runtime = {
		tab,
		process: {
			isRunning: () => true,
			getDiagnostics: () => null,
			client: {
				request: async (payload) => {
					requests.push(payload);
					if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: NATIVE_SESSION } };
					// 守卫的扩展可用性预检：文稿与对齐扩展在位。
					if (payload.type === "get_commands") {
						return {
							success: true,
							data: {
								commands: [
									{ name: "align", source: "extension" },
									{ name: "tpa-work", source: "extension" },
								],
							},
						};
					}
					return { success: true, data: {} };
				},
			},
		},
	};
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
		publishRuntimeState: async () => undefined,
		setModel: async () => undefined,
		setThinking: async () => undefined,
		setPermission: async () => undefined,
		getAvailableModels: async () => [],
		// 守卫的可用性预检：文稿与对齐扩展在位（否则协议命令会被结构化拒绝）。
		getCommands: async () => [
			{ name: "align", source: "extension" },
			{ name: "tpa-work", source: "extension" },
		],
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, gateway, (input) => manager.sendPrompt(input), undefined);
	const generation = coordinator.bindExistingAgent(SESSION_ID, AGENT_ID);
	return {
		manager,
		coordinator,
		requests,
		target: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: generation },
		prompts: () => requests.filter((request) => request.type === "prompt").map((request) => request.message),
		userBubbles: () =>
			manager
				.getMessages(AGENT_ID)
				.filter((message) => message.role === "user")
				.map((message) => message.text),
		send: (input) => coordinator.send({ sessionId: SESSION_ID, requestId: `req-${Math.random().toString(16).slice(2)}`, expectedRuntime: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: generation }, ...input }),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** 与文稿运行时端口同形的绑定载荷（真实共享编码器，能被宿主守卫与扩展解析）。 */
const BINDING_PAYLOAD = {
	schemaVersion: 1,
	workId: "dw_6dfb3d5e8add480f919beb5d",
	attemptId: "at_control_visibility",
	preparationId: "pr_control_visibility",
	digest: "a".repeat(64),
	sessionId: SESSION_ID,
	nativeSessionId: NATIVE_SESSION,
	kind: "revise_document",
	workDirectory: "C:/out/dw_control",
	stagingDirectory: "C:/out/dw_control/staging/at_control_visibility",
	materialCacheDirectory: "C:/data/cache",
	materials: [],
	scope: { summary: "把第二节改短", sections: [], preserve: [] },
	requirements: { summary: "把第二节改短" },
};
const ENCODED_BINDING = shared.encodeBindingPayload(BINDING_PAYLOAD);
/** 与文稿运行时端口同形的命令（bind/execute/release 都是宿主派发的协议命令）。 */
const BIND_COMMAND = `/tpa-work bind ${ENCODED_BINDING}`;
const EXECUTE_COMMAND = `/tpa-work execute ${ENCODED_BINDING}`;
const APPROVE_COMMAND = "/align approve brief-1 2";

test("内部协议命令照常送一次并触发模型，但不生成用户气泡", async () => {
	const harness = createHarness();
	try {
		for (const command of [BIND_COMMAND, EXECUTE_COMMAND, "/tpa-work release", APPROVE_COMMAND]) {
			const result = await harness.send({ message: command, ...INTERNAL });
			assert.equal(result.accepted, true, JSON.stringify(result));
		}
		// 每条命令都必须原样送到 pi 恰好一次（触发语义不变）。
		assert.deepEqual(harness.prompts(), [BIND_COMMAND, EXECUTE_COMMAND, "/tpa-work release", APPROVE_COMMAND]);
		// 时间线上零用户气泡：宿主元数据与编码载荷不是用户发言。
		assert.equal(harness.userBubbles().length, 0, `内部控制命令不得出现在时间线的用户气泡里：${JSON.stringify(harness.userBubbles())}`);
	} finally {
		harness.close();
	}
});

test("普通用户提示（含用户自打的斜杠命令）仍然保留原文气泡", async () => {
	const harness = createHarness();
	try {
		const cases = ["把第二节改短，改成“布设传感器后每日检查。”", "/tpa-work status", "/help 我该怎么继续？"];
		for (const text of cases) {
			const result = await harness.send({ message: text });
			assert.equal(result.accepted, true, JSON.stringify(result));
		}
		assert.deepEqual(harness.prompts(), cases, "普通提示必须原样到达 pi");
		const actual = harness.userBubbles();
		for (let index = 0; index < cases.length; index += 1) {
			assert.equal(actual[index], cases[index], `第 ${index} 条用户文本必须原样可见`);
		}
		assert.equal(actual.length, cases.length, `用户气泡数量必须与用户输入一致：${JSON.stringify(actual)}`);
	} finally {
		harness.close();
	}
});

test("伪造的渲染层可见性字段被边界丢弃：文本仍然可见", async () => {
	const harness = createHarness();
	try {
		// 渲染层经公开 IPC 送进来的原始入参（含伪造的内部控制标记）。
		const forged = {
			sessionId: SESSION_ID,
			requestId: "req-forged",
			message: "把第二节改短，改成“布设传感器后每日检查。”",
			// 渲染层能构造的只有普通字符串键：内部标记是 Symbol 键，结构化克隆根本带不过来。
			internalControl: true,
			expectedRuntime: harness.target,
		};
		// 结构证据：结构化克隆（IPC 的传输方式）不会携带 symbol 键。
		const cloned = structuredClone(forged);
		assert.equal(Object.getOwnPropertySymbols(cloned).length, 0, "IPC 结构化克隆不得携带内部标记");
		// 直接把它当协调器入参：字符串键不构成内部控制，文本仍然可见。
		const direct = await harness.send(forged);
		assert.equal(direct.accepted, true, JSON.stringify(direct));
		assert.equal(harness.userBubbles()[0], forged.message, "伪造成字符串键不得吞掉用户文本");
		// 边界白名单同样会丢掉它。
		// 换一个 requestId：协调器按 sessionId+requestId 去重，同一 id 的第二次调用是幂等重放。
		const sanitized = sanitizeRendererPromptInput({ ...forged, requestId: "req-forged-sanitized" });
		assert.equal("internalControl" in sanitized, false, "渲染层伪造的投递选项必须被丢弃");
		assert.equal(sanitized.message, forged.message);
		assert.deepEqual(sanitized.expectedRuntime, harness.target, "白名单字段必须保留");

		const result = await harness.send(sanitized);
		assert.equal(result.accepted, true, JSON.stringify(result));
		const bubbles = harness.userBubbles();
		assert.equal(bubbles.length, 2, `白名单入参同样不得吞掉用户文本：${JSON.stringify(bubbles)}`);
		assert.equal(bubbles[0], forged.message, "用户文本必须原样保留");
		assert.equal(harness.prompts().length, 2);
		assert.equal(harness.prompts()[0], forged.message);
	} finally {
		harness.close();
	}
});

test("内部投递不改变运行时栅栏：过期 expectedRuntime 仍然零转发", async () => {
	const harness = createHarness();
	try {
		const stale = { ...harness.target, runtimeGeneration: harness.target.runtimeGeneration + 1 };
		const result = await harness.send({ message: BIND_COMMAND, ...INTERNAL, expectedRuntime: stale });
		assert.equal(result.accepted, false, JSON.stringify(result));
		assert.equal(harness.prompts().length, 0, `过期运行时的内部控制命令也不得转发：${JSON.stringify(harness.prompts())}`);
		assert.equal(harness.userBubbles().length, 0, `被拒的内部命令不得留下气泡：${JSON.stringify(harness.userBubbles())}`);
	} finally {
		harness.close();
	}
});

test("装配契约：文稿端口传内部控制，渲染层入口过白名单", () => {
	// 空白容忍的源码契约：只锁「哪条链路带上内部标记」「哪个入口过白名单」这两件事。
	const indexSource = readFileSync(join(ROOT, "src/main/index.ts"), "utf8");
	const dispatch = /\[\s*INTERNAL_CONTROL\s*\]\s*:\s*true/.test(indexSource);
	assert.equal(dispatch, true, "文稿运行时端口的分发必须标记为内部控制投递（Symbol 键）");
	assert.match(indexSource, /sendSessionPrompt[\s\S]{0,200}?sanitizeRendererPromptInput\s*\(\s*input\s*\)/, "Web/远程提示入口也必须过白名单");
	const ipcSource = readFileSync(join(ROOT, "src/main/ipc/sessionIpc.ts"), "utf8");
	assert.match(ipcSource, /send\s*\(\s*sanitizeRendererPromptInput\s*\(\s*input\s*\)\s*\)/, "渲染层提示入口必须先过白名单再入协调器");
});
