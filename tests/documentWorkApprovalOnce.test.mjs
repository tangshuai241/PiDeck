/**
 * 批准只发一次 + 普通 Plan 不被文稿流程阻断。
 *
 * 审查修正项 1（含协调者补充的双重批准）：文稿轮次的 `/align approve` **只由主进程发一次**，
 * 前端在 `handled` 分支不再发原生批准；普通开发（重构代码、修 bug、解释材料）走原生批准
 * 一次，且不产生任何文稿 create/prepare/start、不要求成果目录。
 *
 * 这里用的是**生产 hook**（`useSessionDocumentWork` + `useSessionAlignmentControls`）、
 * 生产 service/dispatcher、以及**真实扩展 handler**：主进程的批准经 `sendControl` 真发出去，
 * 渲染层的批准经 `sessions.sendPrompt` 真发出去，两边一起计数——不是只 mock docAPI。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import * as f from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const extension = loadTsCommonJs("resources/extensions/pi-deck-document-work.ts", { stubs: { typebox: require("typebox") } }).default;
const { DocumentWorkStore } = loadTsCommonJs("src/main/document-work/DocumentWorkStore.ts");
const { DocumentWorkService } = loadTsCommonJs("src/main/document-work/DocumentWorkService.ts");
const { DocumentWorkRuntimeAdapter } = loadTsCommonJs("src/main/document-work/DocumentWorkRuntimeAdapter.ts");

const WORD_BRIEF = { goal: "写一份季度复盘报告", scope: ["背景", "结论"], materials: [], deliverable: "季度复盘报告.docx", preserve: [], acceptance: ["覆盖本季度要点"], questions: [] };
const CODING_BRIEF = { goal: "重构 foo.ts 里的解析逻辑并修复登录 bug", scope: ["src/foo.ts"], materials: [], deliverable: "更新后的 foo.ts", preserve: [], acceptance: ["测试通过"], questions: [] };

function extensionHarness() {
	const handlers = new Map();
	const commands = new Map();
	const messages = [];
	const branch = [];
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => undefined },
		sessionManager: { getSessionId: () => f.NATIVE_SESSION, getBranch: () => structuredClone(branch) },
	};
	extension({
		on: (event, callback) => handlers.set(event, callback),
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: () => undefined,
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message) => messages.push({ ...structuredClone(message), role: "custom" }),
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	});
	handlers.get("session_start")({}, ctx);
	return { ctx, messages, command: (args) => commands.get("tpa-work").handler(args, ctx) };
}

/** 主进程侧：真实 store/service/adapter + 假运行时端口；sendControl 直连真实扩展并回灌确认。 */
/** 可控制的批准回执：默认立即成功，测试可以延迟/失败/换代。 */
function deferredAck() {
	let resolveFn;
	let rejectFn;
	const promise = new Promise((resolve, reject) => {
		resolveFn = resolve;
		rejectFn = reject;
	});
	return { promise, resolve: resolveFn, reject: rejectFn };
}

function mainHarness(brief) {
	const storeFs = f.createMemoryWorkFs();
	const pathMemory = f.createMemoryFs({ dirs: ["C:/out", "C:/project", "C:/userData"] });
	let ids = 0;
	const store = new DocumentWorkStore({ dir: "/data", fs: storeFs, now: () => 100, newId: (prefix) => `${prefix}_${++ids}` });
	const runtime = f.createFakeRuntime({ alignment: { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief } });
	const events = f.createFakeEventSource();
	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime.port, events: events.source });
	adapter.start();
	const extensionHarnessInstance = extensionHarness();
	const sends = [];
	runtime.port.sendControl = async (input) => {
		sends.push(input.message);
		// 生产里 pi 会执行批准并让对齐扩展发布 approved；测试在这里同步给渲染层。
		mainHarness.lastDispatch?.(input.message);
		runtime.calls.push({ kind: "sendControl", message: input.message, requestId: input.requestId });
		const bind = /^\/tpa-work bind (\S+)$/.exec(input.message);
		if (bind) {
			await extensionHarnessInstance.command(`bind ${bind[1]}`);
			const published = [...extensionHarnessInstance.messages].reverse().find((message) => message.customType === "tpa-document-work-state");
			if (published) events.emit(runtime.target.agentId, { type: "message_end", sessionId: input.sessionId, runtimeGeneration: input.expectedRuntime.runtimeGeneration, message: published });
		}
		return { accepted: true };
	};
	const service = new DocumentWorkService({
		store,
		runtime: runtime.port,
		adapter,
		archive: { prepareStaging: async () => ({ ok: true, value: { stagingAbsolutePath: "C:/out/work/staging/round" } }), settleAndArchive: async () => ({ state: "archived", versionId: "v0001_x" }) },
		pathFs: pathMemory.fs,
		workRoot: "C:/userData/document-work",
		emit: () => undefined,
		readBaseHeadings: async () => [],
		now: () => 500,
		newId: (prefix) => `${prefix}_x${++ids}`,
		bindAckMs: 40,
	});
	return { store, service, runtime, events, adapter, sends, extensionHarness: extensionHarnessInstance, storeFs, pathMemory };
}

/** 渲染层侧：生产 hook + 真实 service 的 desktopApi 适配；`sessions.sendPrompt` 单独计数。 */
function hookHarness(main, brief, options = {}) {
	const store = createStore();
	// 会话 id 用真实稳定 id：文稿域的 create/recover 都按它归属，否则会读到别人的工作。
	const session = f.STABLE_SESSION;
	const runtimes = atom({ [session]: { agentId: "agent-1", runtimeGeneration: 1, status: "idle", state: { alignment: { schemaVersion: 1, briefId: "brief_1", revision: 3, phase: "ready", brief } } } });
	const keyed = new Map();
	let familyIndex = 0;
	const keyAtom = (key) => {
		if (!keyed.has(key)) keyed.set(key, atom(key.startsWith("runtime:") ? undefined : undefined));
		return keyed.get(key);
	};
	const alignmentHookAtoms = ["pending", "error", "submission", "queue"];
	const docHookAtoms = ["docview", "doctick"];
	const values = {
		get: (key) => (key.startsWith("runtime:") ? store.get(runtimes)[key.slice(8)] : store.get(keyAtom(key))),
		set: (key, value) => (key.startsWith("runtime:") ? store.set(runtimes, { ...store.get(runtimes), [key.slice(8)]: value }) : store.set(keyAtom(key), value)),
	};
	// 让 hook 的 atomFamily 都能拿到稳定 atom：按注册顺序分配命名前缀。
	const familyPrefixes = [...alignmentHookAtoms, ...docHookAtoms];
	const nextPrefix = () => familyPrefixes[familyIndex++] ?? `family${familyIndex}`;
	const atomFamilyStub = (initialize) => {
		const prefix = nextPrefix();
		return (id) => {
			const key = `${prefix}:${id}`;
			if (!keyed.has(key)) keyed.set(key, initialize(id));
			return keyed.get(key);
		};
	};
	const documentCalls = [];
	const rendererSends = [];
	const notices = [];
	// 主进程发出的批准/改稿会让 pi 更新对齐状态，这里把结果回灌给渲染层状态（生产是扩展发布）。
	mainHarness.lastDispatch = (message) => {
		const session = f.STABLE_SESSION;
		const current = values.get(`runtime:${session}`);
		if (!current?.state?.alignment) return;
		if (!message.startsWith("/align approve")) return;
		values.set(`runtime:${session}`, { ...current, state: { alignment: { ...current.state.alignment, phase: "approved" } } });
	};
	const applyRuntimeState = (sessionId, state) => values.set(`runtime:${sessionId}`, { ...values.get(`runtime:${sessionId}`), state });
	const commonStubs = {
		jotai: { atom, createStore, useStore: () => store, useAtomValue: (key) => store.get(key), useSetAtom: (key) => (value) => store.set(key, typeof value === "function" ? value(store.get(key)) : value) },
		"jotai/utils": { atomFamily: atomFamilyStub },
		react: { useCallback: (fn) => fn, useEffect: (fn) => fn(), useRef: (value) => ({ current: value }) },
		"../i18n": { t: (key) => key },
		"../../i18n": { t: (key) => key },
		"../utils/notice": { showNotice: (message) => notices.push(message) },
		"../../utils/notice": { showNotice: (message) => notices.push(message) },
		"../desktopApi": {
			desktopApi: {
				sessions: {
					sendPrompt: async (input) => {
						rendererSends.push(input.message);
						const current = values.get(`runtime:${input.sessionId}`);
						if (input.message.startsWith("/align")) {
							applyRuntimeState(input.sessionId, { alignment: { ...current.state.alignment, phase: input.message.startsWith("/align approve") ? "approved" : "clarifying" } });
						}
						return { accepted: true };
					},
				},
				documentWork: {
					create: async (input) => {
						documentCalls.push("create");
						const digest = `digest_${input.requestId}`;
						return main.store.createWork({ requestId: input.requestId, requestDigest: digest, sessionId: input.sessionId, sourceTurnId: input.sourceTurnId, title: input.title, outputRootId: input.outputRootId });
					},
					get: async (input) => {
						const read = main.store.readWork(input.workId);
						if ("error" in read) return read;
						const root = read.value.record.outputRootId ? main.store.getOutputRoot(read.value.record.outputRootId) : undefined;
						return { ok: true, value: { work: read.value.record, versions: read.value.versions, ...(root && root.ok ? { outputRootPath: root.value.path } : {}) } };
					},
					list: async () => ({ ok: true, value: [] }),
					recover: async (sessionId) => {
						const works = main.store.listWorksForSession(sessionId);
						return { ok: true, value: { works, operations: [], corruptWorkIds: [] } };
					},
					listRoots: async () => main.store.listOutputRoots(),
					prepare: async (input) => {
						documentCalls.push("prepare");
						return main.service.prepare(input);
					},
					start: async (input) => {
						documentCalls.push("start");
						return main.service.start(input);
					},
					getOperation: async (input) => main.service.getOperation(input),
					cancel: async (input) => main.service.cancel(input),
					chooseRoot: async () => ({ ok: true, value: { cancelled: true } }),
					setRoot: async (input) => ({ ok: true, value: { workId: input.workId, revision: input.revision + 1 } }),
					forgetRoot: async () => ({ ok: true, value: true }),
					onChanged: () => () => undefined,
				},
			},
		},
		"../atoms/composer-atoms": {
			sessionComposerModeBySessionIdAtomFamily: (id) => keyAtom(`mode:${id}`),
			sessionSendStateBySessionIdAtomFamily: (id) => keyAtom(`send:${id}`),
			setSessionComposerModeAtom: atom(null, (_get, _set, value) => values.set(`mode:${value.sessionId}`, value.mode)),
			setSessionSendStateAtom: atom(null, (_get, _set, value) => values.set(`send:${value.sessionId}`, value.state)),
		},
		"../atoms/session-atoms": { sessionRuntimeByIdAtom: runtimes, bindSessionRuntimeAtom: atom(null, (_get, _set, value) => values.set(`runtime:${value.sessionId}`, { ...values.get(`runtime:${value.sessionId}`), ...value })) },
		"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => atom((get) => get(runtimes)[id]) },
		"./session-atoms": { sessionRuntimeByIdAtom: runtimes, bindSessionRuntimeAtom: atom(null, () => undefined) },
		"./useSessionTimelineController": { isSessionRuntimeBusy: () => false },
		"./session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => atom((get) => get(runtimes)[id]) },
	};
	// 文稿 hook 的 atom 模块：用同一套 keyAtom，保证两组 hook 看到同一份状态。
	const viewAtom = (id) => {
		const key = `docview:${id}`;
		if (!keyed.has(key)) keyed.set(key, atom({ loading: false, outputRoots: [], pending: false }));
		return keyed.get(key);
	};
	const documentWorkAtomsStub = {
		documentWorkViewAtomFamily: (id) => viewAtom(id),
		documentWorkChangeTickAtomFamily: (id) => keyAtom(`doctick:${id}`),
		emptyDocumentWorkView: { loading: false, outputRoots: [], pending: false },
	};
	const alignmentAtomsStub = {
		alignmentControlPendingAtomFamily: (id) => keyAtom(`pending:${id}`),
		alignmentControlErrorAtomFamily: (id) => keyAtom(`error:${id}`),
		alignmentSubmissionAtomFamily: (id) => keyAtom(`submission:${id}`),
		alignmentQueuedCountAtomFamily: (id) => keyAtom(`queue:${id}`),
		beginAlignmentSubmission: () => undefined,
	};
	const documentHookModule = loadTsCommonJs(resolve("src/renderer/src/hooks/useSessionDocumentWork.ts"), { stubs: { ...commonStubs, jotai: { ...commonStubs.jotai }, "../atoms/document-work-atoms": documentWorkAtomsStub, "../atoms/alignment-atoms": alignmentAtomsStub } });
	const alignmentHookModule = loadTsCommonJs(resolve("src/renderer/src/hooks/useSessionAlignmentControls.ts"), {
		stubs: {
			...commonStubs,
			"../atoms/alignment-atoms": alignmentAtomsStub,

			"../utils/alignmentPresentation": { deriveAlignmentPresentation: () => ({ kind: "ready", canApprove: true, questionCount: 0 }) },
			"../utils/alignmentAcknowledgement": {
				waitForAlignmentAcknowledgement: async (input) => {
					// 生产实现的判据：同一 frozen briefId+revision 的 approved/complete 才算回执。
					const behaviour = options.ack;
					if (!behaviour) {
						// 与生产一致的语义：等"同一 briefId+revision 的 approved/complete"出现，超时才算没回执。
						const deadline = Date.now() + 500;
						for (;;) {
							const latest = input.read();
							if (latest && input.matches(latest)) return;
							if (!input.isCurrent() || Date.now() > deadline) throw new Error("notAcknowledged");
							await new Promise((resolve) => setTimeout(resolve, 5));
						}
					}
					await behaviour.promise;
					if (!input.isCurrent()) throw new Error("notAcknowledged");
					const latest = input.read();
					if (!latest || !input.matches(latest)) throw new Error("notAcknowledged");
				},
			},
			"../utils/alignmentControls": { alignmentActionCommand: () => "/align approve brief_1 3", alignmentModeCommands: () => [], sameAlignmentRuntime: (left, right) => Boolean(left && right && left.agentId === right.agentId && left.runtimeGeneration === right.runtimeGeneration && left.sessionId === right.sessionId) },
			"../composerBehavior": { buildComposerPromptSubmission: (message) => ({ message }) },
		},
	});
	return {
		values,
		session,
		renderAlignment: (bridge) => alignmentHookModule.useSessionAlignmentControls(session, "pi", bridge ?? { beforeApprove: (state) => documentHookModule.useSessionDocumentWork(session, "pi").beforeApprove(state) }),
		/** 换代：模拟新 pi 进程接管同一会话。 */
		replaceRuntime: (generation) => values.set(`runtime:${session}`, { agentId: `agent-${generation}`, runtimeGeneration: generation, status: "idle", state: values.get(`runtime:${session}`).state }),
		renderDocument: () => documentHookModule.useSessionDocumentWork(session, "pi"),
		documentCalls,
		rendererSends,
		notices,
		store,
	};
}

async function waitFor(predicate, timeoutMs = 800) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 5));
	}
	return predicate();
}

test("正式文稿轮次：总批准次数恰好 1，且由主进程发出（前端不再发原生批准）", async () => {
	const main = mainHarness(WORD_BRIEF);
	const root = main.store.registerOutputRoot({ path: "C:/out", label: "out" });
	const work = main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "report", outputRootId: root.value.outputRootId });
	assert.equal(work.ok, true);
	const hook = hookHarness(main, WORD_BRIEF);
	const controls = hook.renderAlignment();
	const document = hook.renderDocument();
	assert.equal(document.documentRound, true);
	await setImmediate();
	controls.approve();
	await waitFor(() => main.sends.some((message) => message.startsWith("/align approve")));
	await waitFor(() => hook.values.get(`mode:${f.STABLE_SESSION}`) === "normal");
	const mainApproves = main.sends.filter((message) => message.startsWith("/align approve"));
	const rendererApproves = hook.rendererSends.filter((message) => message.startsWith("/align approve"));
	assert.equal(mainApproves.length, 1, `主进程必须恰好发一次批准（实际 ${JSON.stringify(mainApproves)}）`);
	assert.equal(rendererApproves.length, 0, `前端不得再发原生批准（实际 ${JSON.stringify(hook.rendererSends)}）`);
	assert.equal(mainApproves.length + rendererApproves.length, 1, "总批准次数必须恰好 1");
	assert.equal(hook.values.get(`mode:${f.STABLE_SESSION}`), "normal", "批准后退出对齐模式");
	assert.equal(hook.values.get(`pending:${f.STABLE_SESSION}`), false);
});

test("普通编码 Plan：0 个文稿 create/prepare/start，原生批准一次", async () => {
	const main = mainHarness(CODING_BRIEF);
	const hook = hookHarness(main, CODING_BRIEF);
	const controls = hook.renderAlignment();
	const document = hook.renderDocument();
	assert.equal(document.documentRound, false);
	await setImmediate();
	controls.approve();
	await setImmediate();
	assert.deepEqual([...hook.documentCalls], [], "普通开发不得触碰文稿域");
	assert.equal(main.sends.filter((message) => message.startsWith("/align approve")).length, 0, "主进程不得发批准");
	assert.deepEqual([...hook.rendererSends], ["/align approve brief_1 3"], "原生批准恰好一次");
	assert.deepEqual([...hook.notices], [], "不得要求选择成果目录");
});

test("已有归档文稿的会话里做普通 coding：不复用旧文稿，仍然 0 个文稿调用", async () => {
	const main = mainHarness(CODING_BRIEF);
	const root = main.store.registerOutputRoot({ path: "C:/out", label: "out" });
	main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "old report", outputRootId: root.value.outputRootId });
	const hook = hookHarness(main, CODING_BRIEF);
	const controls = hook.renderAlignment();
	await setImmediate();
	controls.approve();
	await setImmediate();
	assert.deepEqual([...hook.documentCalls], []);
	assert.equal(main.sends.length, 0);
	assert.deepEqual([...hook.rendererSends], ["/align approve brief_1 3"]);
});

test("文稿轮次缺成果目录：批准被拦下，两边都不发批准", async () => {
	const main = mainHarness(WORD_BRIEF);
	main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "report", outputRootId: "" });
	const hook = hookHarness(main, WORD_BRIEF);
	const controls = hook.renderAlignment();
	// 真实挂载点会同时渲染文稿卡（SessionAlignmentTimeline），所以这里也先渲染一次，
	// 让快照先加载：批准时不应该再凭空 create 第二件工作。
	hook.renderDocument();
	await setImmediate();
	controls.approve();
	await setImmediate();
	assert.deepEqual([...hook.documentCalls], []);
	assert.equal(hook.rendererSends.length, 0);
	assert.equal(main.sends.length, 0);
	assert.deepEqual([...hook.notices], ["documentWork.needOutputFolder"]);
});

test("文稿记录创建失败（IO_ERROR）：拦下本轮，不发原生批准也不 prepare/start", async () => {
	const main = mainHarness(WORD_BRIEF);
	const hook = hookHarness(main, WORD_BRIEF);
	// 存档不可用：真实 API 创建返回结构化错误（磁盘/权限失败的真实形态）。
	const originalCreate = main.store.createWork.bind(main.store);
	main.store.createWork = () => ({ ok: false, error: { code: "IO_ERROR", retryable: true, detail: "failed to persist the work record" } });
	const controls = hook.renderAlignment();
	hook.renderDocument();
	await setImmediate();
	controls.approve();
	await setImmediate();
	assert.deepEqual([...hook.documentCalls], ["create"], "只尝试建记录，不得继续 prepare/start");
	assert.deepEqual([...hook.rendererSends], [], "不得绕过正式流程发原生批准");
	assert.equal(main.sends.length, 0);
	assert.deepEqual([...hook.notices], ["documentWork.error.generic"], "必须给出明确错误");
	main.store.createWork = originalCreate;
});

test("handled 不等于已批准：回执到达前保持对齐与 pending，回执后（同一 frozen 版本）才切正常", async () => {
	const main = mainHarness(WORD_BRIEF);
	const root = main.store.registerOutputRoot({ path: "C:/out", label: "out" });
	main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "report", outputRootId: root.value.outputRootId });
	const ack = deferredAck();
	const hook = hookHarness(main, WORD_BRIEF, { ack });
	const controls = hook.renderAlignment();
	hook.renderDocument();
	await setImmediate();
	controls.approve();
	// 后台绑定确认还没回执：UI 必须保持对齐模式与 pending，不能提前宣布批准成功。
	await waitFor(() => main.sends.some((message) => message.startsWith("/align approve")));
	assert.equal(hook.values.get(`mode:${f.STABLE_SESSION}`), "alignment", "回执前不得切换模式");
	assert.equal(hook.values.get(`pending:${f.STABLE_SESSION}`), true, "回执前保持 pending");
	ack.resolve();
	await waitFor(() => hook.values.get(`mode:${f.STABLE_SESSION}`) === "normal");
	assert.equal(hook.values.get(`pending:${f.STABLE_SESSION}`), false);
	assert.equal(hook.values.get(`error:${f.STABLE_SESSION}`), undefined);
});

test("回执缺失/失败：保留实际状态与输入，不假装批准成功", async () => {
	const main = mainHarness(WORD_BRIEF);
	const root = main.store.registerOutputRoot({ path: "C:/out", label: "out" });
	main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "report", outputRootId: root.value.outputRootId });
	const ack = deferredAck();
	const hook = hookHarness(main, WORD_BRIEF, { ack });
	const controls = hook.renderAlignment();
	hook.renderDocument();
	await setImmediate();
	controls.approve();
	await waitFor(() => main.sends.some((message) => message.startsWith("/align approve")));
	ack.reject(new Error("notAcknowledged"));
	await waitFor(() => hook.values.get(`pending:${f.STABLE_SESSION}`) === false);
	assert.equal(hook.values.get(`mode:${f.STABLE_SESSION}`), "alignment", "没有回执就不算批准：保持对齐模式");
	assert.equal(hook.values.get(`error:${f.STABLE_SESSION}`)?.briefId, "brief_1");
	assert.deepEqual([...hook.notices], ["alignment.notAcknowledged"]);
	assert.deepEqual([...hook.rendererSends], [], "不得补发原生批准");
});

test("文稿桥等待期间换代：不碰新运行时的确认状态，也不向新运行时发旧确认", async () => {
	const main = mainHarness(WORD_BRIEF);
	const hook = hookHarness(main, WORD_BRIEF);
	const bridge = deferredAck();
	const controls = hook.renderAlignment({ beforeApprove: () => bridge.promise.then(() => "handled") });
	await setImmediate();
	controls.approve();
	// 桥还没返回就换代：旧点击必须彻底作废。
	hook.replaceRuntime(2);
	bridge.resolve();
	await setImmediate();
	// 挂载时的对齐模式由 effect 设置；关键是旧点击不得把它切成 normal，也不得标 pending。
	assert.equal(hook.values.get(`mode:${f.STABLE_SESSION}`), "alignment", "旧点击不得改动新运行时的模式");
	assert.equal(Boolean(hook.values.get(`pending:${f.STABLE_SESSION}`)), false, "不得把新运行时标成 pending");
	assert.deepEqual([...hook.rendererSends], [], "不得向新运行时发旧确认");
	assert.equal(main.sends.length, 0);
});

test("同一确认双击：主进程只发一次绑定与一次批准", async () => {
	const main = mainHarness(WORD_BRIEF);
	const root = main.store.registerOutputRoot({ path: "C:/out", label: "out" });
	main.store.createWork({ requestId: "create_seed", requestDigest: "d", sessionId: f.STABLE_SESSION, sourceTurnId: "turn_seed", title: "report", outputRootId: root.value.outputRootId });
	const hook = hookHarness(main, WORD_BRIEF);
	const controls = hook.renderAlignment();
	hook.renderDocument();
	await setImmediate();
	controls.approve();
	controls.approve();
	await waitFor(() => main.sends.some((message) => message.startsWith("/align approve")));
	await waitFor(() => hook.values.get(`mode:${f.STABLE_SESSION}`) === "normal");
	await setImmediate();
	assert.equal(main.sends.filter((message) => message.startsWith("/tpa-work bind")).length, 1, "双击只允许一次绑定");
	assert.equal(main.sends.filter((message) => message.startsWith("/align approve")).length, 1, "双击只允许一次批准");
	assert.equal(hook.rendererSends.length, 0);
});
