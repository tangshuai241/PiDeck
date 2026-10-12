/**
 * 文稿服务编排：授权、准备失效、运行时绑定、分发顺序、取消、归档与防覆盖。
 *
 * 用假运行时端口 + 临时目录 + 合成文稿驱动真实主进程模块（store/artifacts/inspection/
 * service/attempt runner/runtime adapter），不启动 pi 进程、不联网、不调模型。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInlineInspectionWorkerFactory } from "./helpers/inspectionWorkerStub.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-"));
	const userData = join(root, "userData");
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
	};
	const port = {
		readRuntime: async (sessionId) =>
			sessionId === SESSION_ID
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

test("首次实际提交建立记录；空模式不建记录，重复提交幂等", async () => {
	const harness = createHarness();
	try {
		const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
		const request = { sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" };
		const first = await harness.domain.service.createWork({ requestId: "req-1", ...request });
		assert.equal(first.ok, true);
		const again = await harness.domain.service.createWork({ requestId: "req-2", ...request, title: "另一份" });
		assert.equal(again.value.workId, first.value.workId, "一个会话只有一件工作");
		const replay = await harness.domain.service.createWork({ requestId: "req-1", ...request });
		assert.equal(replay.value.workId, first.value.workId);
		const conflict = await harness.domain.service.createWork({ requestId: "req-1", ...request, outputRootId: "or_other" });
		assert.equal(conflict.ok, false);
		assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
		// 另一个会话没有可读的运行时消息，因此不满足「明确文稿任务」门禁：拒绝而不是建工作。
		const otherSession = await harness.domain.service.createWork({ requestId: "req-3", ...request, sessionId: "session-b", sourceTurnId: "turn-9" });
		assert.equal(otherSession.ok, false);
		const missingRoot = await harness.domain.service.createWork({ requestId: "req-4", ...request, sessionId: "session-c", outputRootId: "or_missing" });
		assert.equal(missingRoot.ok, false);
	} finally {
		await harness.cleanup();
	}
});

test("同一 requestId 并发创建只产生一件工作（去重锁覆盖读取→动作→回执）", async () => {
	const harness = createHarness();
	try {
		const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
		const request = { requestId: "req-same", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" };
		const results = await Promise.all(Array.from({ length: 4 }, () => harness.domain.service.createWork({ ...request })));
		assert.equal(
			results.every((result) => result.ok),
			true,
		);
		assert.equal(new Set(results.map((result) => result.value.workId)).size, 1, "并发同 requestId 只能有一件工作");
		const workFolder = readdirSync(harness.outputRoot).filter((name) => name.startsWith("dw_"));
		assert.equal(workFolder.length, 1, "磁盘上也只能有一个工作目录");
	} finally {
		await harness.cleanup();
	}
});

test("新建全链路：准备冻结 → 绑定扩展 → 分发批准 → 稳定完成后归档并检查", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);
		assert.equal(prepared.value.workRevision, view.revision + 1);

		// 开始时刻必须空闲：忙碌时服务会直接拒绝，避免把本轮插到别的运行前面。
		const started = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.ok, true, JSON.stringify(started));
		assert.equal(started.value.phase, "running");
		assert.equal(started.value.extensionBound, true, "绑定必须由扩展确认后才算完成");
		assert.deepEqual(
			harness.state.dispatched.map((message) => message.split(" ").slice(0, 2).join(" ")),
			["/tpa-work bind", "/align approve"],
			"绑定必须先于批准分发",
		);
		assert.equal(started.value.authorizationState, "pending", "RPC 接受不等于批准完成");

		await harness.finishRound("# 季度报告\n\n正文\n");
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 1);
		assert.equal(finalView.versions[0].inspection, "passed");
		assert.equal(finalView.versions[0].ordinal, 1);
		assert.equal(finalView.revisionReady, true);
		assert.equal(finalView.active, null);
		const workFolder = readdirSync(harness.outputRoot).find((name) => name.startsWith("dw_"));
		assert.equal(readdirSync(join(harness.outputRoot, workFolder, "versions", "v0001")).includes("report.md"), true);
		assert.equal(readdirSync(join(harness.outputRoot, workFolder, "staging")).length, 0, "本轮 staging 结算后清空");
		assert.equal(
			harness.changes.some((event) => event.changeKind === "archived"),
			true,
		);
	} finally {
		await harness.cleanup();
	}
});

test("缺少可确认的对齐版本、运行时换代或身份不符时都拒绝开始", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment({ phase: "clarifying" });
		const notReady = await prepareCreate(harness, view);
		assert.equal(notReady.error.code, "APPROVAL_REQUIRED");

		harness.alignment({ revision: 7 });
		assert.equal((await prepareCreate(harness, view)).error.code, "PREPARATION_STALE", "要求版本不匹配时准备失效");

		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);
		const wrongApproval = await startRound(harness, view, prepared, "req-start-2", { kind: "alignment_confirmation", briefId: "brief-other", revision: 2 });
		assert.equal(wrongApproval.error.code, "APPROVAL_REQUIRED");
		// 运行时换代：准备里的三元组与当前不一致时不能用旧准备开始。
		harness.state.generation = 2;
		const stale = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(stale.error.code, "RUNTIME_CHANGED");
	} finally {
		await harness.cleanup();
	}
});

test("运行时忙碌与在途分发期间不允许开始，也不允许并发第二轮", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const started = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.ok, true);
		const activeView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const second = await harness.domain.service.prepare({ requestId: "req-prepare-2", workId: view.workId, expectedRevision: activeView.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 }, scope: { summary: "s", sections: [], preserve: [] }, materialPaths: [] });
		assert.equal(second.error.code, "RUNTIME_BUSY", "同一工作单次只允许一个在途操作");
		harness.runtime.busy();
		const busyStart = await harness.domain.service.start({ requestId: "req-start-2", workId: view.workId, expectedRevision: activeView.revision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.notEqual(busyStart.ok, true, "运行时忙碌时不得开始新一轮");
	} finally {
		await harness.cleanup();
	}
});

test("扩展未确认绑定时分发落失败，不会悄悄往下走批准", async () => {
	const harness = createHarness({ bindTimeoutMs: 200 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		harness.state.bindingAck = false;
		const started = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.error.code, "EXTENSION_UNAVAILABLE");
		assert.equal(
			harness.state.dispatched.some((message) => message.startsWith("/align approve")),
			false,
			"绑定未确认时绝不分发批准",
		);
		const operation = await harness.domain.service.getOperation(view.workId, "req-start", SESSION_ID);
		assert.equal(operation.value.phase, "failed");
		assert.equal(operation.value.extensionBound, false);
	} finally {
		await harness.cleanup();
	}
});

test("材料在准备后变化时判为准备失效，未授权材料路径被拒绝", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		const materialPath = join(harness.workspace, "materials.docx");
		writeFileSync(materialPath, "第一版材料", "utf8");
		harness.state.allowedMaterials.add(materialPath);
		harness.alignment();
		const rejected = await harness.domain.service.prepare({
			requestId: "req-prepare-x",
			workId: view.workId,
			expectedRevision: view.revision,
			kind: "create_document",
			requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
			scope: { summary: "s", sections: [], preserve: [] },
			materialPaths: [join(harness.workspace, "not-picked.docx")],
		});
		assert.equal(rejected.error.code, "PATH_DENIED");
		const prepared = await harness.domain.service.prepare({
			requestId: "req-prepare",
			workId: view.workId,
			expectedRevision: view.revision,
			kind: "create_document",
			requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
			scope: { summary: "s", sections: [], preserve: [] },
			materialPaths: [materialPath],
		});
		assert.equal(prepared.ok, true);
		writeFileSync(materialPath, "第二版材料", "utf8");
		const started = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.error.code, "PREPARATION_STALE");
	} finally {
		await harness.cleanup();
	}
});

test("改稿：用户指令授权可开始，另存新版且同一轮指令不能重复授权", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
		await harness.finishRound("# 季度报告\n\n第一版正文\n");
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		// 声明要保留的块保持原样，只改别的部分 → 归档通过。
		const revisionPrepare = await prepareRevision(harness, afterArchive, ["季度报告"], "req-prepare-r1");
		assert.equal(revisionPrepare.ok, true, JSON.stringify(revisionPrepare));
		const revisionStart = await startRound(harness, view, revisionPrepare, "req-start-r1", { kind: "revision_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH });
		assert.equal(revisionStart.ok, true, JSON.stringify(revisionStart));
		assert.equal(revisionStart.value.authorizationState, "confirmed");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length, 1, "改稿轮不重复分发对齐批准");
		await harness.finishRound("# 季度报告\n\n第一版正文\n\n# 附注\n\n新增附注\n");
		assert.equal((await harness.terminal(view.workId, "req-start-r1")).phase, "archived");

		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2);
		assert.equal(finalView.versions[0].ordinal, 2, "新版本另存而不覆盖旧版");

		// 同一轮指令再来一次必须被拒。
		const replay = await prepareRevision(harness, finalView, [], "req-prepare-r2");
		assert.equal(replay.ok, true);
		const replayedStart = await startRound(harness, view, replay, "req-start-r2", { kind: "revision_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH });
		assert.equal(replayedStart.error.code, "APPROVAL_REQUIRED");
	} finally {
		await harness.cleanup();
	}
});

test("显式改稿轮：Pi 正忙时不插队，本轮结束后同一 runtime 绑定并只派发一次改稿提示", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		await harness.finishRound("# 季度报告\n\n第一版正文\n");
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);

		// 用户就是在普通聊天里提要求的：Pi 此刻是忙的，本轮不得插队。
		harness.runtime.busy();
		const startedAt = harness.state.dispatched.length;
		// 本轮只改正文、不声明保留块：这里要验证的是排队与派发顺序，逐块保留另有专门用例。
		const revisionPrepare = await prepareRevision(harness, afterArchive, [], "req-prepare-r1", ["季度报告"]);
		assert.equal(revisionPrepare.ok, true, JSON.stringify(revisionPrepare));
		const revisionStart = await startRound(harness, view, revisionPrepare, "req-start-r1", { kind: "revision_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH });
		assert.equal(revisionStart.ok, true, JSON.stringify(revisionStart));
		assert.equal(harness.state.dispatched.length, startedAt, "运行时忙时不得立刻绑定或派发");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length, 1, "改稿轮不得重复分发对齐批准");

		// 本轮稳定结束后：绑定 + 一次实际改稿提示。
		harness.runtime.settle();
		await waitFor(() => harness.state.dispatched.some((message) => message.startsWith("改稿要求：")));
		const revisionPrompts = harness.state.dispatched.filter((message) => message.startsWith("改稿要求："));
		assert.equal(revisionPrompts.length, 1, "只允许一次实际改稿提示");
		assert.match(revisionPrompts[0], /改稿要求/, "提示必须说明这是改稿轮");

		await harness.finishRound("# 季度报告\n\n第二版正文\n");
		const operation = await harness.terminal(view.workId, "req-start-r1");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2, "改稿产出新版本而不是覆盖");
		assert.equal(finalView.versions[0].ordinal, 2);
	} finally {
		await harness.cleanup();
	}
});

test("改稿动到声明要保留的块时检查失败：版本保留但不成为合格基稿", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		await harness.finishRound("# 季度报告\n\n原始结论\n");
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);

		const revisionPrepare = await prepareRevision(harness, afterArchive, ["季度报告"], "req-prepare-r1");
		assert.equal(revisionPrepare.ok, true, JSON.stringify(revisionPrepare));
		await startRound(harness, view, revisionPrepare, "req-start-r1", { kind: "revision_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH });
		await harness.finishRound("# 季度报告\n\n被偷偷改掉的结论\n");
		const operation = await harness.terminal(view.workId, "req-start-r1");
		assert.equal(operation.phase, "failed", JSON.stringify(operation));
		assert.equal(operation.error.code, "INSPECTION_UNVERIFIED");
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2, "失败版本保留，不删除也不覆盖");
		assert.equal(finalView.versions[0].inspection, "failed");
		assert.equal(finalView.revisionReady, true, "合格基稿仍是上一版");
	} finally {
		await harness.cleanup();
	}
});

test("取消只针对本轮：带 attemptId 与三元组校验，取消后不留活动操作", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
		const withActive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const wrongAttempt = await harness.domain.service.cancel({ requestId: "req-cancel", workId: view.workId, expectedRevision: withActive.revision, attemptId: "at_other", expectedRuntime: harness.runtime.target() });
		assert.equal(wrongAttempt.error.code, "CANCEL_NOT_APPLICABLE");
		const wrongRuntime = await harness.domain.service.cancel({ requestId: "req-cancel", workId: view.workId, expectedRevision: withActive.revision, attemptId: withActive.active.attemptId, expectedRuntime: { ...harness.runtime.target(), runtimeGeneration: 99 } });
		assert.equal(wrongRuntime.error.code, "RUNTIME_CHANGED");
		const cancelled = await harness.domain.service.cancel({ requestId: "req-cancel", workId: view.workId, expectedRevision: withActive.revision, attemptId: withActive.active.attemptId, expectedRuntime: harness.runtime.target() });
		assert.equal(cancelled.ok, true);
		assert.equal(harness.state.aborted.length, 1);
		const afterCancel = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(afterCancel.active, null);
		assert.equal(afterCancel.versions.length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("进程重启结算：在途操作落 interrupted，重启后不自动重放", async () => {
	const harness = createHarness({ settleTimeoutMs: 60_000 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const started = await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.ok, true, JSON.stringify(started));
		await harness.domain.dispose();
		const revived = createDocumentWorkDomain({
			userDataPath: join(harness.root, "userData"),
			runtimePort: {
				readRuntime: async () => undefined,
				dispatch: async () => ({ accepted: true, unknown: false }),
				abort: async () => ({ accepted: true, unknown: false }),
				hasDispatchInFlight: () => false,
				subscribeOutputs: () => () => {},
				subscribePiEvents: () => () => {},
			},
			materials: { isAllowed: async () => false },
			onChanged: () => {},
			logger: { info: () => {}, warn: () => {} },
		});
		try {
			await revived.service.recoverOnStartup();
			const operation = await revived.service.getOperation(view.workId, "req-start", SESSION_ID);
			assert.equal(operation.value.phase, "interrupted");
			const recoveredView = plain((await revived.service.getView(view.workId, SESSION_ID)).value);
			assert.equal(recoveredView.active, null, "恢复后不留活动操作");
			assert.equal(recoveredView.versions.length, 0, "未归档的操作不得凭空产生版本");
		} finally {
			await revived.dispose();
		}
	} finally {
		await harness.cleanup();
	}
});

test("分发被接受但运行时仍是旧 idle 时不得立即结算：必须等本轮真正开始并稳定完成", async () => {
	const harness = createHarness({ startTimeoutMs: 500 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
		// 批准刚接受，运行时还是旧 idle：这一步绝不能收出空版本。
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal((await harness.domain.service.getView(view.workId, SESSION_ID)).value.versions.length, 0, "旧 idle 不得直接结算");
		assert.equal((await harness.domain.service.getView(view.workId, SESSION_ID)).value.active.phase, "running", "操作仍在运行中");

		await harness.finishRound("# 季度报告\n\n正文\n");
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 1);
		assert.equal(finalView.versions[0].inspection, "passed");
	} finally {
		await harness.cleanup();
	}
});

test("分发被接受但本轮从未开始（既没运行也没汇报）→ 记 unknown，不自动重放", async () => {
	const harness = createHarness({ startTimeoutMs: 300 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
		const operation = await harness.terminal(view.workId, "req-start", 3_000);
		assert.equal(operation.phase, "unknown");
		assert.equal(operation.error.detail, "run_not_observed");
		// 只发过一次绑定与一次批准（结算后另有一次 release，不带任何执行）。
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/tpa-work bind ")).length, 1, "绑定只发一次");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length, 1, "批准只发一次");
	} finally {
		await harness.cleanup();
	}
});

test("归档防覆盖：版本目录排他新建，被占用的序号不复用", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const first = await prepareCreate(harness, view);
		await startRound(harness, view, first, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		await harness.finishRound("# 季度报告\n\n第一版\n");
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
		const workFolder = readdirSync(harness.outputRoot).find((name) => name.startsWith("dw_"));
		// 人为占用 v0002，验证排他创建跳到下一个序号而不是覆盖。
		mkdirSync(join(harness.outputRoot, workFolder, "versions", "v0002"));
		const afterFirst = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const second = await prepareRevision(harness, afterFirst, [], "req-prepare-r1", ["季度报告"]);
		assert.equal(second.ok, true);
		await startRound(harness, view, second, "req-start-r1", { kind: "revision_instruction", sourceTurnId: latestUserTurnId(harness), sourceTurnHash: TURN_HASH });
		await harness.finishRound("# 季度报告\n\n第二版内容更长\n");
		const operation = await harness.terminal(view.workId, "req-start-r1");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.deepEqual(
			finalView.versions.map((version) => version.ordinal),
			[3, 1],
			"被占用的 v0002 不得被复用，新版本改用 v0003",
		);
		assert.equal(readdirSync(join(harness.outputRoot, workFolder, "versions", "v0001"))[0], "report.md");
		assert.equal(readdirSync(join(harness.outputRoot, workFolder, "versions", "v0003"))[0], "report.md");
	} finally {
		await harness.cleanup();
	}
});

test("跨接口回归：服务产出的真实绑定载荷能被真实扩展 handler 确认绑定", async () => {
	// 这条是审查明确要求的跨接口负向/修复回归：不看解码器单独绿，而是把 service 实际发出的
	// `/tpa-work bind <payload>` 原文交给扩展注册的 handler，并断言真的产生 bound 确认。
	// 稳定 SessionRecord.id 与 pi 原生会话 id 刻意不同：缺 nativeSessionId 的真实链路必挂。
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const extension = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-work.ts`, { stubs: { typebox: require("typebox") } }).default;
	const harness = createHarness();
	try {
		const bound = [];
		const commands = new Map();
		let branch = [];
		const ctx = {
			hasUI: false,
			mode: "rpc",
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: { notify: (message) => bound.push({ kind: "notify", message }) },
			sessionManager: { getSessionId: () => NATIVE_SESSION_ID, getBranch: () => [...branch] },
		};
		extension({
			on: () => {},
			registerCommand: (name, value) => commands.set(name, value),
			registerTool: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
			sendMessage: (message) => {
				branch.push({ type: "custom_message", ...message });
				if (message.details?.documentWork) bound.push(message.details.documentWork);
			},
		});

		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true, JSON.stringify(prepared));
		assert.equal((await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 })).ok, true);
		const bind = harness.state.dispatched.find((message) => message.startsWith("/tpa-work bind "));
		assert.ok(bind, "本轮必须发出绑定命令");

		let handlerError = "";
		try {
			await commands.get("tpa-work").handler(bind.slice("/tpa-work ".length), ctx);
		} catch (error) {
			handlerError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
		const confirmed = bound.find((entry) => entry.phase === "bound");
		assert.ok(confirmed, `真实扩展必须确认绑定（回执：${JSON.stringify(bound)}；错误：${handlerError}）`);
		// 发布的状态快照报告稳定工作身份；原生身份落在持久化的绑定条目里。
		assert.equal(confirmed.sessionId, SESSION_ID, "状态快照报告稳定会话 id");
		const boundEntry = branch.find((entry) => entry.customType === "tpa-document-work-binding");
		assert.ok(boundEntry, "绑定必须落盘到活动分支");
		assert.equal(boundEntry.data.sessionId, NATIVE_SESSION_ID, "分支条目按原生会话 id 归属");
		assert.equal(boundEntry.data.binding.nativeSessionId, NATIVE_SESSION_ID);
		assert.notEqual(boundEntry.data.binding.sessionId, boundEntry.data.binding.nativeSessionId, "稳定会话 id 与原生 id 必须不同");
		// 负向：把载荷里的原生 id 换成别的会话，同一条链路必须被拒。
		const payload = shared.decodeBindingPayload(bind.slice("/tpa-work bind ".length));
		const tampered = shared.encodeBindingPayload({ ...payload, nativeSessionId: "pi-native-session-other" });
		bound.length = 0;
		await commands.get("tpa-work").handler(`bind ${tampered}`, ctx);
		assert.equal(bound.filter((entry) => entry.phase === "bound").length, 0, "跨会话载荷不得产生 bound 确认");
		assert.equal(
			bound.some((entry) => entry.kind === "notify"),
			true,
			"跨会话载荷必须显式拒绝并告知用户",
		);
	} finally {
		await harness.cleanup();
	}
});
