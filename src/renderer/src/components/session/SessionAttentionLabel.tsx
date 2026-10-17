/**
 * 活动列表行内的状态文案：待回答显示问题摘要与题目数，未读结果显示结果类型。
 *
 * 与 `SessionActivityIndicator` 共用同一套展示规则；这里只负责文字部分，
 * 颜色/图标仍由指示器表达。
 */
import type { SessionAttentionSummary } from "../../../../shared/types/sessionAttention";
import { presentSessionStatus } from "../../utils/sessionStatusPresentation";
import { t } from "../../i18n";

export function SessionAttentionLabel(props: { sessionId?: string; attention?: SessionAttentionSummary; status?: string | null }) {
	const presentation = presentSessionStatus({ status: props.status, attention: props.attention });
	if (presentation.kind === "waiting") {
		const count = props.attention?.pendingQuestionCount ?? 0;
		return (
			<span className="flex min-w-0 items-center gap-0.5 text-[11px] leading-none" title={presentation.summary}>
				<span className="text-warning">{t("app.statusWaiting")}</span>
				{count > 1 ? <span className="text-muted-foreground"> · {t("sidebar.activityQuestions", { count: String(count) })}</span> : null}
				{presentation.summary ? <span className="truncate text-muted-foreground"> · {presentation.summary}</span> : null}
			</span>
		);
	}
	if (presentation.kind === "unread" || presentation.kind === "stopped") {
		return <span className={`shrink-0 text-[11px] leading-none ${presentation.kind === "unread" ? "text-primary" : "text-muted-foreground"}`}>{t(presentation.labelKey)}</span>;
	}
	return null;
}
