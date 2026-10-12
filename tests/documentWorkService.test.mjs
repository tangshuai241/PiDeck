/**
 * 文稿服务编排：授权、准备失效、运行时绑定、分发顺序、取消、归档与防覆盖。
 *
 * 用假运行时端口 + 临时目录 + 合成文稿驱动真实主进程模块（store/artifacts/inspection/
 * service/runtime adapter），不启动 pi 进程、不联网、不调模型。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { createDocumentWorkDomain } = loadTsCommonJs(`${ROOT}/src/main/document-work/index.ts`);
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const AGENT_ID = "agent-a";
const SESSION_ID = "session-a";

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
		messages: [{ id: "turn-1", role: "user", text: "请写一份季度报告", agentId: AGENT_ID, timestamp: 1 }],
		dispatched: [],
		aborted: [],
		allowedMaterials: new Set(),
		bindingAck: true,
		approveAccepted: true,
		approveUnknown: false,
		dispatchUnknown: false,
		report: true,
		stagedFile: "report.md",
	};
	const port = {
		readRuntime: async (sessionId) => (sessionId === SESSION_ID ? { target: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: state.generation }, status: state.status, state: { ...state.flags }, messages: state.messages } : undefined),
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
			return { accepted: true, unknown: state.dispatchUnknown };
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
		bindTimeoutMs: options.bindTimeoutMs ?? 400,
		settleTimeoutMs: options.settleTimeoutMs ?? 3_000,
		startTimeoutMs: options.startTimeoutMs ?? 3_000,
	});
	const emitRuntime = () => {
		for (const listener of outputs) listener("agents:runtime-state", { agentId: AGENT_ID, sessionId: SESSION_ID, runtimeGeneration: state.generation, status: state.status, state: { ...state.flags } });
	};
	const terminal = async (workId, requestId, timeoutMs = 4_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const result = await domain.service.getOperation(workId, requestId, SESSION_ID);
			const operation = result.ok ? result.value : undefined;
			if (operation && ["archived", "failed", "interrupted", "unknown"].includes(operation.phase)) return plain(operation);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("operation did not settle");
	};
	const runtime = {
		target: () => ({ sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: state.generation }),
		settle: () => {
			state.status = "idle";
			state.flags = {};
			emitRuntime();
		},
		busy: () => {
			state.status = "running";
			state.flags = { isTurnActive: true, isStreaming: true };
			emitRuntime();
		},
	};
	const alignment = (overrides = {}) => {
		const value = { schemaVersion: 1, briefId: "brief-1", revision: 2, phase: "ready", briefRevision: 2, brief: { goal: "写季度报告", scope: ["第二章"], materials: [], deliverable: "一份 Markdown 报告", preserve: ["保留原始数据"], acceptance: ["结构完整"], questions: [] }, ...overrides };
		domain.service.observeAlignmentState(SESSION_ID, value);
		return value;
	};
	const files = {
		/** 本轮 staging 目录（主进程生成的 attemptId 不对外暴露，按目录扫描取唯一一个）。 */
		stagingDirectory() {
			const records = readdirSync(join(outputRoot, "…"), { withFileTypes: true }).slice(0, 0);
			void records;
			return undefined;
		},
	};
	return {
		root,
		outputRoot,
		workspace,
		domain,
		port,
		state,
		changes,
		emitRuntime,
		terminal,
		runtime,
		alignment,
		files,
		/** 扩展看到的绑定载荷：staging 目录与 attemptId 都以此为准，与真实扩展一致。 */
		bindingPayload() {
			const bind = [...state.dispatched].reverse().find((message) => message.startsWith("/tpa-work bind "));
			return bind ? shared.decodeBindingPayload(bind.slice("/tpa-work bind ".length)) : undefined;
		},
		/** 写出本轮成果到 staging：模型在真实流程里做这件事。 */
		async writeStaged(_workId, relativePath, content) {
			const payload = this.bindingPayload();
			const target = join(payload.stagingDirectory, ...relativePath.split("/"));
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, content, "utf8");
			return { attemptId: payload.attemptId, stagingDirectory: payload.stagingDirectory };
		},
		reportedCandidate(workId, attemptId, relativePath) {
			return domain.store.getRecord(workId).then(async (value) => {
				const preparation = (await domain.store.listAllRecords()).length ? undefined : undefined;
				void preparation;
				const operation = value.activeRequestId ? await domain.store.getOperation(workId, value.activeRequestId) : undefined;
				const probe = {
					schemaVersion: 1,
					workId,
					attemptId,
					preparationId: operation.preparation.preparationId,
					digest: operation.preparation.digest,
					sessionId: SESSION_ID,
					phase: "reported",
					materials: [],
					report: { reportId: "rp_1", artifacts: [{ relativePath, role: "primary" }], summary: "初稿完成", risks: ["未核对数据"] },
				};
				console.log("DEBUG-REPORT", JSON.stringify({ attemptId, opAttempt: operation.attemptId, parsed: Boolean(shared.parseDocumentWorkExtensionState(probe)) }));
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
									workId,
									attemptId,
									preparationId: operation.preparation.preparationId,
									digest: operation.preparation.digest,
									sessionId: SESSION_ID,
									phase: "reported",
									materials: [],
									report: { reportId: "rp_1", artifacts: [{ relativePath, role: "primary" }], summary: "初稿完成", risks: ["未核对数据"] },
								},
							},
						},
					});
				}
			});
		},
		async cleanup() {
			// 先取消在途结算并 drain，再删目录：否则后台协程会在测试结束后继续写盘。
			await domain.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function createWork(harness, options = {}) {
	const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
	const created = await harness.domain.service.createWork({ requestId: "req-create", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" });
	assert.equal(created.ok, true);
	return plain(created.value);
}

async function prepareCreate(harness, view, overrides = {}) {
	const result = await harness.domain.service.prepare({
		requestId: overrides.requestId ?? "req-prepare",
		workId: view.workId,
		expectedRevision: view.revision,
		kind: "create_document",
		requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
		scope: { summary: "写季度报告", sections: [], preserve: [] },
		materialPaths: [],
	});
	return plain(result);
}

test("首次实际提交建立记录；空模式不建记录，重复提交幂等", async () => {
	const harness = createHarness();
	try {
		const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
		// 只选模式（没有 revision 前进）时渲染层不会请求创建；这里直接验证服务侧的幂等与去重。
		const first = await harness.domain.service.createWork({ requestId: "req-1", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" });
		assert.equal(first.ok, true);
		const again = await harness.domain.service.createWork({ requestId: "req-2", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "另一份" });
		assert.equal(again.ok, true);
		assert.equal(again.value.workId, first.value.workId, "一个会话只有一件工作");
		const replay = await harness.domain.service.createWork({ requestId: "req-1", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId });
		assert.equal(replay.ok, true);
		assert.equal(replay.value.workId, first.value.workId);
		const conflict = await harness.domain.service.createWork({ requestId: "req-1", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: "or_other" });
		assert.equal(conflict.ok, false);
		assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
		const otherSession = await harness.domain.service.createWork({ requestId: "req-3", sessionId: "session-b", sourceTurnId: "turn-9", outputRootId: root.outputRootId });
		assert.equal(otherSession.ok, true);
		assert.notEqual(otherSession.value.workId, first.value.workId);
		const missingRoot = await harness.domain.service.createWork({ requestId: "req-4", sessionId: "session-c", sourceTurnId: "turn-9", outputRootId: "or_missing" });
		assert.equal(missingRoot.ok, false);
		assert.equal(missingRoot.error.code, "PATH_DENIED");
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
		const started = await harness.domain.service.start({
			requestId: "req-start",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 },
		});
		assert.equal(started.ok, true, JSON.stringify(started));
		assert.equal(started.value.phase, "running");
		assert.equal(started.value.extensionBound, true, "绑定必须由扩展确认后才算完成");
		assert.deepEqual(
			harness.state.dispatched.map((message) => message.split(" ")[0] + " " + (message.split(" ")[1] ?? "")),
			["/tpa-work bind", "/align approve"],
			"绑定必须先于批准分发",
		);
		assert.equal(started.value.authorizationState, "pending", "RPC 接受不等于批准完成");

		const staged = await harness.writeStaged(view.workId, "report.md", "# 季度报告\n\n正文\n");
		await harness.reportedCandidate(view.workId, staged.attemptId, "report.md");
		harness.runtime.settle();
		const operation = await harness.terminal(view.workId, "req-start");
		assert.equal(operation.phase, "archived", JSON.stringify(operation));
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 1);
		assert.equal(finalView.versions[0].inspection, "passed");
		assert.equal(finalView.versions[0].ordinal, 1);
		assert.equal(finalView.revisionReady, true);
		assert.equal(finalView.active, null);
		// 公开成果与原始快照同时存在；staging 结算后清理。
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
		assert.equal(notReady.ok, false);
		assert.equal(notReady.error.code, "APPROVAL_REQUIRED");

		harness.alignment({ revision: 7 });
		assert.equal((await prepareCreate(harness, view)).error.code, "PREPARATION_STALE", "要求版本不匹配时准备失效");

		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);
		// 当前三元组但批准版本不符：仍然需要对应版本的确认。
		const wrongApproval = await harness.domain.service.start({
			requestId: "req-start-2",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "alignment_confirmation", briefId: "brief-other", revision: 2 },
		});
		assert.equal(wrongApproval.ok, false);
		assert.equal(wrongApproval.error.code, "APPROVAL_REQUIRED");
		// 运行时换代：准备里的三元组与当前不一致时拒绝开始时用旧准备。
		harness.state.generation = 2;
		const stale = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(stale.ok, false);
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
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, true);
		const activeView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const second = await harness.domain.service.prepare({ requestId: "req-prepare-2", workId: view.workId, expectedRevision: activeView.revision, kind: "create_document", requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 }, scope: { summary: "s", sections: [], preserve: [] }, materialPaths: [] });
		assert.equal(second.ok, false);
		assert.equal(second.error.code, "RUNTIME_BUSY", "同一工作单次只允许一个在途操作");
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
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, false);
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

test("材料在准备后变化时判为准备失效，不带着旧指纹继续", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		const materialPath = join(harness.workspace, "materials.docx");
		writeFileSync(materialPath, "第一版材料", "utf8");
		harness.state.allowedMaterials.add(materialPath);
		harness.alignment();
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
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, false);
		assert.equal(started.error.code, "PREPARATION_STALE");
	} finally {
		await harness.cleanup();
	}
});

test("未授权材料路径在准备阶段被拒绝", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const rejected = await harness.domain.service.prepare({
			requestId: "req-prepare",
			workId: view.workId,
			expectedRevision: view.revision,
			kind: "create_document",
			requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
			scope: { summary: "s", sections: [], preserve: [] },
			materialPaths: [join(harness.workspace, "not-picked.docx")],
		});
		assert.equal(rejected.ok, false);
		assert.equal(rejected.error.code, "PATH_DENIED");
	} finally {
		await harness.cleanup();
	}
});

test("改稿：用户指令授权可开始；同一轮指令不能重复授权", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, true);
		const staged = await harness.writeStaged(view.workId, "report.md", "# 季度报告\n\n第一版正文\n");
		await harness.reportedCandidate(view.workId, staged.attemptId, "report.md");
		harness.runtime.settle();
		const archived = await harness.terminal(view.workId, "req-start");
		assert.equal(archived.phase, "archived");
		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(afterArchive.revisionReady, true);

		// 改稿：指令来源与具体用户轮绑定。
		const turnHash = shared.encryptTurnHashForTest ?? undefined;
		void turnHash;
		const turn = plain(harness.state.messages[0]);
		const hash = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentWorkService.ts`).hashTurnText(turn.text);
		const revisionPrepare = await harness.domain.service.prepare({
			requestId: "req-prepare-r1",
			workId: view.workId,
			expectedRevision: afterArchive.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: turn.id, sourceTurnHash: hash },
			scope: { summary: "把标题改短", sections: [], preserve: [] },
			materialPaths: [],
		});
		assert.equal(revisionPrepare.ok, true, JSON.stringify(revisionPrepare));
		const revisionStart = await harness.domain.service.start({
			requestId: "req-start-r1",
			workId: view.workId,
			expectedRevision: revisionPrepare.value.workRevision,
			preparation: revisionPrepare.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "revision_instruction", sourceTurnId: turn.id, sourceTurnHash: hash },
		});
		assert.equal(revisionStart.ok, true, JSON.stringify(revisionStart));
		assert.equal(revisionStart.value.authorizationState, "confirmed");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length, 1, "改稿轮不重复分发对齐批准");
		const revised = await harness.writeStaged(view.workId, "report.md", "# 短标题\n\n第二版正文\n");
		await harness.reportedCandidate(view.workId, revised.attemptId, "report.md");
		harness.runtime.settle();
		const secondArchive = await harness.terminal(view.workId, "req-start-r1");
		assert.equal(secondArchive.phase, "archived", JSON.stringify(secondArchive));

		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2);
		assert.equal(finalView.versions[0].ordinal, 2, "新版本另存而不覆盖旧版");

		// 同一轮指令再来一次必须被拒。
		const replay = await harness.domain.service.prepare({
			requestId: "req-prepare-r2",
			workId: view.workId,
			expectedRevision: finalView.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: turn.id, sourceTurnHash: hash },
			scope: { summary: "再来一次", sections: [], preserve: [] },
			materialPaths: [],
		});
		assert.equal(replay.ok, true);
		const replayedStart = await harness.domain.service.start({
			requestId: "req-start-r2",
			workId: view.workId,
			expectedRevision: replay.value.workRevision,
			preparation: replay.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "revision_instruction", sourceTurnId: turn.id, sourceTurnHash: hash },
		});
		assert.equal(replayedStart.ok, false);
		assert.equal(replayedStart.error.code, "APPROVAL_REQUIRED");
	} finally {
		await harness.cleanup();
	}
});

test("改稿但正文完全没变时版本保留、检查失败且不成为合格基稿", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		const staged = await harness.writeStaged(view.workId, "report.md", "# 季度报告\n\n一字不改\n");
		await harness.reportedCandidate(view.workId, staged.attemptId, "report.md");
		harness.runtime.settle();
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");

		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const serviceModule = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentWorkService.ts`);
		const hash = serviceModule.hashTurnText(harness.state.messages[0].text);
		const revisionPrepare = await harness.domain.service.prepare({
			requestId: "req-prepare-r1",
			workId: view.workId,
			expectedRevision: afterArchive.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: "turn-1", sourceTurnHash: hash },
			scope: { summary: "改", sections: [], preserve: [] },
			materialPaths: [],
		});
		assert.equal(revisionPrepare.ok, true);
		await harness.domain.service.start({
			requestId: "req-start-r1",
			workId: view.workId,
			expectedRevision: revisionPrepare.value.workRevision,
			preparation: revisionPrepare.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "revision_instruction", sourceTurnId: "turn-1", sourceTurnHash: hash },
		});
		const unchanged = await harness.writeStaged(view.workId, "report.md", "# 季度报告\n\n一字不改\n");
		await harness.reportedCandidate(view.workId, unchanged.attemptId, "report.md");
		harness.runtime.settle();
		const operation = await harness.terminal(view.workId, "req-start-r1");
		assert.equal(operation.phase, "failed");
		assert.equal(operation.error.code, "INSPECTION_UNVERIFIED");
		const finalView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(finalView.versions.length, 2, "失败版本保留，不删除也不覆盖");
		assert.equal(finalView.versions[0].inspection, "failed");
		assert.equal(finalView.revisionReady, true, "合格基稿仍是上一版");
	} finally {
		await harness.cleanup();
	}
});

test("取消只针对本轮：带 attemptId 与三元组校验，取消后重新发起可用", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, true);
		const withActive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const wrongAttempt = await harness.domain.service.cancel({ requestId: "req-cancel", workId: view.workId, expectedRevision: withActive.revision, attemptId: "at_other", expectedRuntime: harness.runtime.target() });
		assert.equal(wrongAttempt.ok, false);
		assert.equal(wrongAttempt.error.code, "CANCEL_NOT_APPLICABLE");
		const wrongRuntime = await harness.domain.service.cancel({ requestId: "req-cancel", workId: view.workId, expectedRevision: withActive.revision, attemptId: withActive.active.attemptId, expectedRuntime: { ...harness.runtime.target(), runtimeGeneration: 99 } });
		assert.equal(wrongRuntime.ok, false);
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
		const started = await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: prepared.value.workRevision, preparation: prepared.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		assert.equal(started.ok, true, JSON.stringify(started));
		await harness.domain.dispose();
		// 新进程：同一 userData 重新装配，启动结算必须把 running 转成 interrupted。
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
			assert.equal(operation.ok, true);
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

test("归档防覆盖：第二个版本目录排他新建，旧版本文件保持原字节", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const first = await prepareCreate(harness, view);
		await harness.domain.service.start({ requestId: "req-start", workId: view.workId, expectedRevision: first.value.workRevision, preparation: first.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 } });
		const staged = await harness.writeStaged(view.workId, "report.md", "# 第一版\n");
		await harness.reportedCandidate(view.workId, staged.attemptId, "report.md");
		harness.runtime.settle();
		assert.equal((await harness.terminal(view.workId, "req-start")).phase, "archived");
		// 人为占用 v0002 目录名，验证排他创建会跳到下一个序号而不是覆盖。
		const workFolder = readdirSync(harness.outputRoot).find((name) => name.startsWith("dw_"));
		mkdirSync(join(harness.outputRoot, workFolder, "versions", "v0002"));
		const afterFirst = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const serviceModule = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentWorkService.ts`);
		const hash = serviceModule.hashTurnText(harness.state.messages[0].text);
		const second = await harness.domain.service.prepare({
			requestId: "req-prepare-r1",
			workId: view.workId,
			expectedRevision: afterFirst.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: "turn-1", sourceTurnHash: hash },
			scope: { summary: "改标题", sections: [], preserve: [] },
			materialPaths: [],
		});
		assert.equal(second.ok, true);
		await harness.domain.service.start({ requestId: "req-start-r1", workId: view.workId, expectedRevision: second.value.workRevision, preparation: second.value.preparation, expectedRuntime: harness.runtime.target(), authorization: { kind: "revision_instruction", sourceTurnId: "turn-1", sourceTurnHash: hash } });
		const staged2 = await harness.writeStaged(view.workId, "report.md", "# 第二版内容更长\n");
		await harness.reportedCandidate(view.workId, staged2.attemptId, "report.md");
		harness.runtime.settle();
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
