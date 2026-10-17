/**
 * 结果已读确认：只有用户实际看到对应结果时才提交。
 *
 * 条件（任务书 §5.3）：
 * - 应用在前台（visible + 有焦点）；
 * - 会话可见：本栏是当前会话，且没有被个人工作台等功能页覆盖；
 * - 结果进入可见区域：时间线处于跟随底部状态（最新结果在视口内）；
 * - 选中会话、后台加载、恢复缓存和仅打开应用都不算已读。
 *
 * 因此，启动/恢复时已经存在的未读结果要求额外的「用户确实要看」信号：
 * 点击活动区未读入口（focusRequested），或用户从上方滚回底部（following 由 false 变 true）。
 * 挂载后才产生的新结果在可见状态下直接确认。已读绑定具体结果身份。
 */
import { useEffect, useRef } from "react";
import { useMarkSessionAttentionRead } from "../atoms/session-attention-atoms";
import { shouldAcknowledgeCompletion } from "../utils/sessionCompletionRead";

function appInForeground(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

export function useSessionCompletionRead(input: { sessionId: string; completionId?: string; following: boolean; paneVisible: boolean; covered: boolean; focusRequested: boolean }): void {
	const markRead = useMarkSessionAttentionRead();
	const { sessionId, completionId, following, paneVisible, covered, focusRequested } = input;
	// 首帧已存在的未读结果视为「恢复/启动时带来的」，不因打开应用就确认已读。
	const initialCompletionIdRef = useRef(completionId);
	const previousFollowingRef = useRef(following);
	useEffect(() => {
		const becameFollowing = !previousFollowingRef.current && following;
		previousFollowingRef.current = following;
		if (!completionId || !following || !paneVisible || covered) return;
		const preexisting = completionId === initialCompletionIdRef.current;
		if (!shouldAcknowledgeCompletion({ completionId, foreground: true, paneVisible, covered, following, preexisting, focusRequested, becameFollowing })) return;
		let acknowledged = false;
		const attempt = () => {
			if (acknowledged || !shouldAcknowledgeCompletion({ completionId, foreground: appInForeground(), paneVisible, covered, following, preexisting, focusRequested, becameFollowing })) return;
			acknowledged = true;
			markRead(sessionId, completionId);
		};
		attempt();
		// 用户切回应用/关闭遮挡页后，结果已经在视口内：补一次确认。
		window.addEventListener("focus", attempt);
		document.addEventListener("visibilitychange", attempt);
		return () => {
			window.removeEventListener("focus", attempt);
			document.removeEventListener("visibilitychange", attempt);
		};
	}, [sessionId, completionId, following, paneVisible, covered, focusRequested, markRead]);
}
