/**
 * 文稿域服务测试台：真实主进程模块 + 假运行时端口。
 *
 * 抽到 helper 的原因：写入事务、运行时租约与跨接口回归需要同一套真实装配；
 * 复制一份会让「测试用的假运行时」和产品语义各自漂移。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInlineInspectionWorkerFactory } from "./inspectionWorkerStub.mjs";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { createDocumentWorkDomain } = loadTsCommonJs(`${ROOT}/src/main/document-work/index.ts`);
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);
const serviceModule = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentWorkService.ts`);

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function waitFor(predicate, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = () => {
			if (predicate()) return resolve(true);
			if (Date.now() > deadline) return resolve(false);
			setTimeout(tick, 10);
		};
		tick();
	});
}
const AGENT_ID = "agent-a";
const SESSION_ID = "session-a";
const NATIVE_SESSION_ID = "pi-native-session-9";
const CREATE_TURN_TEXT = "请写一份季度报告";
const TURN_TEXT = "把第二节改短一点，标题也换一下";
const CREATE_TURN_HASH = serviceModule.hashTurnText(CREATE_TURN_TEXT);
const TURN_HASH = serviceModule.hashTurnText(TURN_TEXT);

/** 集成式测试台：真实主进程模块 + 假运行时端口。 */
function createHarness(options = {}) {
	const fresh = options.userDataPath === undefined;
	const root = fresh ? mkdtempSync(join(tmpdir(), "pideck-docwork-")) : dirname(options.userDataPath);
	const userData = fresh ? join(root, "userData") : options.userDataPath;
	if (!fresh) mkdirSync(userData, { recursive: true });
	const outputRoot = join(root, "out");
	const workspace = join(root, "workspace");
	mkdirSync(outputRoot, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const outputs = new Set();
	const piEvents = new Set();
	const state = {
		status: "idle",
		flags: {},
		generation: 1,
		messages: [{ id: "turn-1", role: "user", text: CREATE_TURN_TEXT, agentId: AGENT_ID, timestamp: 1 }],
		dispatched: [],
		aborted: [],
		allowedMaterials: new Set(),
		bindingAck: true,
		approveAccepted: true,
		approveUnknown: false,
		bindRejection: undefined,
		approveRejection: undefined,
	};
	const port = {
		readRuntime: async (sessionId) =>
			options.runtimeUnavailable
				? undefined
				: sessionId === SESSION_ID
					? {
							target: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: state.generation },
							status: state.status,
							state: { ...state.flags },
							messages: state.messages,
							// 稳定 SessionRecord.id 与 pi 原生会话 id 刻意取不同值：绑定必须用后者。
							nativeSessionId: NATIVE_SESSION_ID,
						}
					: undefined,
		dispatch: async (input) => {
			state.dispatched.push(input.message);
			// 真实 pi 会把普通 prompt 落成 role:user（含宿主自己写的改稿提示）。
			// 默认关闭以免影响既有夹具；需要验证「机器轮不算人类授权」的用例显式打开。
			if (options.persistDispatchedPrompts && !input.message.startsWith("/")) {
				state.messages.push({ id: `host-msg-${state.dispatched.length}`, role: "user", text: input.message, agentId: AGENT_ID, timestamp: Date.now() });
			}
			// 宿主可以结构化拒绝：真机上对齐输入守卫/扩展缺位就是这样把 accepted 置 false 的。
			if (input.message.startsWith("/tpa-work bind ") && state.bindRejection) return { accepted: false, unknown: false, ...state.bindRejection };
			if (input.message.startsWith("/align approve") && state.approveRejection) return { accepted: false, unknown: false, ...state.approveRejection };
			if (input.message.startsWith("/tpa-work bind ")) {
				if (!state.bindingAck) return { accepted: true, unknown: false };
				const payload = shared.decodeBindingPayload(input.message.slice("/tpa-work bind ".length));
				for (const listener of piEvents) {
					listener(AGENT_ID, {
						type: "message_end",
						sessionId: SESSION_ID,
						message: { role: "custom", customType: "pi-deck-document-work-state", details: { documentWork: { schemaVersion: 1, workId: payload.workId, attemptId: payload.attemptId, preparationId: payload.preparationId, digest: payload.digest, sessionId: SESSION_ID, phase: "bound", materials: [] } } },
					});
				}
				return { accepted: true, unknown: false };
			}
			if (input.message.startsWith("/align approve") && !state.approveAccepted) return { accepted: false, unknown: state.approveUnknown, error: "runtime_changed" };
			return { accepted: true, unknown: false };
		},
		abort: async (input) => {
			state.aborted.push(input.requestId);
			return { accepted: true, unknown: false };
		},
		hasDispatchInFlight: () => false,
		subscribeOutputs: (listener) => {
			outputs.add(listener);
			return () => outputs.delete(listener);
		},
		subscribePiEvents: (listener) => {
			piEvents.add(listener);
			return () => piEvents.delete(listener);
		},
	};
	const changes = [];
	const domain = createDocumentWorkDomain({
		userDataPath: userData,
		runtimePort: port,
		materials: { isAllowed: async (_sessionId, hostPath) => state.allowedMaterials.has(hostPath) },
		onChanged: (event) => changes.push({ ...event }),
		logger: { info: () => {}, warn: () => {} },
		inspectionWorkerFactory: createInlineInspectionWorkerFactory(),
		...(options.leaseAcquireBarrier ? { leaseAcquireBarrier: options.leaseAcquireBarrier } : {}),
		bindTimeoutMs: options.bindTimeoutMs ?? 400,
		settleTimeoutMs: options.settleTimeoutMs ?? 3_000,
		startTimeoutMs: options.startTimeoutMs ?? 400,
	});
	const emitRuntime = () => {
		for (const listener of outputs) listener("agents:runtime-state", { agentId: AGENT_ID, sessionId: SESSION_ID, runtimeGeneration: state.generation, status: state.status, state: { ...state.flags } });
	};
	const harness = {
		root,
		outputRoot,
		workspace,
		domain,
		port,
		state,
		changes,
		emitRuntime,
		/**
		 * 接管输出源：把真实 AgentManager 的 output 事件（生产 emitter）接到适配器上，
		 * 只假 pi 传输面——轻量补丁的身份必须由 emitter 自己带上，收端不做任何补全。
		 */
		attachOutputs(attach) {
			attach((payload) => {
				for (const listener of outputs) listener("agents:runtime-state", payload);
			});
		},
		/** 直接投递一条原始 runtime 输出：用于「无标识的迟到事件不得获得当前权威」的反例。 */
		emitRawOutput(payload) {
			for (const listener of outputs) listener("agents:runtime-state", payload);
		},
		/** 当前操作相位（不等待终态）。 */
		async operationPhase(workId, requestId) {
			const result = await domain.service.getOperation(workId, requestId, SESSION_ID);
			return result.ok ? result.value.phase : "missing";
		},
		/**
		 * 改稿轮的正式派发（新契约）：提示词装在扩展 `execute` 载荷里，
		 * 由扩展以自定义消息触发一轮——不再是 role:user 轮，因此不能用正文前缀去数。
		 */
		revisionExecutes() {
			return state.dispatched.filter((message) => message.startsWith("/tpa-work execute "));
		},
		revisionPrompts() {
			return harness.revisionExecutes().map((message) => {
				const payload = shared.decodeBindingPayload(message.slice("/tpa-work execute ".length));
				if (!payload) return "";
				// 指令现在由扩展从冻结 scope 现场派生（载荷只带绑定），这里按同形规则复现期望文本。
				const scope = payload.scope ?? { summary: "", sections: [], preserve: [] };
				const sections = scope.sections?.length ? `\n声明要改的块：${scope.sections.join("、")}` : "";
				const preserve = scope.preserve?.length ? `\n必须保留（逐块比较，改动会被判为未授权）：${scope.preserve.join("、")}` : "";
				return `改稿要求：${scope.summary ?? ""}${sections}${preserve}\n只改声明的范围；成果写入本轮 staging 并调用 tpa_artifact_report 汇报候选。`;
			});
		},
		/** 扩展看到的绑定载荷：attemptId 与 staging 路径都以此为准，与真实扩展一致。 */
		bindingPayload() {
			const bind = [...state.dispatched].reverse().find((message) => message.startsWith("/tpa-work bind "));
			return bind ? shared.decodeBindingPayload(bind.slice("/tpa-work bind ".length)) : undefined;
		},
		/** 写出本轮成果到 staging：真实流程里由模型完成。 */
		async writeStaged(content) {
			const payload = harness.bindingPayload();
			const target = join(payload.stagingDirectory, "report.md");
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, content, "utf8");
			return { attemptId: payload.attemptId, stagingDirectory: payload.stagingDirectory };
		},
		/** 模拟扩展汇报候选：身份四元组完全取自绑定载荷。 */
		reportCandidate(attemptId) {
			const payload = harness.bindingPayload();
			for (const listener of piEvents) {
				listener(AGENT_ID, {
					type: "message_end",
					sessionId: SESSION_ID,
					message: {
						role: "custom",
						customType: "pi-deck-document-work-state",
						details: {
							documentWork: {
								schemaVersion: 1,
								workId: payload.workId,
								attemptId,
								preparationId: payload.preparationId,
								digest: payload.digest,
								sessionId: SESSION_ID,
								phase: "reported",
								materials: [],
								report: { reportId: "rp_1", artifacts: [{ relativePath: "report.md", role: "primary" }], summary: "初稿完成", risks: ["未核对数据"] },
							},
						},
					},
				});
			}
		},
		/** 模型把成果写好并汇报，然后本轮稳定完成。 */
		async finishRound(content) {
			harness.runtime.busy();
			const staged = await harness.writeStaged(content);
			harness.reportCandidate(staged.attemptId);
			harness.runtime.settle();
		},
		async terminal(workId, requestId, timeoutMs = 4_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const result = await domain.service.getOperation(workId, requestId, SESSION_ID);
				const operation = result.ok ? result.value : undefined;
				if (operation && ["archived", "failed", "interrupted", "unknown"].includes(operation.phase)) return plain(operation);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error("operation did not settle");
		},
		runtime: {
			target: () => ({ sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: state.generation }),
			// 真实运行时状态补丁是「显式带字段」的：完成边沿必须显式把标志置回 false。
			settle: () => {
				state.status = "idle";
				state.flags = { isTurnActive: false, isStreaming: false, isCompacting: false, isExecutingTool: false };
				emitRuntime();
			},
			busy: () => {
				state.status = "running";
				state.flags = { isTurnActive: true, isStreaming: true };
				emitRuntime();
			},
		},
		alignment(overrides = {}) {
			const value = { schemaVersion: 1, briefId: "brief-1", revision: 2, phase: "ready", briefRevision: 2, brief: { goal: "写季度报告", scope: ["第二章"], materials: [], deliverable: "一份 Markdown 报告", preserve: ["保留原始数据"], acceptance: ["结构完整"], questions: [] }, ...overrides };
			domain.service.observeAlignmentState(SESSION_ID, value);
			return value;
		},
		async cleanup() {
			// 先取消在途结算并 drain，再删目录：否则后台协程会在测试结束后继续写盘。
			await domain.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
	return harness;
}

async function createWork(harness) {
	const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
	const created = await harness.domain.service.createWork({ requestId: "req-create", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" });
	assert.equal(created.ok, true);
	return plain(created.value);
}

function prepareCreate(harness, view, overrides = {}) {
	return harness.domain.service.prepare({
		requestId: overrides.requestId ?? "req-prepare",
		workId: view.workId,
		expectedRevision: view.revision,
		kind: "create_document",
		requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
		scope: { summary: "写季度报告", sections: [], preserve: [] },
		materialPaths: [],
	});
}

/** 改稿准备/开始：授权来源是那一轮真实用户指令的正文指纹。 */
/** 保证「真实用户当前轮」就是明确改稿要求：主进程只认这一轮，测试不能凭空造授权。 */
function ensureRevisionTurn(harness) {
	const lastUser = [...harness.state.messages].reverse().find((message) => message.role === "user");
	if (lastUser?.text === TURN_TEXT) return;
	harness.state.messages.push({ id: `turn-${harness.state.messages.length + 1}`, role: "user", text: TURN_TEXT, agentId: AGENT_ID, timestamp: Date.now() });
}

async function prepareRevision(harness, view, preserve, requestId, allow = []) {
	ensureRevisionTurn(harness);
	const prepared = await harness.domain.service.prepare({
		requestId,
		workId: view.workId,
		expectedRevision: view.revision,
		kind: "revise_document",
		requirementsRef: { kind: "user_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH },
		// 范围就是用户那一轮的原话：主进程会校验它的指纹与授权引用一致。
		// allow 声明本轮允许改动的块；基稿里其余块默认必须保留。
		scope: { summary: TURN_TEXT, sections: [], preserve, allow },
		materialPaths: [],
	});
	return prepared;
}

/** 主进程读到的真实用户当前轮 id。 */
function latestUserTurnId(harness) {
	return [...harness.state.messages].reverse().find((message) => message.role === "user")?.id ?? "turn-1";
}

function startRound(harness, view, prepared, requestId, authorization) {
	return harness.domain.service.start({ requestId, workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization });
}
export { ROOT, shared, serviceModule, plain, waitFor, AGENT_ID, SESSION_ID, NATIVE_SESSION_ID, CREATE_TURN_TEXT, TURN_TEXT, CREATE_TURN_HASH, TURN_HASH, createDocumentWorkDomain, createHarness, createWork, prepareCreate, ensureRevisionTurn, prepareRevision, latestUserTurnId, startRound };
