/**
 * TPA 独立文稿：运行时适配层。
 *
 * 主进程与 Pi 之间**只有已有的 stdio JSON-RPC**：绑定经注册命令 `/tpa-work bind` 下发，
 * 汇报与改稿意向经隐藏 `custom_message` 回来。本模块把这两条既有通道翻译成有类型的
 * 领域事件，并负责身份隔离与清理：
 *
 * - 每个事件都带 `agentId + 稳定 sessionId + runtimeGeneration`，与当前绑定不符的事件标 `stale`；
 * - **原生身份**：pi 进程内只能看到原生会话 id（`ctx.sessionManager.getSessionId()`），
 *   而主进程需要稳定 catalog 会话 id。绑定确认同时核对两者，避免"新草稿稳定 id
 *   与原生 id 不同 → 所有绑定都被拒"这类错配；
 * - `agent_end` 只作为"底层 run 结束"的提示，**不是**归档依据（等 `agent_settled`）；
 * - 订阅在 `start()` 建立、`dispose()` 解除；迟到候选按 attemptId 归档。
 */
import { parseBindingState, parseArtifactCandidateReport, parseRevisionIntent } from "../../shared/documentWork";
import type { AlignmentBrief } from "../../shared/types/alignment";
import { DOCUMENT_WORK_INTENT_TYPE, DOCUMENT_WORK_STATE_TYPE, type DocumentArtifactCandidateReport, type DocumentWorkBindingState, type DocumentWorkRevisionIntent } from "../../shared/types/documentWork";

/**
 * 运行时目标：稳定会话身份 + 原生 Pi 身份 + 运行时三元组 + 项目根。
 *
 * `sessionId` 是 catalog 的稳定会话 id（跨重启不变）；`piSessionId` 是 pi 会话文件头里的
 * 原生 id。两者不同是常态（见 `SessionRuntimeCoordinator.buildAttachPatch` 的
 * `sessionId` / `piSessionId` 两个体系），因此绑定校验必须用 `piSessionId`。
 */
export type DocumentWorkRuntimeTarget = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	/** 原生 Pi 会话 id；拿不到时为空（此时不允许绑定）。 */
	piSessionId?: string;
	/** 会话项目目录（材料读取的授权根之一）。 */
	projectRoot?: string;
};

/** 权威对齐快照的瘦投影；`brief` 用于取本轮已确认的范围与保留项。 */
export type DocumentWorkAlignmentSnapshot = { briefId: string; revision: number; phase: string; hasOpenQuestions?: boolean; brief?: AlignmentBrief };

/** 一轮用户消息的权威快照（授权核对只用它，不信 Renderer 与模型自报）。 */
export type DocumentUserTurnSnapshot = {
	/** 稳定原生 entry id。 */
	entryId: string;
	role: "user" | "assistant" | "system" | "tool" | "other";
	/** 从会话里读回的**当前**正文（用户编辑过就是编辑后的正文）。 */
	text: string;
	/** 正文指纹；准备阶段冻结它，分发前复查，正文被改即失效。 */
	textDigest: string;
	/** 这一轮是否是本会话最后一条用户消息（旧轮不得构成新授权）。 */
	isLatestUserTurn: boolean;
};

/** 领域侧端口：由装配层用 SessionRuntimeCoordinator/AgentManager 实现。 */
export type DocumentWorkRuntimePort = {
	/** 会话当前权威运行时三元组 + 原生身份；没有活动运行时时返回 undefined。 */
	resolveRuntime(sessionId: string): Promise<DocumentWorkRuntimeTarget | undefined>;
	/** agentId → 当前绑定（识别迟到事件来自已被替换的进程）。 */
	readRuntimeBinding(agentId: string): { sessionId: string; runtimeGeneration: number } | undefined;
	/** 权威对齐快照（原生投影），用于核对确认单版本。 */
	readAlignment(target: DocumentWorkRuntimeTarget): Promise<DocumentWorkAlignmentSnapshot | undefined>;
	/** 读取某个用户轮次的权威快照；读不到返回 undefined。 */
	readUserTurn(input: { sessionId: string; turnId: string }): Promise<DocumentUserTurnSnapshot | undefined>;
	/** 运行时是否忙碌/有排队输入；忙碌时拒绝分发。 */
	runtimeFlags(target: DocumentWorkRuntimeTarget): Promise<{ busy: boolean; queued: boolean }>;
	/** 经既有发送接口下发控制命令（`/tpa-work ...`）。 */
	sendControl(input: { sessionId: string; requestId: string; message: string; expectedRuntime: DocumentWorkRuntimeTarget }): Promise<{ accepted: boolean; error?: string }>;
	/** 只取消匹配运行时上的本轮运行。 */
	abort(target: DocumentWorkRuntimeTarget): Promise<void>;
	/** 从 Pi 活动分支读取隐藏状态（补登记用）。 */
	readHistory(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[]; intents: DocumentWorkRevisionIntent[] }>;
};

export type DocumentWorkRuntimeEvent =
	| { kind: "binding"; target: DocumentWorkRuntimeTarget; state: DocumentWorkBindingState; stale: boolean }
	| { kind: "report"; target: DocumentWorkRuntimeTarget; report: DocumentArtifactCandidateReport; stale: boolean }
	| { kind: "intent"; target: DocumentWorkRuntimeTarget; intent: DocumentWorkRevisionIntent; stale: boolean }
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
				this.publish({ kind: "settled", target: this.targetFor(agentId, binding.sessionId, binding.runtimeGeneration), stale: this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) });
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

	/** 事件只带 agentId；原生身份用当时的绑定补齐，拿不到就不带（消费方按缺身份处理）。 */
	private targetFor(agentId: string, sessionId: string, runtimeGeneration: number): DocumentWorkRuntimeTarget {
		return { sessionId, agentId, runtimeGeneration };
	}

	private async onRawEvent(agentId: string, event: unknown): Promise<void> {
		if (!isRecord(event)) return;
		const binding = this.ports.readRuntimeBinding(agentId);
		if (!binding) return;
		// 事件自报的世代与当前绑定不一致 = 来自已被替换的进程，必须标 stale 而不是当成本轮结果。
		const claimedGeneration = typeof event.runtimeGeneration === "number" ? event.runtimeGeneration : undefined;
		const generationMismatch = claimedGeneration !== undefined && claimedGeneration !== binding.runtimeGeneration;
		const target = this.targetFor(agentId, binding.sessionId, binding.runtimeGeneration);
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			const last = messages.length > 0 && isRecord(messages[messages.length - 1]) ? (messages[messages.length - 1] as Record<string, unknown>) : undefined;
			const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
			this.publish({ kind: "agent_end", target, ...(stopReason ? { stopReason } : {}), stale: generationMismatch || this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) });
			return;
		}
		if (event.type !== "message_end") return;
		const parsed = this.extractState(event.message);
		if (!parsed) return;
		const stale = generationMismatch || this.isStale(agentId, binding.sessionId, binding.runtimeGeneration) || parsed.stableSessionId !== binding.sessionId;
		if (parsed.binding) this.publish({ kind: "binding", target, state: parsed.binding, stale });
		if (parsed.report) this.publish({ kind: "report", target, report: parsed.report, stale });
		if (parsed.intent) this.publish({ kind: "intent", target, intent: parsed.intent, stale });
	}

	private extractState(message: unknown): { stableSessionId: string; binding?: DocumentWorkBindingState; report?: DocumentArtifactCandidateReport; intent?: DocumentWorkRevisionIntent } | undefined {
		if (!isRecord(message) || message.role !== "custom") return undefined;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) return undefined;
		if (message.customType === DOCUMENT_WORK_INTENT_TYPE) {
			const intent = details.intent === undefined ? undefined : parseRevisionIntent(details.intent);
			// 候选只带稳定会话 id 作路由提示；消费方必须自己重新解析权威轮次。
			return intent ? { stableSessionId: intent.sessionId, intent } : undefined;
		}
		if (message.customType !== DOCUMENT_WORK_STATE_TYPE) return undefined;
		const binding = details.documentWork === undefined ? undefined : parseBindingState(details.documentWork);
		const report = details.report === undefined ? undefined : parseArtifactCandidateReport(details.report);
		if (!binding && !report) return undefined;
		const stableSessionId = binding?.sessionId ?? (isRecord(details.report) && typeof details.report.sessionId === "string" ? details.report.sessionId : undefined);
		return stableSessionId ? { stableSessionId, ...(binding ? { binding } : {}), ...(report ? { report } : {}) } : undefined;
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

	/**
	 * 绑定确认：必须同时匹配 attemptId、preparationId、digest、运行时三元组
	 * **以及原生会话 id**——扩展在 pi 进程里只能核对原生 id。
	 */
	async awaitBinding(input: { target: DocumentWorkRuntimeTarget; attemptId: string; preparationId: string; digest: string; timeoutMs: number }): Promise<WorkBindingOutcome> {
		const matches = (candidate: DocumentWorkRuntimeEvent): boolean =>
			candidate.kind === "binding" &&
			!candidate.stale &&
			candidate.target.agentId === input.target.agentId &&
			candidate.target.runtimeGeneration === input.target.runtimeGeneration &&
			candidate.state.attemptId === input.attemptId &&
			candidate.state.preparationId === input.preparationId &&
			candidate.state.digest === input.digest &&
			(input.target.piSessionId === undefined || candidate.state.nativeSessionId === input.target.piSessionId);
		const event = await this.waitFor(matches, input.timeoutMs);
		if (!event || event.kind !== "binding") return { ok: false, reason: "the pi extension did not confirm this binding in time" };
		return { ok: true, state: event.state };
	}

	/** 普通聊天的改稿意向（候选）：只回报，不代表授权，也不触发任何分发。 */
	async awaitRevisionIntent(input: { target: DocumentWorkRuntimeTarget; workId: string; timeoutMs: number }): Promise<DocumentWorkRevisionIntent | undefined> {
		const matches = (candidate: DocumentWorkRuntimeEvent): boolean => candidate.kind === "intent" && !candidate.stale && candidate.target.agentId === input.target.agentId && candidate.target.runtimeGeneration === input.target.runtimeGeneration && candidate.intent.workId === input.workId;
		const event = await this.waitFor(matches, input.timeoutMs);
		return event && event.kind === "intent" ? event.intent : undefined;
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

	/** 从活动分支补登记：扩展关闭/重启后仍能核对历史候选，但不恢复执行授权。 */
	async backfill(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[]; intents: DocumentWorkRevisionIntent[] }> {
		try {
			return await this.ports.readHistory(agentId);
		} catch {
			return { bindings: [], reports: [], intents: [] };
		}
	}
}

export type WorkBindingOutcome = { ok: true; state: DocumentWorkBindingState } | { ok: false; reason: string };

/** 判断运行时是否已换绑：分发前后各查一次，任何窗口内替换都必须中止。 */
export async function runtimeStillMatches(ports: Pick<DocumentWorkRuntimePort, "resolveRuntime">, expected: DocumentWorkRuntimeTarget): Promise<boolean> {
	const current = await ports.resolveRuntime(expected.sessionId);
	if (!current || current.agentId !== expected.agentId || current.runtimeGeneration !== expected.runtimeGeneration) return false;
	// 原生身份也要一致：同一次绑定期间 pi 不应该换会话文件。
	return expected.piSessionId === undefined || current.piSessionId === expected.piSessionId;
}
