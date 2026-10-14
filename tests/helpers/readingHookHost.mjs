/**
 * 阅读域 hook 测试的挂载宿主：真实生产 hook + 真实 Jotai store，只替换 React 挂载层与桌面契约依赖。
 *
 * 与 `personalTodoHook.test.mjs` 里的 React 替身同口径（槽位按调用顺序复用、effect 在渲染后统一执行、
 * 依赖不变不重跑、重跑前先跑上一次的 cleanup），抽成 helper 只为让多个阅读 hook 测试共用同一份宿主。
 *
 * 边界：只服务阅读域测试；不注入真实网络，不挂真实 Electron。
 */
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

export function createReadingHookHarness(options = {}) {
	const store = options.store ?? createStore();
	const slots = [];
	const setters = new Map();
	let cursor = 0;
	let pendingEffects = [];

	const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

	const react = {
		useState(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
				},
			];
		},
		useRef(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { current: initial };
			return slots[index];
		},
		useCallback(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { value: fn, deps };
			return slots[index].value;
		},
		useMemo(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { value: fn(), deps };
			return slots[index].value;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const slot = slots[index];
			if (slot && sameDeps(slot.deps, deps)) return;
			pendingEffects.push(() => {
				slot?.cleanup?.();
				slots[index] = { cleanup: fn(), deps };
			});
		},
		useLayoutEffect(fn, deps) {
			react.useEffect(fn, deps);
		},
	};

	/** 与真实 jotai 一致：同一个 atom 的 setter 必须跨渲染保持同一引用，否则会拖垮依赖它的 useCallback/useEffect。 */
	const setterFor = (target) => {
		if (!setters.has(target)) {
			setters.set(target, (next) => {
				store.set(target, typeof next === "function" ? next(store.get(target)) : next);
			});
		}
		return setters.get(target);
	};
	const jotai = {
		atom,
		/** hook 里用 store.set(atomFamily(key), …) 把结果写回「票据所属的书」：替身直接给同一个 store。 */
		useStore: () => store,
		useAtom: (target) => {
			const index = cursor++;
			const slot = slots[index];
			if (!slot || slot.atom !== target) slots[index] = { atom: target };
			return [store.get(target), setterFor(target)];
		},
		useAtomValue: (target) => {
			cursor++;
			return store.get(target);
		},
		useSetAtom: (target) => {
			cursor++;
			return setterFor(target);
		},
	};

	return {
		store,
		react,
		jotai,
		/** 加载生产 hook / atom 模块：react 与 jotai 用替身，其余相对依赖照常解析（jotai/utils 走真实包）。 */
		load(path, extraStubs = {}) {
			return loadTsCommonJs(path, { stubs: { react, jotai, "../desktopApi": { desktopApi: { reading: null } }, ...extraStubs } });
		},
		render(callback) {
			cursor = 0;
			const result = callback();
			const effects = pendingEffects;
			pendingEffects = [];
			for (const effect of effects) effect();
			return result;
		},
		/** 卸载：跑所有已注册 effect 的 cleanup（模拟页面关闭 / 组件卸载），不重置共享 store。 */
		unmount() {
			for (const slot of slots) {
				// useAtomValue/useSetAtom 只推 cursor 不占槽位，slots 会是稀疏数组：跳过空槽
				if (!slot) continue;
				slot.cleanup?.();
				slot.cleanup = undefined;
			}
		},
	};
}
