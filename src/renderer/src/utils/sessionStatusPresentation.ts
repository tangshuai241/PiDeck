/**
 * 会话状态的统一展示规则（任务书 §6.2）：标签、项目列表、活动列表、标题栏共用。
 *
 * 输入只包含现有事实：运行时状态、待回答标记/题目、最近结果与未读。
 * 纯函数，不依赖 React/Jotai，便于单测；颜色/图标由组件按 kind 落地。
 */
import type { SessionAttentionSummary, SessionCompletionOutcome } from "../../../shared/types/sessionAttention";

export type SessionStatusKind = "running" | "waiting" | "unread" | "stopped" | "error" | "idle" | "none";

export type SessionStatusPresentation = {
	kind: SessionStatusKind;
	/** 待回答时的问题摘要（单题问题或批量题第一题） */
	summary?: string;
	/** 未读结果的分类 */
	outcome?: SessionCompletionOutcome;
	/** 未读标记 */
	unread?: boolean;
	labelKey: "app.statusRunning" | "app.statusWaiting" | "app.statusUnreadSucceeded" | "app.statusUnreadFailed" | "app.statusUnreadInterrupted" | "app.statusStopped" | "app.statusError" | "app.statusIdle" | "app.statusStarting";
};

export type SessionStatusInput = {
	status?: string | null;
	waiting?: boolean;
	busy?: boolean;
	attention?: Pick<SessionAttentionSummary, "running" | "pendingQuestionCount" | "pendingQuestionSummary" | "completion" | "completionUnread">;
};

const UNREAD_LABELS: Record<Exclude<SessionCompletionOutcome, "aborted">, SessionStatusPresentation["labelKey"]> = {
	succeeded: "app.statusUnreadSucceeded",
	failed: "app.statusUnreadFailed",
	interrupted: "app.statusUnreadInterrupted",
};

export function presentSessionStatus(input: SessionStatusInput): SessionStatusPresentation {
	const attention = input.attention;
	// 重启/停止/重载等操作反馈优先。
	if (input.busy) return { kind: "running", labelKey: "app.statusRunning" };
	// 等待回答优先于「仍在执行」的运行时状态：Agent 阻塞在提问时，静态标记才是用户需要看到的提示，
	// 不能继续用旋转图标冒充计算中（任务书 §6.2）。
	if (input.waiting || input.status === "waiting" || input.status === "pending" || (attention?.pendingQuestionCount ?? 0) > 0) {
		return { kind: "waiting", labelKey: "app.statusWaiting", ...(attention?.pendingQuestionSummary ? { summary: attention.pendingQuestionSummary } : {}) };
	}
	if (input.status === "running" || input.status === "starting" || attention?.running) {
		return { kind: "running", labelKey: input.status === "starting" ? "app.statusStarting" : "app.statusRunning" };
	}
	const completion = attention?.completion;
	if (attention?.completionUnread && completion) {
		if (completion.outcome === "aborted") return { kind: "stopped", labelKey: "app.statusStopped" };
		return { kind: "unread", labelKey: UNREAD_LABELS[completion.outcome], outcome: completion.outcome, unread: true };
	}
	// 主动停止保留结果类型，但不产生完成提醒；已读后回到普通「已停止」样式。
	if (completion?.outcome === "aborted") return { kind: "stopped", labelKey: "app.statusStopped" };
	if (input.status === "error") return { kind: "error", labelKey: "app.statusError" };
	if (input.status === "idle") return { kind: "idle", labelKey: "app.statusIdle" };
	return { kind: "none", labelKey: "app.statusIdle" };
}
