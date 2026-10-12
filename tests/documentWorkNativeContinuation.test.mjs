/**
 * 原生批准续跑的上下文契约（真机缺陷回归）。
 *
 * 证据（live-acceptance：word-v1-staging-context-inspection、guard-fixed-real-record-api）：
 * 会话 native JSONL 里有 tpa-document-work-binding、alignment execute/context、report，
 * 却没有 document-work-context；模型在思考里反复找 staging 路径，先去翻旧 outputs 与源码，
 * 写错了旧工作，再靠读当前 preparation 文件猜回本轮 staging。
 *
 * pi 的真实契约（dist/core/agent-session.js）：
 * - 用户提示词路径才会 `emitBeforeAgentStart`，它返回的 message 会被落成一条 custom_message；
 * - `pi.sendMessage(msg, { triggerTurn: true })`（alignment 批准就是这么触发执行的）走的是
 *   `_runAgentPrompt(appMessage)`，**不经过 before_agent_start**；
 * - `context` 钩子对每个模型请求都执行，用来变换本次请求的消息（`convertToLlm` 把
 *   role:"custom" 的内容当作用户可见文本交给模型）。
 *
 * 因此本轮上下文必须在 `context` 里保底注入：这里用忠实于上述契约的宿主驱动真实扩展，
 * 断言续跑请求确实拿到「本轮唯一、且是当前轮」的 staging/base/scope。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const MESSAGE = "message";
const extension = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-work.ts`).default;
// 用主进程真实编码器产出的载荷：两端对同一份 wire 格式负责。
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);

const CONTEXT_TYPE = "pi-deck-document-work-context";
const STATE_TYPE = "pi-deck-document-work-state";
const SESSION = "01a12fd6-9f5a-77ad-a09e-0f0022ecc466";
const STABLE_SESSION = "4aad9111-401e-46fc-93e8-c3e4d98615a2";
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function binding(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: "dw_3e297d1cdc7b4481b7b78d3c",
		attemptId: "at_dc62c11fac92421dbcc1b90d",
		preparationId: "pr_dc62c11fac92421dbcc1b90d",
		digest: "a".repeat(64),
		sessionId: STABLE_SESSION,
		nativeSessionId: SESSION,
		kind: "create_document",
		workDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c",
		stagingDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\staging\\at_dc62c11fac92421dbcc1b90d",
		materialCacheDirectory: "C:\\userData\\cache",
		materials: [{ materialId: "m1", label: "source.md", path: "C:\\in\\source.md", digest: "b".repeat(64) }],
		scope: { summary: "四段结构，两个 Heading 1", sections: [], preserve: [] },
		requirements: { summary: "四段结构，两个 Heading 1" },
		...overrides,
	};
}

/**
 * 忠实于 pi 契约的最小宿主：只实现本扩展用到的注册面 + 两种回合启动方式。
 * - `command(args)`：`/tpa-work ...` 命令处理器（pi 在 prompt 阶段执行扩展命令）；
 * - `sendMessage(msg, { triggerTurn: true })`：其它扩展/宿主触发的续跑（不触发 before_agent_start）；
 * - `prompt(text)`：用户提示词路径（触发 before_agent_start，并把返回消息落成 custom_message）；
 * - `request()`：模拟一次模型请求，只跑 `context` 钩子并返回模型会看到的文本。
 */
function createHost(options = {}) {
	const commands = new Map();
	const hooks = new Map();
	const tools = new Map();
	const branch = clone(options.entries ?? []);
	const messages = [];
	const notifications = [];
	/** 真的触发过模型回合的 sendMessage（triggerTurn）。 */
	const turns = [];
	let active = [];
	let session = options.session ?? SESSION;
	const counters = { beforeAgentStart: 0, requests: 0 };
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionId: () => session, getBranch: () => clone(branch) },
	};
	const pi = {
		on: (name, handler) => {
			if (!hooks.has(name)) hooks.set(name, []);
			hooks.get(name).push(handler);
		},
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: (value) => tools.set(value.name, value),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: clone(data) }),
		sendMessage: (message, sendOptions) => {
			messages.push(clone(message));
			branch.push({ type: "custom_message", ...clone(message) });
			if (sendOptions?.triggerTurn) {
				// 真实 pi 会为这条消息开一个模型回合一—这里只记账并跑一次请求。
				turns.push({ customType: message.customType, at: Date.now() });
				return host.request();
			}
			return undefined;
		},
	};
	extension(pi);

	/** 分支里可进入请求的消息（与 pi 的消息装配同形：custom 条目带 role:"custom"）。 */
	function branchMessages() {
		return branch.filter((entry) => entry.type === "custom_message").map((entry) => ({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: clone(entry.details), timestamp: 1 }));
	}

	/** 一次模型请求：只跑 context 钩子（pi 对每个请求都跑），返回模型会看到的文本列表。 */
	async function request() {
		counters.requests += 1;
		let list = branchMessages();
		for (const handler of hooks.get("context") ?? []) {
			// pi 对 context 处理器同样传 (event, ctx)：会话边界与绑定恢复都依赖它。
			const result = await handler({ type: "context", messages: list }, ctx);
			if (result?.messages) list = result.messages;
		}
		return list.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
	}

	/** 用户提示词路径：before_agent_start → 返回的 message 落成 custom_message → 模型请求。 */
	async function prompt(text) {
		branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
		await fire("before_agent_start", { type: "before_agent_start", prompt: text });
		return request();
	}

	async function fire(name, event, context = ctx) {
		if (name === "before_agent_start") counters.beforeAgentStart += 1;
		let result;
		for (const handler of hooks.get(name) ?? []) {
			const handlerResult = await handler(event, context);
			if (handlerResult !== undefined) result = handlerResult;
		}
		if (name === "before_agent_start" && result?.message) {
			branch.push({ type: "custom_message", ...clone(result.message) });
		}
		return result;
	}

	const host = {
		pi,
		ctx,
		branch,
		messages,
		notifications,
		turns,
		counters,
		request,
		prompt,
		fire,
		tools,
		/** 调用扩展注册的工具（与 pi 的 execute 调用同形）。 */
		tool: (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx),
		/** pi 在 prompt 阶段执行扩展命令：处理器收到的是命令名之后的参数（真实契约）。 */
		command: async (message) => {
			const text = message.trim();
			const args = text.startsWith("/tpa-work") ? text.slice("/tpa-work".length).trim() : text;
			await commands.get("tpa-work").handler(args, ctx);
			return request();
		},
		/** 其它扩展触发续跑（alignment 的 approve 就是 sendMessage(triggerTurn:true)）。 */
		continuation: async (message) => pi.sendMessage(message, { triggerTurn: true }),
		state: () => messages.filter((item) => item.customType === STATE_TYPE).at(-1)?.details?.documentWork,
		switchSession: (next, nextBranch) => {
			session = next;
			if (nextBranch) {
				branch.length = 0;
				branch.push(...clone(nextBranch));
			}
		},
	};
	return host;
}

/** 真实命令形态：/tpa-work bind <base64url 载荷>。 */
const bindCommand = (overrides) => `/tpa-work bind ${shared.encodeBindingPayload(binding(overrides))}`;

const contextMessages = (list) => list.filter((text) => text.includes("This session is executing TPA document work"));

test("批准续跑（sendMessage triggerTurn）必须带上本轮执行上下文，且不依赖 before_agent_start", async () => {
	const host = createHost();
	await host.command(bindCommand(binding()));
	const before = host.counters.beforeAgentStart;
	// alignment 的 /align approve 就是这么触发的：扩展消息 + triggerTurn。
	const seen = await host.continuation({ customType: "pi-deck-alignment-execute", content: "Execute only this explicitly confirmed requirements brief.", display: false });
	assert.equal(host.counters.beforeAgentStart, before, "续跑路径本就不该触发 before_agent_start");
	const contexts = contextMessages(seen);
	assert.equal(contexts.length, 1, "续跑请求必须恰好带一份本轮上下文");
	const text = contexts[0];
	assert.match(text, /staging/, "上下文要给出 staging 落盘位置");
	assert.ok(text.includes(binding().stagingDirectory), "必须是当前绑定的 staging 目录");
	assert.ok(text.includes("四段结构，两个 Heading 1"), "必须带上本轮确认的范围摘要");
	assert.ok(text.includes("source.md"), "必须让模型知道本轮材料");
});

test("用户提示词路径不重复注入：before_agent_start 落一条，context 只保留这一条", async () => {
	const host = createHost();
	await host.command(bindCommand(binding()));
	const seen = await host.prompt("继续吧");
	assert.equal(host.counters.beforeAgentStart, 1);
	const contexts = contextMessages(seen);
	assert.equal(contexts.length, 1, "同一条请求只允许一份本轮上下文");
});

test("新一轮绑定替换旧轮上下文：旧 staging 绝不与新轮同时出现", async () => {
	const host = createHost();
	await host.command(bindCommand(binding()));
	await host.prompt("开始");
	// 归档后的第二轮：同一会话、新的 attempt/preparation/digest/staging。
	const next = binding({
		attemptId: "at_second",
		preparationId: "pr_second",
		digest: "c".repeat(64),
		stagingDirectory: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\staging\\at_second",
		kind: "revise_document",
		base: { versionId: "v_1", path: "C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\versions\\v0001\\桥梁监测安排.docx", digest: "d".repeat(64), fileName: "桥梁监测安排.docx" },
	});
	await host.command(bindCommand(next));
	const seen = await host.prompt("按新要求改");
	const contexts = contextMessages(seen);
	assert.equal(contexts.length, 1, "新旧两轮上下文不得并存");
	assert.ok(contexts[0].includes("C:\\out\\dw_3e297d1cdc7b4481b7b78d3c\\staging\\at_second"));
	assert.ok(!contexts[0].includes(binding().stagingDirectory), "旧轮 staging 必须已被替换");
	assert.ok(contexts[0].includes("The frozen base copy for this round is"), "改稿轮必须给出冻结基稿路径");
});

test("release 之后普通聊天不再注入执行上下文（含已落盘的那一条）", async () => {
	const host = createHost();
	await host.command(bindCommand(binding()));
	// 用户提示词路径会把上下文落成 custom_message：它必须只在「本轮仍活着」时生效。
	assert.equal(contextMessages(await host.prompt("先按材料准备初稿")).length, 1, "用户轮先落一条上下文");
	assert.equal(contextMessages(await host.request()).length, 1, "落盘条目仍只保留一份");
	await host.command("release");
	assert.equal(contextMessages(await host.request()).length, 0, "结算完成后连已落盘的那条也不得保留");
	await host.command(bindCommand({ attemptId: "at_again", digest: "e".repeat(64) }));
	assert.equal(contextMessages(await host.request()).length, 1, "重新绑定后恢复注入");
	await host.command("unbind");
	assert.equal(contextMessages(await host.request()).length, 0, "解绑后不得再注入");
});

test("会话恢复按 pi 原生会话 id 认领绑定，稳定目录 id 不同不影响", async () => {
	const source = createHost();
	await source.command(bindCommand(binding()));
	const entries = clone(source.branch);
	// 应用重启：同一原生会话、稳定目录 id 不同（新建草稿的正常形态）。
	const reopened = createHost({ entries });
	reopened.switchSession(SESSION);
	await reopened.fire("session_start", { type: "session_start" });
	assert.equal(reopened.state()?.phase, "bound", "恢复必须认出同一原生会话的绑定");
	assert.equal(reopened.state()?.sessionId, STABLE_SESSION, "对外发布的仍是稳定目录 id");
	// 恢复出来的绑定只是后台归属：应用重启后的普通聊天不得再被上轮制作要求污染，
	// 只有新一轮真实绑定（新的 attempt/preparation）才会重新注入执行上下文。
	assert.equal(contextMessages(await reopened.request()).length, 0, "恢复后不得凭旧绑定注入执行上下文");
	assert.equal(contextMessages(await reopened.command(bindCommand({ attemptId: "at_next", preparationId: "pr_next", digest: "f".repeat(64) }))).length, 1, "新一轮绑定后恢复注入");

	// 别的原生会话不能继承别人的绑定。
	const foreign = createHost({ entries, session: "another-native-session" });
	await foreign.fire("session_start", { type: "session_start" });
	assert.equal(foreign.state(), undefined, "跨原生会话不得恢复绑定");
	assert.equal(contextMessages(await foreign.request()).length, 0);

	// 会话边界：已绑定会话切到另一个原生会话后，旧绑定与其上下文必须立刻消失
	//（context 钩子每个请求都会先认一次会话）。
	reopened.switchSession("another-native-session");
	assert.equal(contextMessages(await reopened.request()).length, 0, "切会话后不得带走旧会话的执行上下文");
	// 旧状态消息仍按原稳定会话 id 归属（不得被改写成新会话的绑定）。
	assert.equal(reopened.state()?.sessionId, STABLE_SESSION, "旧会话的绑定状态不得改挂到新会话");
});

const EXECUTION_TYPE = "pi-deck-document-work-execution";
const EXECUTION_ENTRY_TYPE = "tpa-document-work-execution";
const executionMessages = (list) => list.filter((text) => text.includes("改稿要求"));
/** 改稿轮的绑定：execute 只允许 revise_document 且必须与当前活动绑定逐项一致。 */
const revisionBinding = (overrides = {}) => binding({ kind: "revise_document", ...overrides });

/** 宿主授权的执行载荷：只有绑定（指令由扩展从冻结 scope/base 现场派生，不接受自由文本）。 */
function executeCommand(overrides = {}) {
	return `/tpa-work execute ${shared.encodeBindingPayload(revisionBinding(overrides))}`;
}

/** 期望指令：与扩展内派生规则同形；契约测试再与主进程 buildRevisionPrompt 逐字比对。 */
function expectedInstruction(overrides = {}) {
	const scope = revisionBinding(overrides).scope;
	const sections = scope.sections.length ? `\n声明要改的块：${scope.sections.join("、")}` : "";
	const preserve = scope.preserve.length ? `\n必须保留（逐块比较，改动会被判为未授权）：${scope.preserve.join("、")}` : "";
	return `改稿要求：${scope.summary}${sections}${preserve}\n只改声明的范围；成果写入本轮 staging 并调用 tpa_artifact_report 汇报候选。`;
}

/** 执行轮次计数：只有 triggerTurn 的自定义消息才算真的开了模型回合。 */
const executionTurns = (host) => host.turns.length;
const executionEntries = (host) => host.branch.filter((entry) => entry.type === "custom" && entry.customType === EXECUTION_ENTRY_TYPE);
const bindingEntries = (host) => host.branch.filter((entry) => entry.type === "custom" && entry.customType === "tpa-document-work-binding");

test("宿主授权的执行由扩展触发：指令从冻结 scope 派生，以自定义消息出发，不落成 role:user 轮", async () => {
	const host = createHost();
	await host.command(bindCommand(revisionBinding()));
	assert.equal(contextMessages(await host.request()).length, 1, "绑定后先有执行上下文");
	await host.command(executeCommand());
	// 执行消息必须落成 custom_message（不是用户轮），且内容由冻结 scope 现场派生。
	const emitted = host.branch.filter((entry) => entry.type === "custom_message" && entry.customType === EXECUTION_TYPE);
	assert.equal(emitted.length, 1, "执行提示必须以自定义消息发出一次");
	assert.equal(emitted[0].content, expectedInstruction(), "指令必须来自冻结 scope");
	const seen = await host.request();
	assert.equal(executionMessages(seen).length, 1, "本轮请求必须带上执行提示");
	assert.equal(
		host.branch.some((entry) => entry.type === "message" && entry.message?.role === "user"),
		false,
		"机器提示词不得落成用户轮",
	);
	// release 之后：执行权收回，上下文里也不再保留这条执行指令。
	await host.command("release");
	assert.equal(executionMessages(await host.request()).length, 0, "release 后执行提示必须退出上下文");
});

test("execute 的入口校验：未绑定、四元组/会话/类型不匹配、载荷非法一律拒绝", async () => {
	const unbound = createHost();
	await unbound.command(executeCommand());
	assert.equal(unbound.notifications.length, 1, "未绑定时必须拒绝并告知");
	assert.equal(
		unbound.branch.some((entry) => entry.customType === EXECUTION_TYPE),
		false,
		"未绑定不得发出执行",
	);

	for (const [label, overrides] of [
		["尝试不匹配", { attemptId: "at_other" }],
		["准备不匹配", { preparationId: "pr_other" }],
		["摘要不匹配", { digest: "b".repeat(64) }],
		["工作不匹配", { workId: "dw_other" }],
		["稳定会话不匹配", { sessionId: "another-stable" }],
		["非改稿轮", { kind: "create_document" }],
		["原生会话不匹配", { nativeSessionId: "another-native-session" }],
	]) {
		const bound = createHost();
		await bound.command(bindCommand(revisionBinding()));
		await bound.command(executeCommand(overrides));
		assert.equal(bound.notifications.length >= 1, true, `${label}必须拒绝`);
		assert.equal(bound.branch.filter((entry) => entry.customType === EXECUTION_TYPE).length, 0, `${label}不得触发本轮执行`);
	}

	const broken = createHost();
	await broken.command(bindCommand(revisionBinding()));
	await broken.command("execute not-a-payload!!");
	assert.equal(broken.branch.filter((entry) => entry.customType === EXECUTION_TYPE).length, 0, "非法载荷不得执行");
});

test("真机反例：bind→execute→同一 bind→同一 execute 只能有一个执行回合", async () => {
	const host = createHost();
	await host.command(bindCommand(revisionBinding()));
	await host.command(executeCommand());
	assert.equal(executionTurns(host), 1, "第一次 execute 触发一轮");
	// 同一载荷重复 bind + 重复 execute（真机反例的确切序列）。
	await host.command(bindCommand(revisionBinding()));
	await host.command(executeCommand());
	assert.equal(executionTurns(host), 1, "重复 bind 不得重新武装同一尝试");
	// 再来一轮重复也不许累加。
	await host.command(bindCommand(revisionBinding()));
	await host.command(executeCommand());
	assert.equal(executionTurns(host), 1, "任意次重复都不得再开一轮");
	assert.equal(executionEntries(host).length, 1, "投递去重标记只允许一条");
	assert.equal(bindingEntries(host).length, 1, "重复 bind 不得新增绑定条目");
});

test("重复 bind 是幂等的：不复位候选状态，也不新增绑定/执行条目", async () => {
	// 汇报一个候选（真实 staging 文件：绑定指向临时目录，工具会按 staging 相对路径校验）。
	const staging = mkdtempSync(join(tmpdir(), "pideck-dedup-"));
	writeFileSync(join(staging, "桥梁监测安排.docx"), "synthetic docx bytes");
	const withStaging = revisionBinding({ stagingDirectory: staging });
	const host = createHost();
	await host.command(bindCommand(withStaging));
	await host.command(executeCommand(withStaging));
	const reported = await host.tool("tpa_artifact_report", { reportId: "rp_1", artifacts: [{ relativePath: "桥梁监测安排.docx", role: "primary" }], summary: "初稿", risks: [] });
	assert.equal(reported.details.documentWork.ok, true, JSON.stringify(reported.details.documentWork));
	assert.equal(host.state()?.phase, "reported");
	const bindingsBefore = bindingEntries(host).length;
	const executionsBefore = executionEntries(host).length;
	await host.command(bindCommand(withStaging));
	assert.equal(host.state()?.phase, "reported", "重复 bind 不得把候选状态复位成 bound");
	// 状态回执（custom_message）是必要的；绑定/执行条目一律不得新增。
	assert.equal(bindingEntries(host).length, bindingsBefore, "重复 bind 不得新增绑定条目");
	assert.equal(executionEntries(host).length, executionsBefore, "重复 bind 不得新增执行条目");
	assert.equal(executionTurns(host), 1);
	rmSync(staging, { recursive: true, force: true });
});

test("release/unbind 之后同一尝试不得重新获得执行权", async () => {
	for (const [label, teardown] of [
		["release 之后", "release"],
		["unbind 之后", "unbind"],
	]) {
		const host = createHost();
		await host.command(bindCommand(revisionBinding()));
		await host.command(executeCommand());
		await host.command(teardown);
		await host.command(bindCommand(revisionBinding()));
		await host.command(executeCommand());
		assert.equal(executionTurns(host), 1, `${label}：重绑同一尝试不得再开一轮`);
		assert.equal(contextMessages(await host.request()).length, 0, `${label}：重绑也不得重新注入制作上下文`);
	}
});

test("重启恢复：投递去重条目随分支恢复，重绑同一尝试不得再开一轮", async () => {
	const host = createHost();
	await host.command(bindCommand(revisionBinding()));
	await host.command(executeCommand());
	assert.equal(executionEntries(host).length, 1, "投递标记必须落盘");
	const reopened = createHost({ entries: clone(host.branch) });
	await reopened.fire("session_start", { type: "session_start" });
	assert.equal(reopened.state()?.phase, "bound", "恢复仍能看到绑定");
	assert.equal(contextMessages(await reopened.request()).length, 0, "恢复后 fail-closed：不注入执行上下文");
	await reopened.command(bindCommand(revisionBinding()));
	await reopened.command(executeCommand());
	assert.equal(executionTurns(reopened), 0, "恢复 + 重绑同一尝试不得再开一轮");
});

test("篡改 kind：同一四元组的 revise 载荷不得顶替 create 绑定去执行", async () => {
	const host = createHost();
	const createBinding = binding({ kind: "create_document" });
	await host.command(bindCommand(createBinding));
	// 同一 work/attempt/preparation/digest，但载荷伪造 kind=revise_document。
	await host.command(executeCommand({ kind: "revise_document" }));
	assert.equal(executionTurns(host), 0, "绑定是 create 轮时不得借伪造 kind 执行");
	assert.equal(host.notifications.length >= 1, true, "必须如实告知被拒");
	// 反向：同一尝试里再 bind 一个身份不同（digest 变了）的载荷不得顶替有效绑定。
	await host.command(bindCommand({ ...createBinding, digest: "c".repeat(64), kind: "revise_document" }));
	assert.equal(host.state()?.digest, createBinding.digest, "有效绑定不得被同尝试的不同身份顶替");
	assert.equal(host.notifications.length >= 1, true);
});

test("真正的新一轮（新 attemptId）照常执行一次，且它自己的重复请求同样被拒", async () => {
	const host = createHost();
	await host.command(bindCommand(revisionBinding()));
	await host.command(executeCommand());
	assert.equal(executionTurns(host), 1);
	const nextAttempt = { attemptId: "at_second", preparationId: "pr_second", digest: "d".repeat(64) };
	await host.command(bindCommand(revisionBinding(nextAttempt)));
	await host.command(executeCommand(nextAttempt));
	assert.equal(executionTurns(host), 2, "新一轮必须能执行");
	assert.equal(contextMessages(await host.request()).length, 1, "新一轮重新注入本轮上下文");
	await host.command(executeCommand(nextAttempt));
	assert.equal(executionTurns(host), 2, "新一轮自己也只执行一次");
	assert.equal(executionEntries(host).length, 2, "两轮各一条投递标记");
});

test("契约一致：扩展现场派生的指令与主进程 buildRevisionPrompt 逐字相同", async () => {
	const { buildRevisionPrompt } = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentAttemptRunner.ts`);
	const scope = { summary: "把第二节改短", sections: ["二、实施安排"], preserve: ["一、项目背景"] };
	const host = createHost();
	await host.command(bindCommand(revisionBinding({ scope })));
	await host.command(executeCommand({ scope }));
	const seen = await host.request();
	assert.equal(executionMessages(seen).length, 1);
	assert.equal(executionMessages(seen)[0], buildRevisionPrompt({ scope }), "同形契约：扩展从绑定派生、主进程从准备派生，两端必须逐字一致");
});
