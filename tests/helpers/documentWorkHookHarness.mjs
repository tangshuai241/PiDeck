/**
 * 文稿 hook 的最小渲染台：按 React 的语义执行 hooks，并**真的比较 effect 依赖**。
 *
 * 为什么要它：首次建档的缺陷是「effect 依赖写成了稳定 atom，值变了却不重跑」，
 * 用 `useEffect: (fn) => fn()` 那种一次性桩根本复现不出来——桩会把 bug 掩盖成通过。
 * 这里实现 shallow 依赖比较 + commit 阶段执行 effect（先跑上一轮 cleanup）、ref 稳定槽、
 * useCallback/useMemo 的依赖缓存，以及「effect 改写订阅状态后重渲染」的收敛循环；
 * 会话 atom family 的桩按 sessionId 记忆化，保证 atom 身份与生产 `atomFamily` 一致
 * （否则依赖数组里的 atom 会「每轮都变」，原缺陷会被掩盖成通过）。
 *
 * 边界：不用真实 React DOM —— 仓库有 `react-dom` 但没有 DOM 实现（无 jsdom/happy-dom），
 * 本任务不允许安装依赖，因此视图层用「hooks 语义仿真」替代，其余（真实 atoms 模块、
 * 真实纯策略、真实桌面 API 边界）都用生产代码。凡是依赖 React 渲染细节的结论都不在此断言。
 */
import { resolve } from "node:path";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const ROOT = process.cwd();

/** 依赖比较：与 React 一致，逐位 Object.is；deps 为 undefined 表示每次都执行。 */
function sameDeps(before, next) {
	if (before === undefined || next === undefined) return before === next;
	if (before.length !== next.length) return false;
	return before.every((value, index) => Object.is(value, next[index]));
}

/** 按 id 记忆化：与生产 `atomFamily` 的身份语义一致（同 id 同 atom 实例）。 */
function memoizedFamily(initialize) {
	const cache = new Map();
	return (id) => {
		if (!cache.has(id)) cache.set(id, initialize(id));
		return cache.get(id);
	};
}

/**
 * 每个渲染槽位的历史：effect 依赖、cleanup、ref 对象、memo/callback 缓存。
 *
 * hooks 在调用时自己决定「复用上一轮的值还是重算」，`runPass` 只负责在一轮结束后
 * 执行依赖变化的 effect（并先跑上一轮的 cleanup），与 React 的提交阶段一致。
 */
function createHookRuntime() {
	let slots = [];
	let previous = [];
	let cursor = 0;

	const runPass = (component) => {
		slots = [];
		cursor = 0;
		const result = component();
		slots.forEach((slot, index) => {
			if (slot.kind !== "effect") return;
			const before = previous[index];
			const changed = !before || before.kind !== "effect" || !sameDeps(before.deps, slot.deps);
			if (changed) {
				before?.cleanup?.();
				slot.cleanup = slot.fn() ?? undefined;
			} else {
				slot.cleanup = before.cleanup;
			}
		});
		previous = slots;
		return result;
	};

	const remember = (index, slot) => {
		slots[index] = slot;
		return slot;
	};

	return {
		runPass,
		useEffect: (fn, deps) => {
			remember(cursor++, { kind: "effect", fn, deps: deps === undefined ? undefined : [...deps], cleanup: undefined });
		},
		useCallback: (fn, deps) => {
			const index = cursor++;
			const before = previous[index];
			if (before?.kind === "callback" && sameDeps(before.deps, deps)) return remember(index, before).value;
			return remember(index, { kind: "callback", deps: deps === undefined ? undefined : [...deps], value: fn }).value;
		},
		useMemo: (fn, deps) => {
			const index = cursor++;
			const before = previous[index];
			if (before?.kind === "memo" && sameDeps(before.deps, deps)) return remember(index, before).value;
			return remember(index, { kind: "memo", deps: deps === undefined ? undefined : [...deps], value: fn() }).value;
		},
		useRef: (initial) => {
			const index = cursor++;
			const before = previous[index];
			if (before?.kind === "ref") return remember(index, before).value;
			return remember(index, { kind: "ref", value: { current: initial } }).value;
		},
		unmount: () => {
			for (const slot of previous) slot.cleanup?.();
			previous = [];
		},
	};
}

/**
 * 建一个文稿 hook 的渲染台。
 *
 * `runtime` / `messages` 由测试显式推进：初始可以为空（模拟「hook 挂载早于 runtime 与用户消息到达」）。
 */
export function createDocumentWorkHarness(options = {}) {
	const store = createStore();
	const hookRuntime = createHookRuntime();
	const composerMode = new Map();
	/** 会话级可写 mode 原子：hook 会读、确认路径会写回 normal。 */
	const modeAtomFor = (id) => {
		const key = `mode:${id}`;
		if (!composerMode.has(key)) composerMode.set(key, atom("normal"));
		return composerMode.get(key);
	};
	const calls = { list: 0, create: [], chooseOutputRoot: 0, prepare: [], start: [], autoRevise: [] };
	const notices = [];
	const workState = { views: options.initialViews ?? [] };

	/** 本轮 useAtomValue 读过的 atom：effect 改写它们时要像 React 一样再渲染一轮。 */
	let tracked = [];
	const runtimesAtom = atom({ s1: options.runtime ?? undefined });
	const messagesAtom = atom({ s1: { messages: options.messages ?? [] } });

	const reactStub = {
		useEffect: (fn, deps) => hookRuntime.useEffect(fn, deps),
		useCallback: (fn, deps) => hookRuntime.useCallback(fn, deps),
		useMemo: (fn, deps) => hookRuntime.useMemo(fn, deps),
		useRef: (initial) => hookRuntime.useRef(initial),
	};

	/** useAtomValue 的替身：读值并登记订阅，供收敛渲染判断是否要再来一轮。 */
	const trackAtom = (target) => {
		if (!tracked.includes(target)) tracked.push(target);
		return store.get(target);
	};

	const atoms = loadTsCommonJs(resolve(`${ROOT}/src/renderer/src/atoms/document-work-atoms.ts`), {
		stubs: {
			jotai: { atom, useStore: () => store, useAtomValue: (target) => store.get(target) },
			"jotai/utils": {
				atomFamily: (initialize) => {
					const cache = new Map();
					return (id) => {
						if (!cache.has(id)) cache.set(id, initialize(id));
						return cache.get(id);
					};
				},
			},
		},
	});

	const module = loadTsCommonJs(resolve(`${ROOT}/src/renderer/src/hooks/useSessionDocumentWork.ts`), {
		// 生产里 setTimeout/clearTimeout 由浏览器提供；vm 沙箱默认注入，这里显式再给一次，
		// 保证真实确认等待器（alignmentAcknowledgement 用 globalThis 定时器）不会因环境缺失
		// 直接抛 TypeError 被误判成「本轮失败」。生产代码不得 import node:timers。
		globals: { crypto: { randomUUID: () => `req-${calls.create.length + calls.prepare.length + 1}` }, setTimeout, clearTimeout },
		stubs: {
			jotai: { atom, useStore: () => store, useAtomValue: trackAtom },
			"jotai/utils": {
				atomFamily: (initialize) => {
					const cache = new Map();
					return (id) => {
						if (!cache.has(id)) cache.set(id, initialize(id));
						return cache.get(id);
					};
				},
			},
			react: reactStub,
			"../atoms/document-work-atoms": atoms,
			"../atoms/composer-atoms": {
				sessionComposerModeBySessionIdAtomFamily: (id) => modeAtomFor(id),
				setSessionComposerModeAtom: atom(null, (_get, set, value) => set(modeAtomFor(value.sessionId), value.mode)),
			},
			// 生产里这些是 atomFamily：同一个 sessionId 必须每次都拿到同一个 atom 身份。
			// 桩若每次 new 一个 atom，依赖数组里的 atom 会「每轮都变」，原缺陷就被掩盖成通过。
			"../atoms/session-atoms": { sessionMessageCacheBySessionIdAtomFamily: memoizedFamily((id) => atom((get) => get(messagesAtom)[id])) },
			"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: memoizedFamily((id) => atom((get) => get(runtimesAtom)[id])) },
			"../utils/documentWorkHash": { hashUserTurnText: async () => "hash-1" },
			"../desktopApi": {
				desktopApi: {
					documentWork: {
						list: async () => {
							calls.list += 1;
							return workState.views;
						},
						onChanged: () => () => {},
						create: async (input) => {
							calls.create.push(input);
							const created = { workId: "dw_1", sessionId: input.sessionId, revision: 1, title: input.title ?? "文稿工作", outputRootLabel: "文稿", requirementsSummary: "", active: null, versions: [], revisionReady: false };
							workState.views = [created];
							return { ok: true, value: created };
						},
						chooseOutputRoot: async () => {
							calls.chooseOutputRoot += 1;
							return { ok: true, value: { outputRootId: "or_1", label: "文稿", path: "C:/out" } };
						},
						chooseMaterials: async () => ({ ok: true, value: { paths: [], count: 0 } }),
						registerMaterials: async () => ({ ok: true, value: { paths: [], count: 0 } }),
						prepare: async (input) => {
							calls.prepare.push(input);
							return { ok: true, value: { workId: input.workId, workRevision: input.expectedRevision + 1, preparation: { preparationId: "pr_1", digest: "a".repeat(64) }, summary: "s" } };
						},
						start: async (input) => {
							calls.start.push(input);
							return { ok: true, value: { attemptId: "at_1", phase: "running", authorizationState: "pending" } };
						},
						autoRevise: async (input) => {
							calls.autoRevise.push(input);
							return { ok: true, value: { engaged: false } };
						},
						cancel: async () => ({ ok: true, value: { attemptId: "at_1" } }),
					},
				},
			},
			"../i18n": { t: (key) => key.replace("documentWork.", "") },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"./useSessionTimelineController": { isSessionRuntimeBusy: (status, state) => status === "running" || Boolean(state?.isStreaming) },
		},
	});

	let latest = null;
	/** React 语义的收敛渲染：effect 若改写了本轮订阅的 atom，就再渲染一轮（最多 6 轮）。 */
	const render = () => {
		let snapshot;
		for (let pass = 0; pass < 6; pass++) {
			tracked = [];
			latest = hookRuntime.runPass(() => module.useSessionDocumentWork("s1", options.backend ?? "pi"));
			const next = tracked.map((target) => store.get(target));
			if (snapshot && next.length === snapshot.length && next.every((value, index) => Object.is(value, snapshot[index]))) break;
			snapshot = next;
		}
		return latest;
	};

	return {
		store,
		atoms,
		calls,
		notices,
		render,
		/** 当前渲染结果（与 React 一样：渲染后读取）。 */
		get controls() {
			return latest;
		},
		/** runtime 到达/更新：模拟 RPC 事件推进（新对象身份，值变化）。 */
		setRuntime: (next) => store.set(runtimesAtom, { s1: next }),
		/** 会话消息更新（同一数组实例不触发变化，必须换新数组，与真实 atom 更新一致）。 */
		setMessages: (next) => store.set(messagesAtom, { s1: { messages: next } }),
		unmount: () => hookRuntime.unmount(),
		/** 只推进对齐快照（保留 runtime 三元组），模拟 Pi 的 RPC 状态更新。 */
		setAlignment: (alignment) => {
			const current = store.get(runtimesAtom).s1;
			store.set(runtimesAtom, { s1: { ...(current ?? { agentId: "a1", runtimeGeneration: 1, status: "idle", state: {} }), state: { ...(current?.state ?? {}), alignment } } });
		},
		mode: () => store.get(modeAtomFor("s1")),
		setMode: (value) => store.set(modeAtomFor("s1"), value),
		/** 冲掉一个宏任务：等异步的 IPC 桩（例如 list 返回工作快照）落地后再渲染。 */
		notices,
		flush: () => new Promise((resolve) => setImmediate(resolve)),
	};
}

/** 对齐快照（默认：正式文稿 brief，ready，revision 1）。 */
export function alignmentSnapshot(overrides = {}) {
	const revision = overrides.revision ?? 1;
	return {
		schemaVersion: 1,
		briefId: "brief-1",
		revision,
		phase: overrides.phase ?? "ready",
		briefRevision: overrides.briefRevision ?? revision,
		brief: overrides.brief === null ? undefined : (overrides.brief ?? { goal: "写一份正式的季度报告", scope: [], materials: [], deliverable: "Word 文档（DOCX）", preserve: [], acceptance: ["结构完整"], questions: [] }),
		...(overrides.lastStopReason ? { lastStopReason: overrides.lastStopReason } : {}),
	};
}

export function runtimeSnapshot(alignment, generation = 1) {
	return { agentId: `a${generation}`, runtimeGeneration: generation, status: "idle", state: { alignment } };
}

export function userMessage(text, id = "turn-1") {
	return { id, agentId: "a1", role: "user", text, timestamp: 1 };
}
