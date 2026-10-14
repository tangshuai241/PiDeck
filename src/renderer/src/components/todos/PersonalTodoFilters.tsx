/**
 * 待办筛选条：分类、状态、日期区间与搜索。
 *
 * 规则：
 * - 所有条件都交给主进程过滤（`list(query)`），界面不另写一套客户端过滤；
 * - 日期是云端原字符串（例如 2026-10-14），只做词法序比较，不解析、不换算时区；
 * - 改任意条件都回到第一页（由 hook 的 setQuery 统一处理）。
 */
import { Search, SlidersHorizontal, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import type { PersonalTodoStatus } from "../../../../shared/types/personalTodo";
import { PERSONAL_TODO_STATUSES } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { hasPersonalTodoFilters } from "../../utils/personalTodoQuery";
import { personalTodoStatusKey } from "../../utils/personalTodoState";

const STATUS_ANY = "any";

export function PersonalTodoFilters({ todo }: { todo: PersonalTodoController }) {
	const query = todo.query;
	const statusValue = query.status && query.status.length === 1 ? query.status[0] : STATUS_ANY;
	const hasFilters = hasPersonalTodoFilters(query);

	return (
		<div className="flex shrink-0 flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input className="h-7 pl-7 text-caption" value={query.search ?? ""} placeholder={t("personalTodo.filterSearch")} onChange={(event) => todo.setQuery({ search: event.target.value })} />
				</div>
				{hasFilters && (
					<Button variant="ghost" size="sm" className="shrink-0" onClick={todo.clearFilters} title={t("personalTodo.clearFilters")}>
						<X className="size-3.5" aria-hidden="true" />
						{t("personalTodo.clearFilters")}
					</Button>
				)}
			</div>

			<div className="flex items-center gap-2">
				<SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<Select value={statusValue} onValueChange={(value) => todo.setQuery({ status: value === STATUS_ANY ? null : [value as PersonalTodoStatus] })}>
					<SelectTrigger className="h-7 min-w-0 flex-1 text-caption" aria-label={t("personalTodo.filterStatus")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={STATUS_ANY}>{t("personalTodo.filterStatusAll")}</SelectItem>
						{PERSONAL_TODO_STATUSES.map((status) => (
							<SelectItem key={status} value={status}>
								{t(personalTodoStatusKey(status))}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input className="h-7 min-w-0 flex-1 text-caption" value={query.category ?? ""} placeholder={t("personalTodo.filterCategory")} aria-label={t("personalTodo.filterCategory")} onChange={(event) => todo.setQuery({ category: event.target.value })} />
			</div>

			<div className="flex items-center gap-2">
				<Input className="h-7 min-w-0 flex-1 text-caption" value={query.deadlineFrom ?? ""} placeholder={t("personalTodo.filterDeadlineFrom")} aria-label={t("personalTodo.filterDeadlineFrom")} onChange={(event) => todo.setQuery({ deadlineFrom: event.target.value })} />
				<span className="shrink-0 text-micro text-muted-foreground">–</span>
				<Input className="h-7 min-w-0 flex-1 text-caption" value={query.deadlineTo ?? ""} placeholder={t("personalTodo.filterDeadlineTo")} aria-label={t("personalTodo.filterDeadlineTo")} onChange={(event) => todo.setQuery({ deadlineTo: event.target.value })} />
			</div>
			<p className="text-micro text-muted-foreground">{t("personalTodo.filterDeadlineHint")}</p>
		</div>
	);
}
