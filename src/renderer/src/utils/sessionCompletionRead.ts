/**
 * 结果已读确认的判定规则（纯函数，可单测）。
 *
 * 只有「用户实际看到对应结果」才为 true：前台、会话可见且未被功能页覆盖、
 * 结果在可见区域（跟随底部）；启动/恢复时已存在的未读结果还要求用户确实要看它
 * （点击未读入口，或从上方滚回底部），避免仅打开应用就清掉未读。
 */
export type CompletionReadInput = {
	completionId?: string;
	/** 应用在前台（visible + 有焦点） */
	foreground: boolean;
	/** 本栏是当前会话（分屏时本栏有焦点） */
	paneVisible: boolean;
	/** 被个人工作台等功能页覆盖 */
	covered: boolean;
	/** 时间线跟随底部（最新结果在视口内） */
	following: boolean;
	/** 首帧就存在的未读结果（启动/恢复带来） */
	preexisting: boolean;
	/** 用户点击了活动区未读入口 */
	focusRequested: boolean;
	/** 用户从上方滚回底部（following 由 false 变 true） */
	becameFollowing: boolean;
};

export function shouldAcknowledgeCompletion(input: CompletionReadInput): boolean {
	if (!input.completionId || !input.foreground || !input.paneVisible || input.covered || !input.following) return false;
	if (input.preexisting && !input.focusRequested && !input.becameFollowing) return false;
	return true;
}
