/**
 * 确认单点击的接口行为：谁发批准、何时才切换模式、失败/超时如何收场。
 *
 * 这些断言必须落在**真实 hook + 真实等待器**上（不是纯策略）：
 * - 文稿路径由主进程发 `/align approve`，渲染层不得再发第二次；
 * - 只有「本轮 brief+revision 的准确回执 + 同一 runtime」才切回普通模式；
 * - 延迟回执、超时、换代、不同 brief 都不能批准、不能改模式、不能吞错；
 * - 明确文稿但缺工作记录/成果目录时不发批准（blocked），也保留错误与待建设置。
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function snapshot(revision = 2, phase = "ready", briefId = "brief-123") {
	return { schemaVersion: 1, briefId, revision, phase, briefRevision: revision, brief: { goal: "写一份季度报告", scope: [], materials: [], deliverable: "Word 文档", preserve: [], acceptance: ["结构完整"], questions: [] } };
}

function runtime(generation = 1, alignment = snapshot()) {
	return { agentId: `a${generation}`, runtimeGeneration: generation, status: "idle", state: { alignment } };
}

const WORK_VIEW = {
	workId: "dw_1",
	sessionId: "s1",
	revision: 3,
	title: "季度报告",
	outputRootLabel: "文稿",
	requirementsSummary: "",
	active: null,
	versions: [],
	revisionReady: false,
};

/** 真实 hook + 真实等待器；只替换 IPC、atom 与 react 运行时。 */
function harness({ initialRuntime = runtime(), view = WORK_VIEW, projectApproved = true, chats = [] } = {}) {
	const store = createStore();
	const runtimes = atom({ s1: initialRuntime });
	const views = atom({ s1: view });
	const messages = atom({ s1: { messages: chats } });
	const keyed = new Map();
	const keyAtom = (key, seed) => {
		if (!keyed.has(key)) keyed.set(key, atom(seed));
		return keyed.get(key);
	};
	/** 每个 atomFamily 自己一份缓存，行为与真实实现一致（同 id 返回同一个可写 atom）。 */
	const familyAtoms = new Map();
	const family = (name, seed) => (id) => {
		const key = `${name}:${id}`;
		if (!familyAtoms.has(key)) familyAtoms.set(key, atom(seed));
		return familyAtoms.get(key);
	};
	const requests = [];
	const notices = [];
	const prepared = [];
	const started = [];
	const alignmentNotAcknowledged = { value: false };
	store.set(keyAtom("mode:s1", "alignment"), "alignment");
	module = loadTsCommonJs(resolve("src/renderer/src/hooks/useSessionDocumentWork.ts"), {
		globals: { crypto: { randomUUID: () => "req-1" } },
		stubs: {
			jotai: { atom, useStore: () => store, useAtomValue: (key) => store.get(key) },
			"jotai/utils": {
				// 每个 atomFamily 调用各自独立缓存：种子值由下面具名的 family(...) 决定。
				atomFamily: (initialize) => {
					const cache = new Map();
					return (id) => {
						if (!cache.has(id)) cache.set(id, initialize(id));
						return cache.get(id);
					};
				},
			},
			react: { useCallback: (fn) => fn, useEffect: () => {}, useMemo: (fn) => fn(), useRef: (value) => ({ current: value }) },
			"../atoms/document-work-atoms": {
				documentWorkViewAtomFamily: family("view", view),
				documentWorkPhaseAtomFamily: family("phase", "idle"),
				documentWorkErrorAtomFamily: family("error", undefined),
				documentWorkMaterialsAtomFamily: family("materials", []),
				pendingWorkCreationAtomFamily: family("pending", undefined),
				activePreparationAtomFamily: family("prep", undefined),
				documentWorkChangeAtomFamily: family("change", undefined),
			},
			"../atoms/composer-atoms": { sessionComposerModeBySessionIdAtomFamily: (id) => keyAtom(`mode:${id}`, "normal"), setSessionComposerModeAtom: atom(null, (_get, set, value) => set(keyAtom(`mode:${value.sessionId}`, "normal"), value.mode)) },
			"../atoms/session-atoms": { sessionMessageCacheBySessionIdAtomFamily: (id) => atom((get) => get(messages)[id]) },
			"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => atom((get) => get(runtimes)[id]) },
			"../utils/documentWorkHash": { hashUserTurnText: async () => "hash-1" },
			"../desktopApi": {
				desktopApi: {
					documentWork: {
						list: async () => [],
						onChanged: () => () => {},
						prepare: async (input) => {
							requests.push({ kind: "prepare", input });
							prepared.push(input);
							return projectApproved ? { ok: true, value: { workId: input.workId, workRevision: input.expectedRevision + 1, preparation: { preparationId: "pr_1", digest: "a".repeat(64) }, summary: "s" } } : { ok: false, error: { code: "PATH_DENIED", retryable: false } };
						},
						start: async (input) => {
							requests.push({ kind: "start", input });
							started.push(input);
							return { ok: true, value: { attemptId: "at_1", phase: "running", authorizationState: "pending" } };
						},
					},
				},
			},
			"../i18n": { t: (key) => key.replace("documentWork.", "") },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"./useSessionTimelineController": { isSessionRuntimeBusy: (status, state) => status === "running" || Boolean(state?.isStreaming) },
		},
	});
	return {
		store,
		requests,
		notices,
		prepared,
		started,
		alignmentNotAcknowledged,
		setView: (next) => store.set(familyAtoms.get("view:s1"), next),
		setAlignment: (next) => store.set(runtimes, { s1: { ...store.get(runtimes).s1, state: { alignment: next } } }),
		readAlignment: () => store.get(runtimes).s1?.state?.alignment,
		mode: () => store.get(keyAtom("mode:s1", "normal")),
		render: () => module.useSessionDocumentWork("s1", "pi"),
	};
}

let module;

test("文稿路径：主进程发批准，渲染层不再发第二次，权威回执后才切回普通模式", async () => {
	const h = harness();
	const controls = h.render();
	// 真实回执在等待期间到达：延迟一拍把 alignment 推到 approved。
	const timer = setTimeout(() => h.setAlignment(snapshot(2, "approved")), 20);
	const outcome = await controls.prepareAndStartForApproval();
	clearTimeout(timer);
	assert.equal(outcome, "documentWorkDispatched");
	assert.equal(h.requests.filter((request) => request.kind === "start").length, 1);
	assert.equal(h.started[0].authorization.briefId, "brief-123");
	assert.equal(h.started[0].authorization.revision, 2);
	// 被加载 hook 在 vm 里有独立原型链：结构比较前先 JSON 归一。
	assert.deepEqual(JSON.parse(JSON.stringify(h.started[0].expectedRuntime)), { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 });
	assert.equal(h.mode(), "normal");
});

test("普通编码/解释轮不接管：走原生批准，不建文稿、不发 start", async () => {
	// 真实时序：用户又发了一条普通消息 → alignment 的 revision 前进而 briefRevision 留在旧值。
	const draft = { ...snapshot(3, "clarifying"), briefRevision: 2 };
	const h = harness({ view: null, initialRuntime: runtime(1, draft), chats: [{ id: "t1", role: "user", text: "帮我重构这个模块并补单元测试" }] });
	const outcome = await h.render().prepareAndStartForApproval();
	assert.equal(outcome, "proceedWithAlignment");
	assert.equal(h.requests.length, 0, "普通轮不得触发文稿准备/开始");
});

test("已有文稿的会话里后续普通编码仍然走原生批准", async () => {
	const draft = { ...snapshot(3, "clarifying"), briefRevision: 2 };
	const h = harness({ initialRuntime: runtime(1, draft), chats: [{ id: "t1", role: "user", text: "帮我修一下这个 bug 并补测试" }] });
	const outcome = await h.render().prepareAndStartForApproval();
	assert.equal(outcome, "proceedWithAlignment");
	assert.equal(h.requests.length, 0, "旧文稿不得吞掉后续普通编码确认单");
});

test("明确文稿但缺工作记录：blocked，不发批准且保留错误", async () => {
	const h = harness({ view: null, chats: [{ id: "t1", role: "user", text: "帮我写一份季度报告并归档" }] });
	const outcome = await h.render().prepareAndStartForApproval();
	assert.equal(outcome, "blocked");
	assert.equal(h.requests.length, 0, "缺成果目录时不得发批准");
	assert.deepEqual(h.notices, ["needsOutputRoot"]);
});

test("准备失败不批准、不切模式，错误留给用户", async () => {
	const h = harness({ projectApproved: false });
	const outcome = await h.render().prepareAndStartForApproval();
	assert.equal(outcome, "aborted");
	assert.equal(h.requests.filter((request) => request.kind === "start").length, 0, "准备失败不得开始");
	assert.equal(h.mode(), "alignment", "失败不得切回普通模式");
	assert.deepEqual(h.notices, ["error.PATH_DENIED"]);
});

test("超时未收到权威回执：不切模式，错误显式暴露", async () => {
	const h = harness();
	// 回执永远不到达：等待器应超时（默认 5s）并抛出 notAcknowledged。
	const controls = h.render();
	const started = controls.prepareAndStartForApproval();
	const outcome = await started;
	assert.equal(outcome, "aborted");
	assert.equal(h.mode(), "alignment", "没有权威回执就不能切模式");
	assert.equal(h.notices.includes("alignment.notAcknowledged"), true);
	assert.equal(h.mode() !== "normal", true);
});

test("回执来自不同的 brief：不算批准", async () => {
	const h = harness();
	const controls = h.render();
	// 在 prepare/start 之后立刻把 alignment 换成另一个 brief 的 approved。
	const timer = setTimeout(() => h.setAlignment(snapshot(2, "approved", "brief-other")), 20);
	const outcome = await controls.prepareAndStartForApproval();
	clearTimeout(timer);
	assert.equal(outcome, "aborted");
	assert.equal(h.mode(), "alignment", "不同 brief 的回执不得切模式");
});
