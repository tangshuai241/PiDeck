/**
 * 会话状态摘要服务：把现有运行时状态、待回答请求与持久化的结果记录合成一份
 * 桌面和手机共用的摘要，并在变化时推给订阅方。
 *
 * 边界：
 * - 运行/待回答只读现有模块（SessionRuntimeCoordinator + AgentManager），不另建状态机；
 * - 一轮执行的开始/结束由 AgentManager 生命周期回调驱动，结果写入 SessionAttentionStore；
 * - 摘要按会话去重后推送，客户端只消费，不自行推断已读。
 */
import type { AgentManager } from "../../pi/AgentManager";
import type { SessionRuntimeCoordinator } from "../../sessions/SessionRuntimeCoordinator";
import type { SessionAttentionSummary, SessionCompletion } from "../../../shared/types/sessionAttention";
import type { AgentRunOutcome } from "../../../shared/types/agent";
import { askQuestionSummary } from "../../../../packages/tpa-remote/src/ask";
import type { SessionAttentionStore } from "./SessionAttentionStore";

type LiveRuntime = { sessionId: string; status: string };
type PendingAsk = { sessionId: string; title: string; batchQuestions?: ReadonlyArray<{ question: string }> };

export type SessionAttentionServiceDeps = {
	agents: Pick<AgentManager, "list" | "addStateListener" | "onAgentRunFinished">;
	runtime: Pick<SessionRuntimeCoordinator, "listRuntimes" | "listPendingUiRequests" | "getRuntimeBinding" | "setAskChangeNotifier">;
	store: SessionAttentionStore;
};

export class SessionAttentionService {
	private readonly listeners = new Set<(summary: SessionAttentionSummary) => void>();
	private readonly published = new Map<string, string>();
	/** 上一轮推送中处于 starting/running 的会话：状态退出时也要推一次 running:false。 */
	private readonly activeSessions = new Set<string>();
	private started = false;
	private cleanups: Array<() => void> = [];

	constructor(private readonly deps: SessionAttentionServiceDeps) {}

	/** 读盘（含中断恢复）后开始订阅；重复调用无副作用。 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		// 先订阅再读盘：加载窗口内的运行/提问变化不能被漏掉。
		this.cleanups.push(this.deps.agents.addStateListener(() => this.observeState()));
		this.cleanups.push(this.deps.agents.onAgentRunFinished((info) => this.onRunFinished(info.agentId, info.outcome)));
		this.deps.runtime.setAskChangeNotifier((sessionId) => this.publish([sessionId]));
		await this.deps.store.load();
		// 读盘恢复的未读结果要主动推一次：订阅方不会重新拉全量。
		this.publish(this.list().map((summary) => summary.sessionId));
		this.observeState();
	}

	dispose(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.deps.runtime.setAskChangeNotifier(undefined);
		this.listeners.clear();
		this.activeSessions.clear();
	}

	subscribe(listener: (summary: SessionAttentionSummary) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 全部摘要：只包含有运行、待回答或结果记录的会话。 */
	list(): SessionAttentionSummary[] {
		const live = liveBySession(this.deps.runtime.listRuntimes());
		const pending = pendingBySession(this.deps.runtime.listPendingUiRequests());
		const ids = new Set<string>([...live.keys(), ...pending.keys()]);
		for (const [sessionId] of this.deps.store.listEntries()) ids.add(sessionId);
		return [...ids].map((sessionId) => this.buildSummary(sessionId, live.get(sessionId)?.status, pending.get(sessionId)));
	}

	summaryFor(sessionId: string): SessionAttentionSummary {
		const live = this.deps.runtime.listRuntimes().find((item) => item.sessionId === sessionId);
		const pending = pendingBySession(this.deps.runtime.listPendingUiRequests().filter((item) => item.sessionId === sessionId));
		return this.buildSummary(sessionId, live?.status, pending.get(sessionId));
	}

	/** 端上实际看到结果后确认已读；只对当前结果身份生效。 */
	acknowledge(sessionId: string, completionId: string): SessionAttentionSummary {
		this.deps.store.acknowledge(sessionId, completionId);
		const summary = this.summaryFor(sessionId);
		this.publishSummary(summary);
		return summary;
	}

	private buildSummary(sessionId: string, status: string | undefined, pending: PendingAsk[] | undefined): SessionAttentionSummary {
		const entry = this.deps.store.get(sessionId);
		const completion: SessionCompletion | undefined = entry?.completion ? { ...entry.completion } : undefined;
		const summary: SessionAttentionSummary = {
			sessionId,
			running: status === "running" || status === "starting",
			// 行内展示题目数量：批量题按题目数累计，会话级待回答计数由客户端按「>0 的会话数」统计。
			pendingQuestionCount: pending?.reduce((sum, item) => sum + Math.max(1, item.batchQuestions?.length ?? 0), 0) ?? 0,
			completionUnread: Boolean(completion && entry?.handledCompletionId !== completion.id),
		};
		const first = pending?.[0];
		const question = first ? askQuestionSummary({ title: first.title, questions: first.batchQuestions }) : undefined;
		if (question) summary.pendingQuestionSummary = question;
		if (completion) summary.completion = completion;
		return summary;
	}

	private observeState(): void {
		const active = new Set<string>();
		for (const item of this.deps.runtime.listRuntimes()) {
			if (item.status !== "running" && item.status !== "starting") continue;
			active.add(item.sessionId);
			// 只有真正执行（running）才开启一轮；仅仅启动进程（starting）随后空闲不应留下假结果。
			if (item.status === "running") this.deps.store.beginRun(item.sessionId);
		}
		// 退出运行（idle/error/closed/解绑）也必须推送一次，否则客户端保留最后一次 running:true。
		const changed = new Set([...active, ...this.activeSessions]);
		this.activeSessions.clear();
		for (const sessionId of active) this.activeSessions.add(sessionId);
		this.publish(changed);
	}

	private onRunFinished(agentId: string, outcome: AgentRunOutcome): void {
		const binding = this.deps.runtime.getRuntimeBinding(agentId);
		if (!binding) return;
		const runId = this.deps.store.activeRunId(binding.sessionId);
		if (!runId) return;
		if (!this.deps.store.finishRun(binding.sessionId, runId, outcome)) return;
		this.publish([binding.sessionId]);
	}

	private publish(sessionIds: Iterable<string>): void {
		for (const sessionId of new Set(sessionIds)) this.publishSummary(this.summaryFor(sessionId));
	}

	private publishSummary(summary: SessionAttentionSummary): void {
		const fingerprint = JSON.stringify(summary);
		if (this.published.get(summary.sessionId) === fingerprint) return;
		this.published.set(summary.sessionId, fingerprint);
		for (const listener of this.listeners) {
			try {
				listener(summary);
			} catch {}
		}
	}
}

function liveBySession(items: LiveRuntime[]): Map<string, LiveRuntime> {
	return new Map(items.map((item) => [item.sessionId, item]));
}

function pendingBySession(items: PendingAsk[]): Map<string, PendingAsk[]> {
	const result = new Map<string, PendingAsk[]>();
	for (const item of items) {
		const list = result.get(item.sessionId);
		if (list) list.push(item);
		else result.set(item.sessionId, [item]);
	}
	return result;
}
