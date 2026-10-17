/**
 * 会话状态摘要（桌面与手机共用）：运行、待回答、最近结果、结果已读。
 *
 * 运行/待回答由现有运行时派生，结果与已读由主进程持久化记录；
 * 客户端只读摘要，不自行推断「看完没看完」。
 */

import type { AgentRunOutcome } from "./agent";

/** 一轮执行的结果分类：成功、失败、主动停止、进程中断。 */
export type SessionCompletionOutcome = AgentRunOutcome;

/** 最近一轮结束结果。id 与该轮执行身份绑定，跨重启稳定。 */
export type SessionCompletion = {
	id: string;
	outcome: SessionCompletionOutcome;
	finishedAt: number;
};

export type SessionAttentionSummary = {
	sessionId: string;
	/** 当前进程是否在启动/执行（来自现有运行时状态） */
	running: boolean;
	/** 待回答请求数（一个会话多道题仍计一个会话，这里保留题数供行内展示） */
	pendingQuestionCount: number;
	/** 待回答入口展示的问题摘要（单题问题或批量题第一题） */
	pendingQuestionSummary?: string;
	/** 最近一次结束结果；老会话没有记录时为空 */
	completion?: SessionCompletion;
	/** 结果是否尚未被任一端确认已读 */
	completionUnread: boolean;
};

/** 状态摘要推送事件：一次变化只推受影响的会话。 */
export type SessionAttentionChange = {
	summary: SessionAttentionSummary;
};

export const SESSION_ATTENTION_FILE_VERSION = 1;
