/**
 * 普通聊天的改稿轮：真实 hook → 真实 IPC → 真实服务/端口的时序回归。
 *
 * 真机缺陷（live-acceptance/ordinary-scope-revision.json、ordinary-revision-receipts.json）：
 * 用户在一次真实确认、v1 归档通过之后，直接在普通聊天里发了明确的改稿要求
 * （「把第二节改短，改成…，第一节保持不变，不改任何格式。」）。模型 14.8s 后
 * 如实调用 tpa_work_revise 声明意图并停下等桌面端，宿主只记下「Revision intent
 * received」，之后没有任何 bind / 改稿提示 / 准备 / 回执：work 停在 rev4、
 * versions=1、active=null。v1 的 hash 与 mtime 每 500ms 采样都没变（也没有提前改动）。
 *
 * 模型意图本身不授授权，正式改稿轮只能由渲染层在「用户发了要求」时经 IPC 发起；
 * 所以断点在触发链路上：
 * 1. 乐观用户消息可能先以稳定 id、空正文到达，而触发点把轮标识**在确认正文之前**
 *    就烧掉了；
 * 2. 主进程读到的运行时快照可能还没包含这一轮（RPC 在途），此时按「不够明确的旧轮」
 *    返回不接续；渲染层把这个结论当成终局，同一轮之后再也不重试——即使原生回显、
 *    运行时空闲、完整快照都已经到达。
 *
 * 本文件用真实 hook（React 语义渲染台）+ 真实 IPC handler + 真实文稿域（只假 pi 传输面）
 * 复现这两条时序，并覆盖重复消费者、历史重挂载、普通聊天不误触与宿主自造提示词的授权边界。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { AGENT_ID, NATIVE_SESSION_ID, SESSION_ID, createHarness, createWork, plain, prepareCreate, startRound, waitFor } from "./helpers/documentWorkServiceHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createDocumentWorkHarness, userMessage } from "./helpers/documentWorkHookHarness.mjs";

const shared = loadTsCommonJs("src/shared/documentWork.ts");

const AUTHORIZATION = { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 };
/** 每次 autoRevise 的入参与结果：断言「重试的是同一轮、终局不重试」用。 */
const apiLog = [];
const V1_MD = "# 一、项目背景\n\n桥梁监测样例，长度 120 米。\n\n# 二、实施安排\n\n先布设传感器，再进行每日检查。\n";
const V2_MD = "# 一、项目背景\n\n桥梁监测样例，长度 120 米。\n\n# 二、实施安排\n\n布设传感器后每日检查。\n";
/** 真机那条普通聊天里的改稿要求（生产策略判定为明确改稿：ordinary-policy-counterexample.json）。 */
const INSTRUCTION = "把第二节改短，改成“布设传感器后每日检查。”，第一节保持不变，不改任何格式。";

/** 真实 IPC 边界：只把 handler 表接出来，服务仍是 harness 里的生产域。 */
function createIpcBoundary(domain) {
	const handlers = new Map();
	const load = createTsSandbox({
		stubs: {
			electron: {
				ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
				dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
			},
		},
	});
	const { registerDocumentWorkIpc } = load("src/main/ipc/documentWorkIpc.ts");
	const { ipcChannels } = load("src/shared/ipc.ts");
	registerDocumentWorkIpc({
		service: domain.service,
		getWindow: () => null,
		registerChatMaterials: async () => [],
		registerOutputRoot: async (realPath) => ({ outputRootId: "or_1", label: "文稿", path: realPath, addedAt: 1 }),
	});
	return { invoke: (channel, payload) => handlers.get(ipcChannels[channel])({}, payload) };
}

/** 建一件「v1 已归档并通过检查」的工作（真实服务 + 真实文件系统，只假 pi 传输面）。 */
async function arrangeArchivedV1(harness) {
	const view = await createWork(harness);
	harness.alignment();
	const prepared = await prepareCreate(harness, view);
	assert.equal(prepared.ok, true, JSON.stringify(prepared));
	const started = await startRound(harness, view, prepared, "req-v1", AUTHORIZATION);
	assert.equal(started.ok, true, JSON.stringify(started));
	await harness.finishRound(V1_MD);
	const operation = await harness.terminal(view.workId, "req-v1");
	assert.equal(operation.phase, "archived", JSON.stringify(operation.error ?? null));
	await harness.domain.service.drain();
	return view;
}

/** 真实渲染层 hook：list/autoRevise 都走生产 IPC，只有 pi 传输面是假的。 */
function mountHook(harness, ipc, messages) {
	return createDocumentWorkHarness({
		sessionId: SESSION_ID,
		messages,
		documentWorkApi: {
			list: async () => harness.domain.service.listForSession(SESSION_ID),
			onChanged: () => () => {},
			autoRevise: async (input) => {
				const result = await ipc.invoke("documentWorkAutoRevise", input);
				apiLog.push({ sourceTurnId: input.sourceTurnId ?? null, result: result.ok ? result.value : { error: result.error?.code, detail: result.error?.detail } });
				return result;
			},
		},
	});
}

/**
 * 真实链路的收敛等待：hook 的 list/autoRevise 走真 IPC + 真文件 IO，
 * setImmediate 一次不够（要多次微任务 + 线程池读盘），必须等状态真的落地再断言。
 */
async function settleHook(hook, predicate = () => true, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		hook.render();
		await new Promise((resolve) => setImmediate(resolve));
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

/** 把「用户轮已经到达主进程」这件事真实落地：读端口拿到的是权威快照。 */
function deliverUserTurn(harness, id, text) {
	harness.state.messages = [...harness.state.messages.filter((message) => message.id !== id), { id, role: "user", text, agentId: AGENT_ID, timestamp: Date.now() }];
}

/** 改稿轮真正开始过的证据：v1 之后新增的绑定与「扩展 execute」派发。 */
const sentSince = (harness, baseline) => harness.state.dispatched.slice(baseline);
const revisionBinds = (harness, baseline = 0) => sentSince(harness, baseline).filter((message) => message.startsWith("/tpa-work bind "));
const revisionExecutes = (harness, baseline = 0) => sentSince(harness, baseline).filter((message) => message.startsWith("/tpa-work execute "));
const executePayload = (message) => shared.decodeBindingPayload(message.slice("/tpa-work execute ".length));
/** 指令由扩展从冻结 scope 现场派生（载荷只带绑定）：这里按同形规则算出期望文本。 */
function expectedInstruction(payload) {
	const scope = payload?.scope ?? { summary: "", sections: [], preserve: [] };
	const sections = scope.sections.length
		? `
声明要改的块：${scope.sections.join("、")}`
		: "";
	const preserve = scope.preserve.length
		? `
必须保留（逐块比较，改动会被判为未授权）：${scope.preserve.join("、")}`
		: "";
	return `改稿要求：${scope.summary}${sections}${preserve}
只改声明的范围；成果写入本轮 staging 并调用 tpa_artifact_report 汇报候选。`;
}
const revisionPrompts = (harness, baseline = 0) => revisionExecutes(harness, baseline).map((message) => expectedInstruction(executePayload(message)));

test("乐观消息先以空正文到达：正文补齐后仍必须接续（同一轮不得提前烧掉）", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000 });
	const view = await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	const baseline = harness.state.dispatched.length;
	const hook = mountHook(harness, ipc, [userMessage("", "turn-revise")]);
	try {
		// 视图先落地（真实 UI 里工作卡片早就在了），再等乐观消息
		await settleHook(hook, () => hook.controls.view?.revisionReady === true);
		assert.equal(hook.controls.view?.revisionReady, true, "夹具前提：v1 已就绪");
		assert.equal(revisionPrompts(harness, baseline).length, 0, "空正文不是一轮要求，不能发出任何改稿");

		// 正文到达（同一稳定 id）：这是真实 UI 的第二步。
		deliverUserTurn(harness, "turn-revise", INSTRUCTION);
		hook.setMessages([userMessage(INSTRUCTION, "turn-revise")]);
		await settleHook(hook, () => revisionPrompts(harness, baseline).length > 0);
		assert.equal(revisionBinds(harness, baseline).length, 1, "恰好一次绑定");
		assert.equal(revisionPrompts(harness, baseline).length, 1, "恰好一次正式改稿提示");
		assert.equal(revisionExecutes(harness, baseline).length, 1, "改稿提示必须由扩展 execute 触发（不是 role:user 轮）");
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(record.consumedRevisionTurnIds.includes("turn-revise"), true, "这一轮必须被记为已消费");
	} finally {
		hook.unmount();
		await harness.cleanup();
	}
});

test("运行时快照还没包含新轮（在途）：快照补齐后必须重试同一轮", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000 });
	const view = await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	// 真实的「RPC 在途」：主进程这一读拿到的还是旧快照（没有这一轮用户消息）。
	const realReadRuntime = harness.port.readRuntime;
	const lag = { pending: true };
	harness.port.readRuntime = async (sessionId) => {
		const snapshot = await realReadRuntime(sessionId);
		if (!snapshot || !lag.pending) return snapshot;
		return { ...snapshot, messages: snapshot.messages.filter((message) => message.id !== "turn-revise") };
	};
	const baseline = harness.state.dispatched.length;
	const hook = mountHook(harness, ipc, [userMessage(INSTRUCTION, "turn-revise")]);
	try {
		await settleHook(hook, () => hook.controls.view?.revisionReady === true);
		deliverUserTurn(harness, "turn-revise", INSTRUCTION);
		await settleHook(hook, () => revisionPrompts(harness, baseline).length > 0, 800);
		assert.equal(revisionPrompts(harness, baseline).length, 0, "快照还没有这一轮时不能凭空接续");

		// 权威快照补齐（pi 回显/空闲后的完整快照）：同一轮必须被重试，而不是永久放弃。
		lag.pending = false;
		hook.setMessages([userMessage(INSTRUCTION, "turn-revise")]);
		await settleHook(hook, () => revisionPrompts(harness, baseline).length > 0);
		// 结论序列必须能看出「先说到不了、再说接续」：同一轮被重试，而不是被丢掉。
		assert.equal(
			apiLog.some((entry) => entry.sourceTurnId === "turn-revise" && entry.result.reason === "turn_not_arrived"),
			true,
			JSON.stringify(apiLog),
		);
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(record.consumedRevisionTurnIds.includes("turn-revise"), true);
		assert.equal(revisionBinds(harness, baseline).length, 1, "重试不得重复绑定");
	} finally {
		hook.unmount();
		await harness.cleanup();
	}
});

test("多个 UI 消费者与重复渲染：只开一轮改稿，轮标识只消费一次", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000 });
	const view = await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	const baseline = harness.state.dispatched.length;
	const timeline = mountHook(harness, ipc, [userMessage(INSTRUCTION, "turn-revise")]);
	const alignment = mountHook(harness, ipc, [userMessage(INSTRUCTION, "turn-revise")]);
	try {
		await settleHook(timeline, () => timeline.controls.view?.revisionReady === true);
		await settleHook(alignment, () => alignment.controls.view?.revisionReady === true);
		deliverUserTurn(harness, "turn-revise", INSTRUCTION);
		await settleHook(timeline, () => revisionPrompts(harness, baseline).length > 0);
		// 重复渲染（同一输入、同一条消息的多次快照）也不得再开一轮。
		timeline.setMessages([userMessage(INSTRUCTION, "turn-revise")]);
		alignment.setMessages([userMessage(INSTRUCTION, "turn-revise")]);
		await settleHook(timeline, () => false, 300);
		await settleHook(alignment, () => false, 300);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(revisionPrompts(harness, baseline).length, 1, "两个消费者只能开一轮改稿");
		assert.equal(revisionBinds(harness, baseline).length, 1);
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(record.consumedRevisionTurnIds.filter((id) => id === "turn-revise").length, 1);
	} finally {
		timeline.unmount();
		alignment.unmount();
		await harness.cleanup();
	}
});

test("历史重挂载：已消费的那一轮不得重放", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000 });
	const view = await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	const history = [userMessage(INSTRUCTION, "turn-revise")];
	const first = mountHook(harness, ipc, history);
	try {
		await settleHook(first, () => first.controls.view?.revisionReady === true);
		deliverUserTurn(harness, "turn-revise", INSTRUCTION);
		await settleHook(first, () => revisionPrompts(harness).length > 0);
	} finally {
		first.unmount();
	}
	// 归档这轮（真实结算：写 staging + 汇报 + 稳定），再重挂载整段历史。
	harness.state.messages = [...harness.state.messages, { id: "turn-report", role: "assistant", text: "已提交", agentId: AGENT_ID, timestamp: Date.now() }];
	// 相位先落、释放/清理在协程里收尾：等这一轮**新增**的 release 出现再 drain，然后取基线。
	const releasesBefore = harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length;
	await harness.finishRound(V2_MD);
	await waitFor(() => harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length > releasesBefore, 5_000, "改稿轮收尾");
	await harness.domain.service.drain();
	const before = harness.state.dispatched.length;
	const remount = mountHook(harness, ipc, history);
	try {
		await settleHook(remount, () => false, 600);
		assert.equal(harness.state.dispatched.length, before, "重挂载不得重放已消费的轮");
		assert.equal(revisionBinds(harness, before).length, 0, "重挂载不得再绑定");
		assert.equal(revisionPrompts(harness, before).length, 0, "重挂载不得再派发改稿提示");
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(record.consumedRevisionTurnIds.filter((id) => id === "turn-revise").length, 1);
	} finally {
		remount.unmount();
		await harness.cleanup();
	}
});

test("普通编码/讨论/整轮否定：普通聊天不误触改稿", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000 });
	await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	const baseline = harness.state.dispatched.length;
	for (const [label, text] of [
		["编码轮", "把 docx 管线的类型拆开，重构报告生成接口"],
		["讨论", "第二节这样写合适吗？先说说理由"],
		["整轮否定", "先别改，解释一下第二节为什么这么短"],
		["整轮重写", "把正文整体重写一遍"],
	]) {
		const hook = mountHook(harness, ipc, [userMessage(text, `turn-${label}`)]);
		try {
			await settleHook(hook, () => hook.controls.view?.revisionReady === true);
			deliverUserTurn(harness, `turn-${label}`, text);
			await settleHook(hook, () => false, 300);
		} finally {
			hook.unmount();
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(revisionPrompts(harness, baseline).length, 0, "不适合的普通轮不得启动改稿");
});

test("机器轮不是人类授权：提示词只作为扩展自定义消息执行，重载后都不得再开一轮", async () => {
	const harness = createHarness({ startTimeoutMs: 2_000, bindTimeoutMs: 1_000, settleTimeoutMs: 10_000, persistDispatchedPrompts: true });
	const view = await arrangeArchivedV1(harness);
	const ipc = createIpcBoundary(harness.domain);
	const baseline = harness.state.dispatched.length;
	const hook = mountHook(harness, ipc, [userMessage(INSTRUCTION, "turn-revise")]);
	const executeMessage = () => revisionExecutes(harness, baseline)[0];
	try {
		await settleHook(hook, () => hook.controls.view?.revisionReady === true);
		deliverUserTurn(harness, "turn-revise", INSTRUCTION);
		await settleHook(hook, () => revisionExecutes(harness, baseline).length > 0);
	} finally {
		hook.unmount();
	}
	const hostPrompt = expectedInstruction(executePayload(executeMessage()));
	assert.equal(hostPrompt.includes("改稿要求"), true, "执行指令必须说明这是改稿轮");
	assert.equal(shared.decodeBindingPayload(executeMessage().slice("/tpa-work execute ".length)) !== undefined, true, "载荷必须是可解析的绑定");

	// 收尾这一轮（真实结算 + 释放），再取基线。
	const releasesBefore = harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length;
	await harness.finishRound(V2_MD);
	await waitFor(() => harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length > releasesBefore, 5_000, "改稿轮收尾");
	await harness.domain.service.drain();

	// 结构性事实：机器提示词由扩展以自定义消息发出，pi 不会把它落成 role:user 轮；
	// 因此「最新用户轮 = 机器提示词」这种状态根本不存在（这正是 v2→v3 循环的根源）。
	const userTurns = harness.state.messages.filter((message) => message.role === "user");
	assert.equal(
		userTurns.some((message) => message.text === hostPrompt),
		false,
		"机器提示词不得作为用户轮落盘",
	);
	const record = await harness.domain.store.getRecord(view.workId);
	assert.equal(record.consumedRevisionTurnIds.includes("turn-revise"), true, "人类那一轮被正常消费");
	assert.equal((record.hostDispatchedTurnIds ?? []).length, 0, "结构性防线不依赖轮标识账本（账本为空也一样安全）");

	// 三种重载形态都不得再开新一轮：原生回显缺失、规范 id 变化、派发后崩溃（账本为空）。
	for (const [label, messages] of [
		["原生回显缺失", [userMessage(INSTRUCTION, "turn-revise")]],
		["规范 id 变化", [userMessage(INSTRUCTION, "native-human-1"), userMessage(executeMessage(), "native-host-1")]],
		["派发后崩溃（无账本）", [userMessage(INSTRUCTION, "native-human-2"), userMessage(executeMessage(), "native-host-2")]],
	]) {
		const remount = mountHook(harness, ipc, messages);
		try {
			await settleHook(remount, () => false, 500);
			assert.equal(revisionExecutes(harness, baseline).length, 1, `${label}：不得再开一轮`);
		} finally {
			remount.unmount();
		}
	}

	// 同一句话由人在新的一轮里再说一遍：按轮标识判定，仍然有效。
	const humanAgain = "turn-human-again";
	deliverUserTurn(harness, humanAgain, INSTRUCTION);
	const again = mountHook(harness, ipc, [userMessage(INSTRUCTION, humanAgain)]);
	try {
		await settleHook(again, () => revisionExecutes(harness, baseline).length > 1);
		assert.equal(revisionExecutes(harness, baseline).length, 2, `同一句话在新的人类轮里仍然有效 ${JSON.stringify(apiLog.slice(-3))}`);
	} finally {
		again.unmount();
	}
	await harness.cleanup();
});
