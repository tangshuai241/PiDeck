/**
 * 手机已读确认的基线规则（纯函数，可单测）。
 *
 * 基线在选中会话时按会话列表摘要记录，而不是等首个快照到达再记录：
 * 否则用户进入时还没有未读、随后执行完成的结果会被误记成“进入前已有”，一直不确认。
 * 进入时已有未读结果仍不自动确认，需要点按未读提示或从上方滚回底部。
 */
export type ChatCompletionBaseline = { sessionId?: string; completionId?: string };

export function captureChatCompletionBaseline(previous: ChatCompletionBaseline, input: { sessionId?: string; completionId?: string }): ChatCompletionBaseline {
	if (previous.sessionId === input.sessionId) return previous;
	return { sessionId: input.sessionId, completionId: input.completionId };
}

export function isPreexistingChatCompletion(baseline: ChatCompletionBaseline, sessionId: string | undefined, completionId: string | undefined): boolean {
	return Boolean(completionId && baseline.sessionId === sessionId && baseline.completionId === completionId);
}
