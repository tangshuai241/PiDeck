import { useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { CircleAlert, CircleCheck, CircleSlash, LoaderCircle, Square } from "lucide-react";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { useSessionAttention } from "../../atoms/session-attention-atoms";
import { hasPendingAskForSession } from "../../utils/askUi";
import { presentSessionStatus } from "../../utils/sessionStatusPresentation";
import { t } from "../../i18n";

/**
 * 会话状态指示器：会话标签、项目列表、活动列表、标题栏共用。
 *
 * 运行=旋转图标；待回答=静态标记（不再是计算中）；未读结果=结果类型图标 + 未读点；
 * 主动停止=静态已停止；已读空闲=普通空闲点。规则见 `sessionStatusPresentation`。
 */
export function SessionActivityIndicator(props: { status?: string | null; sessionId?: string; waiting?: boolean; busy?: boolean }) {
	const pendingAtom = useMemo(() => atom((get) => hasPendingAskForSession(props.sessionId, get(sessionRuntimeUiByIdAtom))), [props.sessionId]);
	const pendingAsk = useAtomValue(pendingAtom);
	const attention = useSessionAttention(props.sessionId);
	const presentation = presentSessionStatus({
		status: props.status,
		waiting: props.waiting || pendingAsk,
		busy: props.busy,
		attention,
	});
	const title = presentation.summary ? `${t(presentation.labelKey)} · ${presentation.summary}` : t(presentation.labelKey);
	if (presentation.kind === "running")
		return (
			<span className="inline-flex shrink-0" aria-label={title} title={title}>
				<LoaderCircle className="session-activity-spinner size-3 animate-pideck-spin text-warning" aria-hidden="true" />
			</span>
		);
	if (presentation.kind === "waiting") return <span className="session-activity-waiting size-1.5 shrink-0 rounded-full bg-warning" aria-label={title} title={title} />;
	if (presentation.kind === "unread") {
		const Icon = presentation.outcome === "succeeded" ? CircleCheck : presentation.outcome === "failed" ? CircleAlert : CircleSlash;
		const tone = presentation.outcome === "succeeded" ? "text-success" : "text-danger";
		return (
			<span className="relative inline-flex shrink-0" aria-label={title} title={title}>
				<Icon className={`session-activity-unread size-3 ${tone}`} aria-hidden="true" />
				<span className="absolute -right-0.5 -top-0.5 size-1 rounded-full bg-primary" aria-hidden="true" />
			</span>
		);
	}
	if (presentation.kind === "stopped")
		return (
			<span className="inline-flex shrink-0" aria-label={title} title={title}>
				<Square className="session-activity-stopped size-2.5 fill-current text-muted-foreground/60" aria-hidden="true" />
			</span>
		);
	if (presentation.kind === "error") return <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-label={title} title={title} />;
	if (presentation.kind === "idle") return <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label={title} title={title} />;
	return null;
}
