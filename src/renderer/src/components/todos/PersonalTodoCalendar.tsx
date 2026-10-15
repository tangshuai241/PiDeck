/** 仅把明确日期映射到月历；无日期及无法定位的原文在月历下方继续可见。 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { getI18nLocale, t } from "../../i18n";
import { cn } from "../../lib/utils";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import type { PersonalTodoWorkspace } from "../../hooks/usePersonalTodoWorkspace";
import { personalTodoCalendarDate, personalTodoMonthDays } from "../../utils/personalTodoPresentation";
import { Button } from "../ui-shadcn/button";

export function PersonalTodoCalendar({ todo, workspace }: { todo: PersonalTodoController; workspace: PersonalTodoWorkspace }) {
	const [month, setMonth] = useState(() => new Date());
	const days = useMemo(() => personalTodoMonthDays(month), [month]);
	const byDay = useMemo(() => {
		const map = new Map<string, typeof todo.items>();
		for (const view of todo.items) {
			const day = personalTodoCalendarDate(view.item.deadline);
			if (day) map.set(day, [...(map.get(day) ?? []), view]);
		}
		return map;
	}, [todo.items]);
	const undated = todo.items.filter((view) => !personalTodoCalendarDate(view.item.deadline));
	const locale = getI18nLocale() === "pseudo" ? "en-US" : getI18nLocale();
	const shiftMonth = (offset: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
	return (
		<div className="min-h-0 flex-1 overflow-auto pb-6" data-todo-calendar>
			<div className="flex h-16 items-center gap-2">
				<h2 className="mr-auto text-lg font-semibold">{month.toLocaleDateString(locale, { year: "numeric", month: "long" })}</h2>
				<Button variant="ghost" size="sm" onClick={() => setMonth(new Date())}>
					{t("personalTodo.groupToday")}
				</Button>
				<Button variant="ghost" size="icon" className="size-8" aria-label={t("personalTodo.previousMonth")} onClick={() => shiftMonth(-1)}>
					<ChevronLeft className="size-4" />
				</Button>
				<Button variant="ghost" size="icon" className="size-8" aria-label={t("personalTodo.nextMonth")} onClick={() => shiftMonth(1)}>
					<ChevronRight className="size-4" />
				</Button>
			</div>
			<div className="min-w-[700px] overflow-hidden rounded-lg border border-border/60">
				<div className="grid grid-cols-7 border-b border-border/60 bg-muted/20">
					{days.slice(0, 7).map((_, index) => (
						<span key={index} className="py-2 text-center text-caption text-muted-foreground">
							{new Date(2026, 9, 11 + index).toLocaleDateString(locale, { weekday: "short" })}
						</span>
					))}
				</div>
				<div className="grid grid-cols-7">
					{days.map(({ day, inMonth }) => (
						<section key={day} aria-label={day} className={cn("group min-h-28 border-r border-b border-border/50 p-2 [&:nth-child(7n)]:border-r-0", !inMonth && "bg-muted/20 text-muted-foreground")}>
							<div className="mb-2 flex items-center justify-between">
								<span className={cn("flex size-6 items-center justify-center rounded-full text-caption tabular-nums", workspace.today === day && "bg-primary text-primary-foreground")}>{Number(day.slice(-2))}</span>
								<Button variant="ghost" size="icon" className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("personalTodo.addOnDate", { date: day })} onClick={() => workspace.openCreate(day)}>
									<Plus className="size-3.5" />
								</Button>
							</div>
							<div className="flex flex-col gap-1">
								{(byDay.get(day) ?? []).map((view) => (
									<button
										key={view.item.id}
										type="button"
										title={view.item.title}
										className={cn("w-full truncate rounded border-l-2 border-primary/70 bg-primary/5 px-2 py-1 text-left text-caption text-foreground transition-colors hover:bg-primary/10", view.item.status !== "open" && "border-muted-foreground text-muted-foreground line-through")}
										onClick={() => workspace.openItem(view.item.id)}
									>
										{view.item.title}
									</button>
								))}
							</div>
						</section>
					))}
				</div>
			</div>
			{undated.length > 0 && (
				<section className="mt-5 flex flex-col gap-2">
					<h3 className="text-body font-medium">
						{t("personalTodo.groupUndated")} <span className="ml-1 text-muted-foreground">{undated.length}</span>
					</h3>
					<p className="text-caption text-muted-foreground">{t("personalTodo.undatedHint")}</p>
					<div className="flex flex-wrap gap-2">
						{undated.map((view) => (
							<Button key={view.item.id} variant="outline" size="sm" className="max-w-full" onClick={() => workspace.openItem(view.item.id)}>
								<span className="truncate">{view.item.title}</span>
							</Button>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
