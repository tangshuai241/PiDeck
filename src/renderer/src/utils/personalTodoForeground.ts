/**
 * 待办页的前台刷新：前台信号源（可注入替身）+ 可见期间低频刷新的生命周期。
 *
 * 为什么独立：判断页面是否可见、何时算「回到前台」是宿主环境的事；计时器的启停、隐藏即停、
 * 回前台立即刷新、在飞不叠加这些策略又必须能脱离 React 单测。hook 只提供「怎么刷新」和
 * 「是否已有请求在飞」两个回调，本模块负责「什么时候刷新」。
 *
 * 边界：这里不发请求、不管理队列；`refresh()` 由调用方决定（待办页是静默 list）。
 * 返回的停止函数幂等，必须注销全部监听并清掉计时器（离页清理依赖这一点）。
 */

/** 待办页可见时的刷新间隔。云端 v1 没有事件流，低频轮询是感知别处（微信/另一台电脑）改动的兜底；
 * 30 秒是有界值：每次只取一页、失败不重试爆发，隐藏时停表，离页自动清理。 */
export const PERSONAL_TODO_FOREGROUND_REFRESH_MS = 30_000;

export type PersonalTodoForegroundSource = {
	/** 页面当前是否可见；隐藏时轮询应停止。 */
	isVisible: () => boolean;
	/** 订阅「可能回到前台」的信号（可见性变化/窗口焦点/网络恢复），返回退订函数。 */
	subscribe: (listener: () => void) => () => void;
};

export function createBrowserPersonalTodoForeground(): PersonalTodoForegroundSource {
	return {
		isVisible: () => {
			if (typeof document === "undefined") return true;
			return document.hidden !== true;
		},
		subscribe(listener) {
			if (typeof window === "undefined") return () => undefined;
			const onVisibilityChange = () => listener();
			window.addEventListener("visibilitychange", onVisibilityChange);
			window.addEventListener("focus", listener);
			window.addEventListener("online", listener);
			return () => {
				window.removeEventListener("visibilitychange", onVisibilityChange);
				window.removeEventListener("focus", listener);
				window.removeEventListener("online", listener);
			};
		},
	};
}

export type PersonalTodoForegroundRefreshOptions = {
	/** 触发一次静默刷新（待办页用 list；主进程读到列表后会做一次带去重的后台刷新）。 */
	refresh: () => void;
	/** 是否已有列表请求在飞：true 时不叠加、不重置计时（在飞请求本身会带回新鲜快照）。 */
	isBusy?: () => boolean;
	/** 刷新间隔；缺省用 `PERSONAL_TODO_FOREGROUND_REFRESH_MS`。 */
	intervalMs?: number;
	/** 前台信号源；缺省读 document/window。 */
	source?: PersonalTodoForegroundSource;
};

/**
 * 启动前台刷新生命周期，返回停止函数（停表 + 退订，幂等）。
 *
 * 语义：
 * - 可见时每 `intervalMs` 静默刷新一次；
 * - 隐藏立即停表（不依赖下一次 tick 才发现），回到前台/焦点/网络恢复立即刷新一次并重启计时；
 * - `isBusy()` 为 true 时不发起新请求。
 */
export function startPersonalTodoForegroundRefresh(options: PersonalTodoForegroundRefreshOptions): () => void {
	const source = options.source ?? createBrowserPersonalTodoForeground();
	const intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : PERSONAL_TODO_FOREGROUND_REFRESH_MS;
	let timer: ReturnType<typeof setInterval> | null = null;
	const stopTimer = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
	const busy = () => options.isBusy?.() === true;
	const tick = () => {
		if (!source.isVisible()) {
			stopTimer();
			return;
		}
		if (busy()) return;
		options.refresh();
	};
	const start = () => {
		stopTimer();
		timer = setInterval(tick, intervalMs);
	};
	const onSignal = () => {
		if (!source.isVisible()) {
			stopTimer();
			return;
		}
		stopTimer();
		if (!busy()) options.refresh();
		start();
	};
	const unsubscribe = source.subscribe(onSignal);
	if (source.isVisible()) start();
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		stopTimer();
		unsubscribe();
	};
}
