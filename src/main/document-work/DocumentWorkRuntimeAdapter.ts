/**
 * 运行时适配：把既有会话协调器收窄成文稿域需要的四件事。
 *
 * 这里刻意不新增任何通道：读取运行时三元组/状态走协调器既有能力，分发与取消走
 * 既有 `send`/`abort`，扩展事件走既有的主进程内 pi 事件订阅。文稿域拿不到
 * 第二个模型通道，也不能直接写 Pi JSONL。
 */
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import type { AgentRuntimeState, AgentStatus, ChatMessage } from "../../shared/types";
import type { SessionRuntimeTriple } from "../../shared/types/documentWork";
import { sameRuntimeTriple } from "../../shared/documentWork";

export type DocumentWorkRuntimeSnapshot = {
	target: SessionRuntimeTriple;
	status: AgentStatus;
	state: AgentRuntimeState;
	messages: ChatMessage[];
	/**
	 * pi 进程自身的会话 id（AgentTab.sessionId / piSessionId）。
	 * 与 `target.sessionId`（稳定的 SessionRecord.id）语义不同：新建草稿时两者必然不同，
	 * 因此绑定载荷必须同时携带两个身份，扩展用原生 id 校验，工作记录用稳定 id 做主键。
	 */
	nativeSessionId?: string;
};

export type DocumentWorkDispatchOutcome = { accepted: boolean; unknown: boolean; error?: string };

export type DocumentWorkRuntimePort = {
	readRuntime(sessionId: string): Promise<DocumentWorkRuntimeSnapshot | undefined>;
	dispatch(input: { sessionId: string; requestId: string; message: string; expectedRuntime: SessionRuntimeTriple }): Promise<DocumentWorkDispatchOutcome>;
	abort(input: { sessionId: string; requestId: string; expectedRuntime: SessionRuntimeTriple }): Promise<DocumentWorkDispatchOutcome>;
	/** 会话是否有在途分发（协调器的 dispatch lease）；有就不算稳定完成。 */
	hasDispatchInFlight(sessionId: string): boolean;
	subscribeOutputs(listener: (channel: string, payload: unknown) => void): () => void;
	subscribePiEvents(listener: (agentId: string, event: unknown) => void): () => void;
};

export type SettleOutcome = "settled" | "timeout" | "runtime_changed" | "cancelled";

const SETTLE_FALLBACK_INTERVAL_MS = 10_000;

/**
 * 稳定完成的唯一判据：回合结束、无流式、未压缩、无工具执行、无在途分发。
 * `agent_end` 单独一项不构成完成（压缩、重试收尾和排队输入都可能还在跑）。
 */
export function isRuntimeSettled(status: AgentStatus | undefined, state: AgentRuntimeState | undefined): boolean {
	if (status !== "idle") return false;
	if (!state) return false;
	if (state.isStreaming === true) return false;
	if (state.isTurnActive === true) return false;
	if (state.isCompacting === true) return false;
	if (state.isExecutingTool === true) return false;
	return true;
}

export function runtimeTripleOf(payload: unknown): SessionRuntimeTriple | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const agentId = Reflect.get(payload, "agentId");
	const sessionId = Reflect.get(payload, "sessionId");
	const runtimeGeneration = Reflect.get(payload, "runtimeGeneration");
	if (typeof agentId !== "string" || typeof sessionId !== "string" || typeof runtimeGeneration !== "number") return undefined;
	return { sessionId, agentId, runtimeGeneration };
}

export class DocumentWorkRuntimeAdapter {
	/** 最近一次观察到的运行时状态，按 sessionId 归档；运行时替换即覆盖。 */
	private readonly latest = new Map<string, { target: SessionRuntimeTriple; status: AgentStatus; state: AgentRuntimeState }>();
	private readonly waiters = new Set<() => void>();
	private unsubscribe: (() => void) | undefined;
	/** 停止后等待中的结算必须立刻收敛，而不是永远挂在 await 上。 */
	private stopped = false;

	constructor(private readonly port: DocumentWorkRuntimePort) {}

	start(): void {
		if (this.unsubscribe) return;
		this.stopped = false;
		this.unsubscribe = this.port.subscribeOutputs((_channel, payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const agentId = Reflect.get(payload, "agentId");
			const state = Reflect.get(payload, "state");
			if (typeof agentId !== "string" || typeof state !== "object" || state === null) return;
			const triple = runtimeTripleOf(payload);
			if (triple) {
				// status 是「本轮是否还在跑」的一半证据；补丁不带 status 时沿用上一次，
				// 带 status 时必须采纳，否则完成边沿永远到不了。
				const status = Reflect.get(payload, "status");
				this.note(triple, typeof status === "string" ? (status as AgentStatus) : undefined, state as AgentRuntimeState);
			}
			this.wake();
		});
	}

	stop(): void {
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// 先唤醒再清空：让等待中的 waitForSettle 重新检查取消条件后返回。
		this.wake();
		this.latest.clear();
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	/** 本轮是否观察到非稳定（即真的在跑）状态；用于区分「跑过」与「还没开始」。 */
	isBusyFor(sessionId: string, target: SessionRuntimeTriple): boolean {
		const cached = this.latest.get(sessionId);
		if (!cached || !sameRuntimeTriple(cached.target, target)) return false;
		return !isRuntimeSettled(cached.status, cached.state);
	}

	/** 等下一次状态变化或超时；结算协程用它做事件驱动的轮询而不是忙等。 */
	async waitForChange(timeoutMs: number): Promise<void> {
		await this.waitForSignal(timeoutMs);
	}

	/** 经既有 send 通道投递控制命令：只传 sessionId/requestId/message/expectedRuntime。 */
	async sendCommand(input: { sessionId: string; requestId: string; message: string; expectedRuntime: SessionRuntimeTriple }): Promise<DocumentWorkDispatchOutcome> {
		return this.port.dispatch(input);
	}

	async abort(input: { sessionId: string; requestId: string; expectedRuntime: SessionRuntimeTriple }): Promise<DocumentWorkDispatchOutcome> {
		return this.port.abort(input);
	}

	/** 事件驱动的状态缓存；`status` 可能不随补丁到达，缺省沿用上一次。 */
	note(target: SessionRuntimeTriple, status: AgentStatus | undefined, state: AgentRuntimeState): void {
		const previous = this.latest.get(target.sessionId);
		const sameTarget = previous && sameRuntimeTriple(previous.target, target);
		this.latest.set(target.sessionId, { target, status: status ?? (sameTarget ? previous.status : "idle"), state: sameTarget ? { ...previous.state, ...state } : state });
	}

	subscriber(listener: (agentId: string, event: unknown) => void): () => void {
		return this.port.subscribePiEvents(listener);
	}

	async snapshot(sessionId: string): Promise<DocumentWorkRuntimeSnapshot | undefined> {
		const runtime = await this.port.readRuntime(sessionId);
		if (!runtime) return undefined;
		this.note(runtime.target, runtime.status, runtime.state);
		return runtime;
	}

	cached(sessionId: string): { target: SessionRuntimeTriple; status: AgentStatus; state: AgentRuntimeState } | undefined {
		return this.latest.get(sessionId);
	}

	isSettledFor(sessionId: string, target: SessionRuntimeTriple): boolean {
		const cached = this.latest.get(sessionId);
		if (!cached || !sameRuntimeTriple(cached.target, target)) return false;
		if (this.port.hasDispatchInFlight(sessionId)) return false;
		return isRuntimeSettled(cached.status, cached.state);
	}

	/**
	 * 等待稳定完成。事件是第一信号，另有低频兜底读取，避免某个补丁缺失时永远等下去；
	 * 运行时替换或取消立即返回对应结论，绝不把旧 runtime 的结束信号算成新 runtime 的。
	 */
	async waitForSettle(input: { target: SessionRuntimeTriple; timeoutMs: number; isCancelled: () => boolean }): Promise<SettleOutcome> {
		const deadline = Date.now() + input.timeoutMs;
		while (Date.now() < deadline) {
			if (this.stopped || input.isCancelled()) return "cancelled";
			const cached = this.latest.get(input.target.sessionId);
			if (cached && !sameRuntimeTriple(cached.target, input.target)) return "runtime_changed";
			if (this.isSettledFor(input.target.sessionId, input.target)) return "settled";
			const waited = await this.waitForSignal(Math.min(SETTLE_FALLBACK_INTERVAL_MS, Math.max(1, deadline - Date.now())));
			if (!waited) {
				// 兜底：事件稀疏时主动问一次协调器，确认绑定没有换、状态确实已稳定。
				const snapshot = await this.snapshot(input.target.sessionId).catch(() => undefined);
				if (!snapshot) return "runtime_changed";
				if (!sameRuntimeTriple(snapshot.target, input.target)) return "runtime_changed";
			}
		}
		return "timeout";
	}

	private waitForSignal(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = delay(() => {
				this.waiters.delete(wake);
				resolve(false);
			}, timeoutMs);
			const wake = () => {
				clearDelay(timer);
				this.waiters.delete(wake);
				resolve(true);
			};
			this.waiters.add(wake);
		});
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter();
	}
}
