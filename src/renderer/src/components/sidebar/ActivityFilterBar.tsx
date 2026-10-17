/**
 * 活动区筛选条：待回答 / 未读结果 / 运行中 / 最近。
 *
 * 数量按会话计数（一个会话多道题仍算一个待回答会话）；「全部」不带数量。
 * 纯展示组件：筛选状态与行数据由 ActiveSessionsTree 持有。
 */
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";
import type { ActivityFilter } from "./activitySessionsModel";

const FILTERS: Array<{ id: ActivityFilter; labelKey: "sidebar.activityAll" | "sidebar.activityPending" | "sidebar.activityUnread" | "sidebar.activityRunning" | "sidebar.activityRecent" }> = [
	{ id: "all", labelKey: "sidebar.activityAll" },
	{ id: "pending", labelKey: "sidebar.activityPending" },
	{ id: "unread", labelKey: "sidebar.activityUnread" },
	{ id: "running", labelKey: "sidebar.activityRunning" },
	{ id: "recent", labelKey: "sidebar.activityRecent" },
];

export function ActivityFilterBar(props: { value: ActivityFilter; counts: { pending: number; unread: number; running: number }; onChange: (filter: ActivityFilter) => void }) {
	return (
		<div className="activity-filters flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1 pt-1.5" role="tablist" aria-label={t("sidebar.activityAll")}>
			{FILTERS.map((filter) => {
				const count = filter.id === "pending" ? props.counts.pending : filter.id === "unread" ? props.counts.unread : filter.id === "running" ? props.counts.running : 0;
				const active = props.value === filter.id;
				return (
					<Button key={filter.id} type="button" role="tab" aria-selected={active} variant={active ? "secondary" : "ghost"} size="xs" className="gap-1" onClick={() => props.onChange(filter.id)}>
						<span>{t(filter.labelKey)}</span>
						{count > 0 ? <span className="tabular-nums text-muted-foreground">{count}</span> : null}
					</Button>
				);
			})}
		</div>
	);
}
