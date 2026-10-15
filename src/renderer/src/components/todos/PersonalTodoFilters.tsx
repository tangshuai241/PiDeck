/** 水平工具条：常用搜索直接可见，详细条件放进筛选浮层，查询仍交给原数据链路。 */
import { ArrowDownUp, Search, SlidersHorizontal, X } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { PERSONAL_TODO_STATUSES } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import type { PersonalTodoWorkspace } from "../../hooks/usePersonalTodoWorkspace";
import { hasPersonalTodoFilters } from "../../utils/personalTodoQuery";
import { personalTodoStatusKey } from "../../utils/personalTodoState";

const ORDERS = ["source", "deadline", "urgency"] as const;
const ORDER_KEYS: Record<(typeof ORDERS)[number], TranslationKey> = { source: "personalTodo.orderSource", deadline: "personalTodo.orderDeadline", urgency: "personalTodo.orderUrgency" };

export function PersonalTodoFilters({ todo, workspace }: { todo: PersonalTodoController; workspace: PersonalTodoWorkspace }) {
	const query = todo.query;
	const statusValue = query.status?.length === 1 ? query.status[0] : "any";
	const hasFilters = hasPersonalTodoFilters(query);
	const filterCount = Number(Boolean(query.category)) + Number(Boolean(query.status?.length)) + Number(Boolean(query.deadlineFrom || query.deadlineTo));
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 pb-4" role="search" aria-label={t("personalTodo.filterSearch")}>
			<div className="relative w-full max-w-[280px] min-w-[160px]">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input className="h-9 rounded-md border-border/70 bg-background pl-9 text-body shadow-none" value={query.search ?? ""} aria-label={t("personalTodo.filterSearch")} placeholder={t("personalTodo.filterSearch")} onChange={(event) => todo.setQuery({ search: event.target.value })} />
			</div>
			<Popover>
				<PopoverTrigger asChild>
					<Button variant="ghost" size="sm" className="h-9 gap-2 text-muted-foreground">
						<SlidersHorizontal className="size-4" />
						{t("personalTodo.filters")}
						{filterCount > 0 && <span className="rounded bg-primary/10 px-1.5 text-primary">{filterCount}</span>}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="flex w-80 flex-col gap-4">
					<span className="text-body font-medium">{t("personalTodo.filters")}</span>
					<label className="flex flex-col gap-1.5 text-caption text-muted-foreground">
						{t("personalTodo.filterStatus")}
						<Select value={statusValue} onValueChange={(value) => todo.setQuery({ status: value === "any" ? null : PERSONAL_TODO_STATUSES.filter((status) => status === value) })}>
							<SelectTrigger className="h-9 w-full" aria-label={t("personalTodo.filterStatus")}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="any">{t("personalTodo.filterStatusAll")}</SelectItem>
								{PERSONAL_TODO_STATUSES.map((status) => (
									<SelectItem key={status} value={status}>
										{t(personalTodoStatusKey(status))}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
					<label className="flex flex-col gap-1.5 text-caption text-muted-foreground">
						{t("personalTodo.filterCategory")}
						<Input value={query.category ?? ""} onChange={(event) => todo.setQuery({ category: event.target.value })} />
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1.5 text-caption text-muted-foreground">
							{t("personalTodo.filterDeadlineFrom")}
							<Input value={query.deadlineFrom ?? ""} placeholder={t("personalTodo.dateFormat")} onChange={(event) => todo.setQuery({ deadlineFrom: event.target.value })} />
						</label>
						<label className="flex flex-col gap-1.5 text-caption text-muted-foreground">
							{t("personalTodo.filterDeadlineTo")}
							<Input value={query.deadlineTo ?? ""} placeholder={t("personalTodo.dateFormat")} onChange={(event) => todo.setQuery({ deadlineTo: event.target.value })} />
						</label>
					</div>
					<p className="text-caption leading-5 text-muted-foreground">{t("personalTodo.filterDeadlineHint")}</p>
				</PopoverContent>
			</Popover>
			<Select
				value={workspace.order}
				onValueChange={(value) => {
					const order = ORDERS.find((entry) => entry === value);
					if (order) workspace.setOrder(order);
				}}
			>
				<SelectTrigger className="h-9 w-auto gap-2 border-0 bg-transparent text-muted-foreground shadow-none" aria-label={t("personalTodo.sort")}>
					<ArrowDownUp className="size-4" />
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{ORDERS.map((order) => (
						<SelectItem key={order} value={order}>
							{t(ORDER_KEYS[order])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{hasFilters && (
				<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={todo.clearFilters}>
					<X className="size-3.5" />
					{t("personalTodo.clearFilters")}
				</Button>
			)}
		</div>
	);
}
