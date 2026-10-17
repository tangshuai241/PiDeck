/**
 * 结果已读确认：只有用户实际看到对应结果时才提交。
 *
 * 条件（任务书 §5.3）：
 * - 应用在前台（visible + 有焦点）；
 * - 会话可见：本栏是当前会话，且没有被个人工作台等功能页覆盖；
 * - 结果进入可见区域：时间线处于跟随底部状态（最新结果在视口内）；
 * - 选中会话、后台加载、恢复缓存和仅打开应用都不算已读。
 *
 * 基线由调用方在摘要首次加载完成后记录（captureCompletionBaseline）；
 * 点击未读入口或从上方滚回底部视为用户确实要看结果。已读绑定具体结果身份。
 */
import { useEffect, useRef } from "react";
import { useMarkSessionAttentionRead } from "../atoms/session-attention-atoms";
import { shouldAcknowledgeCompletion } from "../utils/sessionCompletionRead";

function appInForeground(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

export function useSessionCompletionRead(input: { sessionId: string; completionId?: string; baselineCompletionId?: string; ready: boolean; following: boolean; paneVisible: boolean; covered: boolean; focusRequested: boolean }): void {
	const markRead = useMarkSessionAttentionRead();
	const { sessionId, completionId, baselineCompletionId, ready, following, paneVisible, covered, focusRequested } = input;
	const previousFollowingRef = useRef(following);
	useEffect(() => {
		if (!completionId) return;
		const target = completionId;
		const becameFollowing = !previousFollowingRef.current && following;
		previousFollowingRef.current = following;
		const check = (foreground: boolean) => shouldAcknowledgeCompletion({ completionId: target, baselineCompletionId, ready, foreground, paneVisible, covered, following, focusRequested, becameFollowing });
		if (!check(true)) return;
		let acknowledged = false;
		const attempt = () => {
			if (acknowledged || !check(appInForeground())) return;
			acknowledged = true;
			markRead(sessionId, target);
		};
		attempt();
		// 用户切回应用/关闭遮挡页后，结果已经在视口内：补一次确认。
		window.addEventListener("focus", attempt);
		document.addEventListener("visibilitychange", attempt);
		return () => {
			window.removeEventListener("focus", attempt);
			document.removeEventListener("visibilitychange", attempt);
		};
	}, [sessionId, completionId, baselineCompletionId, ready, following, paneVisible, covered, focusRequested, markRead]);
}
