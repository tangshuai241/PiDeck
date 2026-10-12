/**
 * TPA 独立文稿：运行时适配层。
 *
 * 主进程与 Pi 之间**只有已有的 stdio JSON-RPC**：绑定经注册命令 `/tpa-work bind` 下发，
 * 汇报经隐藏 `custom_message` 回来。本模块把这两条既有通道翻译成有类型的领域事件，
 * 并负责身份隔离与清理：
 *
 * - 每个事件都带 `agentId + sessionId + runtimeGeneration`，与当前绑定不符的事件标 `stale`；
 * - `agent_end` 只作为"底层 run 结束"的提示，**不是**归档依据（方案要求等
 *   `agent_settled` 或权威 idle 判据）；
 * - 订阅在 `start()` 建立、`dispose()` 解除，进程停止/换代/删会话/退出都要走到；
 * - 迟到候选按 attemptId 归档，不能绑定到新运行。
 */
import { parseBindingState, parseArtifactCandidateReport } from "../../shared/documentWork";
import type { AlignmentBrief } from "../../shared/types/alignment";
import { DOCUMENT_WORK_STATE_TYPE, type DocumentArtifactCandidateReport, type DocumentWorkBindingState } from "../../shared/types/documentWork";

export type DocumentWorkRuntimeTarget = { sessionId: string; agentId: string; runtimeGeneration: number };

/** 权威对齐快照的瘦投影；`brief` 用于取本轮已确认的范围与保留项。 */
export type DocumentWorkAlignmentSnapshot = { briefId: string; revision: number; phase: string; hasOpenQuestions?: boolean; brief?: AlignmentBrief };

/** 领域侧端口：由装配层用 SessionRuntimeCoordinator/AgentManager 实现。 */
export type DocumentWorkRuntimePort = {
	/** 会话当前权威运行时三元组；没有活动运行时时返回 undefined。 */
	resolveRuntime(sessionId: string): Promise<DocumentWorkRuntimeTarget | undefined>;
	/** agentId → 当前绑定（用于识别迟到事件来自已被替换的进程）。 */
	readRuntimeBinding(agentId: string): { sessionId: string; runtimeGeneration: number } | undefined;
	/** 权威对齐快照（原生投影），用于核对确认单版本。 */
	readAlignment(target: DocumentWorkRuntimeTarget): Promise<DocumentWorkAlignmentSnapshot | undefined>;
	/** 读取某个用户轮次的原文（授权核对用）；读不到返回 undefined。 */
	readUserTurnText(sessionId: string, turnId: string): Promise<string | undefined>;
	/** 运行时是否忙碌/有排队输入；忙碌时拒绝分发。 */
	runtimeFlags(target: DocumentWorkRuntimeTarget): Promise<{ busy: boolean; queued: boolean }>;
	/** 经既有发送接口下发控制命令（`/tpa-work ...`）。 */
	sendControl(input: { sessionId: string; requestId: string; message: string; expectedRuntime: DocumentWorkRuntimeTarget }): Promise<{ accepted: boolean; error?: string }>;
	/** 只取消匹配运行时上的本轮运行。 */
	abort(target: DocumentWorkRuntimeTarget): Promise<void>;
	/** 从 Pi 活动分支读取隐藏状态（补登记用）。 */
	readHistory(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[] }>;
};

export type DocumentWorkRuntimeEvent =
	| { kind: "binding"; target: DocumentWorkRuntimeTarget; state: DocumentWorkBindingState; stale: boolean }
	| { kind: "report"; target: DocumentWorkRuntimeTarget; report: DocumentArtifactCandidateReport; stale: boolean }
	| { kind: "agent_end"; target: DocumentWorkRuntimeTarget; stopReason?: string; stale: boolean }
	| { kind: "settled"; target: DocumentWorkRuntimeTarget; stale: boolean }
	| { kind: "runtime_replaced"; target: DocumentWorkRuntimeTarget };

type RawEventSource = {
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void;
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void;
};

export type DocumentWorkRuntimeAdapterOptions = {
	ports: DocumentWorkRuntimePort;
	/** AgentManager（或测试替身）的原始事件源。 */
	events: RawEventSource;
	/** 最近事件保留条数（每个 agent），防止长会话无界增长。 */
	maxRetainedEvents?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DocumentWorkRuntimeAdapter {
	private readonly ports: DocumentWorkRuntimePort;
	private readonly events: RawEventSource;
	private readonly listeners = new Set<(event: DocumentWorkRuntimeEvent) => void>();
	private readonly retained = new Map<string, DocumentWorkRuntimeEvent[]>();
	private readonly maxRetained: number;
	private disposers: Array<() => void> = [];
	private started = false;

	constructor(options: DocumentWorkRuntimeAdapterOptions) {
		this.ports = options.ports;
		this.events = options.events;
		this.maxRetained = options.maxRetainedEvents ?? 200;
	}

	/** 与 `dispose()` 配对；重复调用是幂等的。 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.disposers.push(
			this.events.addLocalEventListener((agentId, event) => {
				void this.onRawEvent(agentId, event);
			}),
			this.events.onAgentSettled(({ agentId }) => {
				const binding = this.ports.readRuntimeBinding(agentId);
				if (!binding) return;
				this.publish({ kind: "settled", target: { sessionId: binding.sessionId, agentId, runtimeGeneration: binding.runtimeGeneration }, stale: this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) });
			}),
		);
	}

	dispose(): void {
		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose();
			} catch {
				// 解绑失败不能阻断其它清理路径。
			}
		}
		this.listeners.clear();
		this.retained.clear();
		this.started = false;
	}

	subscribe(listener: (event: DocumentWorkRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 事件与当前绑定不符（换进程/换代）时标记，消费方按自己的 attemptId 决定忽略。 */
	private isStale(agentId: string, sessionId: string, runtimeGeneration: number): boolean {
		const binding = this.ports.readRuntimeBinding(agentId);
		if (!binding) return true;
		return binding.sessionId !== sessionId || binding.runtimeGeneration !== runtimeGeneration;
	}

	private async onRawEvent(agentId: string, event: unknown): Promise<void> {
		if (!isRecord(event)) return;
		const binding = this.ports.readRuntimeBinding(agentId);
		if (!binding) return;
		// 事件自报的世代与当前绑定不一致 = 来自已被替换的进程，必须标 stale 而不是当成本轮结果。
		const claimedGeneration = typeof event.runtimeGeneration === "number" ? event.runtimeGeneration : undefined;
		const generationMismatch = claimedGeneration !== undefined && claimedGeneration !== binding.runtimeGeneration;
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			const last = messages.length > 0 && isRecord(messages[messages.length - 1]) ? (messages[messages.length - 1] as Record<string, unknown>) : undefined;
			const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
			this.publish({ kind: "agent_end", target: { sessionId: binding.sessionId, agentId, runtimeGeneration: binding.runtimeGeneration }, ...(stopReason ? { stopReason } : {}), stale: generationMismatch || this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) });
			return;
		}
		if (event.type !== "message_end") return;
		const target: DocumentWorkRuntimeTarget = { sessionId: binding.sessionId, agentId, runtimeGeneration: binding.runtimeGeneration };
		// Hidden custom messages are the only authoritative source; a tool result cannot self-approve.
		const parsed = this.extractState(event.message);
		if (!parsed) return;
		const stale = generationMismatch || this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) || parsed.sessionId !== binding.sessionId;
		if (parsed.binding) this.publish({ kind: "binding", target, state: parsed.binding, stale });
		if (parsed.report) this.publish({ kind: "report", target, report: parsed.report, stale });
	}

	private extractState(message: unknown): { sessionId: string; binding?: DocumentWorkBindingState; report?: DocumentArtifactCandidateReport } | undefined {
		if (!isRecord(message) || message.role !== "custom" || message.customType !== DOCUMENT_WORK_STATE_TYPE) return undefined;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) return undefined;
		const binding = details.documentWork === undefined ? undefined : parseBindingState(details.documentWork);
		const report = details.report === undefined ? undefined : parseArtifactCandidateReport(details.report);
		if (!binding && !report) return undefined;
		const sessionId = binding?.sessionId ?? (isRecord(details.report) && typeof details.report.sessionId === "string" ? details.report.sessionId : undefined);
		if (!sessionId) return undefined;
		return { sessionId, ...(binding ? { binding } : {}), ...(report ? { report } : {}) };
	}

	private publish(event: DocumentWorkRuntimeEvent): void {
		const bucket = this.retained.get(event.target.agentId) ?? [];
		bucket.push(event);
		if (bucket.length > this.maxRetained) bucket.splice(0, bucket.length - this.maxRetained);
		this.retained.set(event.target.agentId, bucket);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// 单个监听器抛错不能打断其它消费者或 Pi 事件流。
			}
		}
	}

	/** 等待满足谓词的领域事件；超时返回 undefined（调用方按"未知"处理，不自动重放）。 */
	async waitFor(predicate: (event: DocumentWorkRuntimeEvent) => boolean, timeoutMs: number): Promise<DocumentWorkRuntimeEvent | undefined> {
		for (const bucket of this.retained.values()) {
			const hit = bucket.find(predicate);
			if (hit) return hit;
		}
		return await new Promise<DocumentWorkRuntimeEvent | undefined>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribe = this.subscribe((event) => {
				if (!predicate(event)) return;
				if (timer) clearTimeout(timer);
				unsubscribe();
				resolve(event);
			});
			timer = setTimeout(() => {
				unsubscribe();
				resolve(undefined);
			}, timeoutMs);
			timer.unref?.();
		});
	}

	/** 按身份取出本轮汇报：attemptId + preparationId + digest 三者齐全才匹配。 */
	findReport(wanted: { attemptId: string; preparationId: string; digest: string }): DocumentArtifactCandidateReport | undefined {
		for (const bucket of this.retained.values()) {
			for (const event of bucket) {
				if (event.kind !== "report" || event.stale || !event.report) continue;
				if (event.report.attemptId === wanted.attemptId && event.report.preparationId === wanted.preparationId && event.report.digest === wanted.digest) return event.report;
			}
		}
		return undefined;
	}

	/** 绑定确认：必须同时匹配 attemptId、preparationId、digest 与运行时三元组。 */
	async awaitBinding(input: { target: DocumentWorkRuntimeTarget; attemptId: string; preparationId: string; digest: string; timeoutMs: number }): Promise<WorkBindingOutcome> {
		const event = await this.waitFor(
			(candidate) =>
				candidate.kind === "binding" &&
				!candidate.stale &&
				candidate.target.agentId === input.target.agentId &&
				candidate.target.runtimeGeneration === input.target.runtimeGeneration &&
				candidate.state.attemptId === input.attemptId &&
				candidate.state.preparationId === input.preparationId &&
				candidate.state.digest === input.digest,
			input.timeoutMs,
		);
		if (!event || event.kind !== "binding") return { ok: false, reason: "the pi extension did not confirm this binding in time" };
		return { ok: true, state: event.state };
	}

	/** 从活动分支补登记：扩展关闭/重启后仍能核对历史候选，但不恢复执行授权。 */
	async backfill(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[] }> {
		try {
			return await this.ports.readHistory(agentId);
		} catch {
			return { bindings: [], reports: [] };
		}
	}
}

export type WorkBindingOutcome = { ok: true; state: DocumentWorkBindingState } | { ok: false; reason: string };

/** 判断运行时是否已换绑：分发前后各查一次，任何窗口内替换都必须中止。 */
export async function runtimeStillMatches(ports: Pick<DocumentWorkRuntimePort, "resolveRuntime">, expected: DocumentWorkRuntimeTarget): Promise<boolean> {
	const current = await ports.resolveRuntime(expected.sessionId);
	return Boolean(current && current.agentId === expected.agentId && current.runtimeGeneration === expected.runtimeGeneration);
}
