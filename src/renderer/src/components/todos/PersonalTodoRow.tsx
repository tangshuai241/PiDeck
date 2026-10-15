/** 对齐的待办行与可展开子待办；所有业务操作转发给原 controller。 */
import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CalendarDays, Check, ChevronRight, Circle, CloudUpload, Ellipsis, Link2, ListTree, Loader2, RotateCcw, Signal, TriangleAlert } from "lucide-react";
import type { PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { EASE_OUT, SPRING_PRESS } from "../../lib/ease";
import { personalTodoCalendarDate } from "../../utils/personalTodoPresentation";
import { personalTodoErrorInfoKey, personalTodoStatusKey, personalTodoSyncBadge } from "../../utils/personalTodoState";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

export const TODO_ROW_GRID = "grid grid-cols-[36px_minmax(200px,1fr)_minmax(110px,0.42fr)_100px_90px_125px_32px] items-center gap-3 px-2";

export function PersonalTodoRow({ todo, view, today, onOpen, onToggle }: { todo: PersonalTodoController; view: PersonalTodoView; today: string; onOpen: (id: string) => void; onToggle: (view: PersonalTodoView) => Promise<void> }) {
	const [expanded, setExpanded] = useState(false);
	const reduce = useReducedMotion();
	const item = view.item;
	const done = item.status === "done";
	const initiallyDone = useRef(done);
	const pending = todo.pendingIds.includes(item.id);
	const badge = personalTodoSyncBadge(view.sync.phase);
	const errorKey = personalTodoErrorInfoKey(view.sync.lastError);
	const notice = todo.notice?.itemId === item.id ? todo.notice.key : errorKey;
	const retryable = ["conflict", "unknown", "error"].includes(view.sync.phase);
	const day = personalTodoCalendarDate(item.deadline);
	const overdue = item.status === "open" && day !== null && day < today;
	return (
		<Collapsible open={expanded} onOpenChange={setExpanded} className="shrink-0 border-b border-border/50 duration-300 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1" data-todo-id={item.id}>
			<div className={cn(TODO_ROW_GRID, "group min-h-12 transition-colors duration-150 hover:bg-muted/35 motion-reduce:transition-none", done && "bg-success-soft/15")}>
				<motion.div whileTap={reduce ? undefined : { scale: 0.86 }} transition={SPRING_PRESS} className="flex justify-center">
					<Button variant="ghost" size="icon" className="size-8 rounded-full" disabled={pending} aria-label={t(done ? "personalTodo.reopenItem" : "personalTodo.completeItem", { title: item.title })} onClick={() => void onToggle(view)}>
						<span className={cn("flex size-[18px] items-center justify-center rounded-full border-[1.5px] transition-colors", done ? "border-success bg-success text-background" : "border-border-strong group-hover:border-muted-foreground")}>
							{pending ? (
								<Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
							) : done ? (
								<motion.span initial={reduce ? false : { scale: 0.5 }} animate={{ scale: 1 }} transition={SPRING_PRESS}>
									<Check className="size-3" strokeWidth={3} />
								</motion.span>
							) : null}
						</span>
					</Button>
				</motion.div>
				<div className="flex min-w-0 items-center gap-2">
					{item.subtodos.length > 0 && (
						<Button variant="ghost" size="icon" className="-ml-1 size-5 shrink-0 text-muted-foreground" aria-label={t("personalTodo.expandSubtodos", { title: item.title })} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
							<ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
						</Button>
					)}
					<button
						type="button"
						className={cn(
							"min-w-0 truncate rounded-sm text-left text-body leading-6 text-foreground outline-none hover:underline hover:decoration-border-strong hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring",
							item.status !== "open" && "text-muted-foreground",
							item.status === "cancelled" && "line-through",
						)}
						onClick={() => onOpen(item.id)}
						title={item.title}
					>
						<span className="relative inline-block max-w-full truncate align-middle">
							{item.title}
							{done && <motion.span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px origin-left bg-current" initial={reduce || initiallyDone.current ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: reduce ? 0 : 0.28, ease: EASE_OUT }} />}
						</span>
					</button>
					{item.subtodoProgress.total > 0 && (
						<span className="flex shrink-0 items-center gap-1 text-micro text-muted-foreground">
							<ListTree className="size-3" />
							{item.subtodoProgress.done}/{item.subtodoProgress.total}
						</span>
					)}
					{view.linkedTasks.length > 0 && <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label={t("personalTodo.linkedTaskCount", { count: view.linkedTasks.length })} />}
					{view.sync.phase !== "synced" && (
						<span title={t(badge.key)} aria-label={t(badge.key)} className={cn("shrink-0", retryable ? "text-warning" : "text-muted-foreground")}>
							{retryable ? <TriangleAlert className="size-3.5" /> : <CloudUpload className="size-3.5" />}
						</span>
					)}
				</div>
				<span className="flex min-w-0 items-center gap-2 text-caption text-foreground">
					{item.category && <span className="size-2 shrink-0 rounded-[3px] bg-primary/75" />}
					<span className="truncate">{item.category ?? t("personalTodo.valueUnset")}</span>
				</span>
				<span className={cn("flex items-center gap-1.5 text-caption", done ? "text-success" : "text-muted-foreground")}>
					<Circle className="size-3.5" />
					{t(personalTodoStatusKey(item.status))}
				</span>
				<span className={cn("flex items-center gap-1.5 text-caption", item.urgency === 3 ? "text-danger" : "text-muted-foreground")}>
					<Signal className="size-3.5" />
					{item.urgency ?? t("personalTodo.valueUnset")}
				</span>
				<span className={cn("flex min-w-0 items-center gap-1.5 text-caption tabular-nums", overdue ? "text-danger" : "text-muted-foreground")} title={item.deadline ?? undefined}>
					{item.deadline && <CalendarDays className="size-3.5 shrink-0" />}
					<span className="truncate">{item.deadline ?? t("personalTodo.valueUnset")}</span>
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={t("personalTodo.moreActions", { title: item.title })}>
							<Ellipsis className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => onOpen(item.id)}>{t("personalTodo.detailTitle")}</DropdownMenuItem>
						<DropdownMenuItem disabled={pending} onSelect={() => void todo.toggleStatus(view)}>
							{t(done ? "personalTodo.toggleReopen" : "personalTodo.toggleDone")}
						</DropdownMenuItem>
						{retryable && (
							<DropdownMenuItem onSelect={() => void todo.retryItem(item.id)}>
								<RotateCcw className="size-3.5" />
								{t("personalTodo.retry")}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{notice && (
				<p className="pb-2 pl-14 text-caption text-warning" role="status">
					{t(notice)}
				</p>
			)}
			<CollapsibleContent className="shrink-0 bg-muted/20">
				{item.subtodos.map((subtodo) => (
					<div key={subtodo.id} className="flex min-h-10 items-center gap-2 border-t border-border/40 pr-5 pl-14">
						<Button
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
							disabled={pending}
							aria-label={t(subtodo.status === "done" ? "personalTodo.reopenItem" : "personalTodo.completeItem", { title: subtodo.text })}
							onClick={() => void todo.toggleSubtodo(view, subtodo.id, subtodo.status === "done" ? "open" : "done")}
						>
							{subtodo.status === "done" ? <Check className="size-3.5 text-success" /> : <Circle className="size-3.5 text-muted-foreground" />}
						</Button>
						<button type="button" className={cn("min-w-0 truncate text-caption text-foreground", subtodo.status !== "open" && "text-muted-foreground line-through")} onClick={() => onOpen(item.id)}>
							{subtodo.text}
						</button>
					</div>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}
