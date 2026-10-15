/** 日期分组列表：列表占满工作区，只有用户打开事项后才呈现详情。 */
import { CalendarDays, CheckCircle2, ChevronDown, Circle, ClockAlert, Plus, Sun, XCircle } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import type { PersonalTodoWorkspace } from "../../hooks/usePersonalTodoWorkspace";
import type { PersonalTodoGroupId } from "../../utils/personalTodoPresentation";
import { hasPersonalTodoFilters } from "../../utils/personalTodoQuery";
import { resolvePersonalTodoWindowState } from "../../utils/personalTodoState";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { PersonalTodoEmptyState, PersonalTodoLoadingState } from "./PersonalTodoStates";
import { PersonalTodoRow, TODO_ROW_GRID } from "./PersonalTodoRow";

export const TODO_GROUP_KEYS: Record<PersonalTodoGroupId, TranslationKey> = { overdue: "personalTodo.groupOverdue", today: "personalTodo.groupToday", upcoming: "personalTodo.groupUpcoming", undated: "personalTodo.groupUndated", completed: "personalTodo.groupCompleted", cancelled: "personalTodo.groupCancelled" };
const GROUP_ICONS = { overdue: ClockAlert, today: Sun, upcoming: CalendarDays, undated: Circle, completed: CheckCircle2, cancelled: XCircle };

export function PersonalTodoList({ todo, workspace }: { todo: PersonalTodoController; workspace: PersonalTodoWorkspace }) {
	const state = resolvePersonalTodoWindowState({ itemCount: todo.items.length, hasMore: todo.hasMore, loading: todo.loading });
	if (state === "loading") return <PersonalTodoLoadingState />;
	if (state === "empty-window") return <PersonalTodoEmptyState hasFilters={hasPersonalTodoFilters(todo.query)} onClearFilters={todo.clearFilters} loadedPages={todo.loadedPages} pageLimit={todo.query.limit ?? null} />;
	if (state === "empty" && hasPersonalTodoFilters(todo.query)) return <PersonalTodoEmptyState hasFilters onClearFilters={todo.clearFilters} />;
	return (
		<div className="min-h-0 flex-1 overflow-auto" data-todo-list>
			<div className="min-w-[760px] pb-8">
				<div className={cn(TODO_ROW_GRID, "sticky top-0 z-10 h-10 border-b border-border/70 bg-background text-caption text-muted-foreground")} aria-hidden="true">
					<span />
					<span className="pl-1">{t("personalTodo.fieldTitle")}</span>
					<span>{t("personalTodo.fieldCategory")}</span>
					<span>{t("personalTodo.filterStatus")}</span>
					<span>{t("personalTodo.fieldUrgency")}</span>
					<span>{t("personalTodo.fieldDeadline")}</span>
					<span />
				</div>
				{workspace.groups
					.filter((group) => group.items.length > 0 || (group.id !== "cancelled" && group.id !== "undated"))
					.map((group) => {
						const Icon = GROUP_ICONS[group.id];
						const canAdd = group.id === "today" || group.id === "upcoming" || group.id === "undated";
						return (
							<Collapsible key={group.id} open={workspace.openGroups[group.id]} onOpenChange={(open) => workspace.setOpenGroups((current) => ({ ...current, [group.id]: open }))} className="shrink-0" data-todo-group={group.id}>
								<div className="mt-3 flex h-12 items-center gap-1 border-b border-border/60">
									<CollapsibleTrigger asChild>
										<button type="button" className="group flex h-full items-center gap-2.5 rounded-sm px-2 text-body font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("personalTodo.toggleGroup", { group: t(TODO_GROUP_KEYS[group.id]) })}>
											<ChevronDown className="mr-1 size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90 motion-reduce:transition-none" />
											<Icon className={cn("size-4", group.id === "overdue" ? "text-danger" : group.id === "completed" ? "text-success" : "text-muted-foreground")} />
											<span>{t(TODO_GROUP_KEYS[group.id])}</span>
											<span className="ml-1 font-normal text-muted-foreground tabular-nums">{group.items.length}</span>
										</button>
									</CollapsibleTrigger>
									{canAdd && (
										<Button
											variant="ghost"
											size="icon"
											className="size-7 text-muted-foreground"
											aria-label={t("personalTodo.addToGroup", { group: t(TODO_GROUP_KEYS[group.id]) })}
											onClick={() => {
												workspace.setOpenGroups((current) => ({ ...current, [group.id]: true }));
												workspace.setQuickGroup(group.id);
											}}
										>
											<Plus className="size-3.5" />
										</Button>
									)}
									{group.id === "undated" && <span className="ml-2 text-caption text-muted-foreground">{t("personalTodo.undatedHint")}</span>}
								</div>
								<CollapsibleContent className="shrink-0">
									{group.items.map((view) => (
										<PersonalTodoRow key={view.item.id} todo={todo} view={view} today={workspace.today} onOpen={workspace.openItem} onToggle={workspace.toggleStatus} />
									))}
									{canAdd &&
										(workspace.quickGroup === group.id ? (
											<form
												className="flex min-h-11 items-center gap-2 border-b border-border/50 bg-muted/30 px-3"
												onSubmit={(event) => {
													event.preventDefault();
													void workspace.submitQuick(group.id).catch(() => undefined);
												}}
											>
												<Plus className="size-4 shrink-0 text-muted-foreground" />
												<Input
													autoFocus
													className="h-9 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
													value={workspace.quickTitles[group.id] ?? ""}
													aria-label={t("personalTodo.quickTitle")}
													placeholder={t("personalTodo.quickPlaceholder")}
													onChange={(event) => workspace.setQuickTitles((current) => ({ ...current, [group.id]: event.target.value }))}
													onKeyDown={(event) => {
														if (event.key === "Escape") {
															event.preventDefault();
															workspace.setQuickGroup(null);
														}
													}}
												/>
												<Button type="submit" size="sm" variant="ghost" disabled={workspace.quickSaving || !workspace.quickTitles[group.id]?.trim()}>
													{t("personalTodo.create")}
												</Button>
												<Button type="button" variant="ghost" size="sm" onClick={() => workspace.setQuickGroup(null)}>
													{t("personalTodo.cancel")}
												</Button>
											</form>
										) : (
											<button
												type="button"
												className="flex h-10 w-full items-center gap-2 border-b border-border/50 px-3 text-left text-body text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
												onClick={() => workspace.setQuickGroup(group.id)}
											>
												<Plus className="size-4" />
												{t("personalTodo.addItem")}
											</button>
										))}
								</CollapsibleContent>
							</Collapsible>
						);
					})}
				{todo.notice?.itemId === "create" && (
					<p className="px-3 py-2 text-caption text-danger" role="status">
						{t(todo.notice.key)}
					</p>
				)}
			</div>
		</div>
	);
}
