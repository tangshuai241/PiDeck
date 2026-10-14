/**
 * 待办列表：一屏一行事项，行内呈现状态、分类、日期、子待办进度与同步徽标。
 *
 * 同步语义（契约同规则）：只有 `synced` 才算已云端确认；待同步/保存中/冲突/未知/失败
 * 都显示对应徽标，界面绝不提前显示「已保存」。
 * 子项完成不会连带完成父项；父项完成被本地规则挡住时（有未完成子项）就地说明原因。
 */
import { CheckCircle2, Circle, Link2, ListTree, RotateCcw } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import type { PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { hasPersonalTodoFilters } from "../../utils/personalTodoQuery";
import { personalTodoErrorInfoKey, personalTodoStatusKey, personalTodoSyncBadge, resolvePersonalTodoWindowState } from "../../utils/personalTodoState";
import { PersonalTodoEmptyState, PersonalTodoLoadingState } from "./PersonalTodoStates";

export function PersonalTodoList({ todo }: { todo: PersonalTodoController }) {
	const windowState = resolvePersonalTodoWindowState({ itemCount: todo.items.length, hasMore: todo.hasMore, loading: todo.loading });
	if (windowState === "loading") return <PersonalTodoLoadingState />;
	if (windowState === "empty") return <PersonalTodoEmptyState hasFilters={hasPersonalTodoFilters(todo.query)} onClearFilters={todo.clearFilters} />;
	if (windowState === "empty-window") {
		// 已加载窗口内无匹配但还有下一页：保留继续加载入口，并说清已看范围（未加载 ≠ 不存在）
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-2">
				<PersonalTodoEmptyState hasFilters={hasPersonalTodoFilters(todo.query)} onClearFilters={todo.clearFilters} loadedPages={todo.loadedPages} pageLimit={todo.query.limit ?? null} />
				<Button variant="outline" size="sm" className="shrink-0" disabled={todo.loadingMore} onClick={todo.loadMore}>
					{todo.loadingMore ? t("personalTodo.loading") : t("personalTodo.loadMore")}
				</Button>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
				{todo.items.map((view) => (
					<PersonalTodoRow key={view.item.id} todo={todo} view={view} />
				))}
			</div>
			{todo.hasMore && (
				<Button variant="outline" size="sm" className="shrink-0" disabled={todo.loadingMore} onClick={todo.loadMore}>
					{todo.loadingMore ? t("personalTodo.loading") : t("personalTodo.loadMore")}
				</Button>
			)}
		</div>
	);
}

export function PersonalTodoRow({ todo, view }: { todo: PersonalTodoController; view: PersonalTodoView }) {
	const item = view.item;
	const badge = personalTodoSyncBadge(view.sync.phase);
	const errorKey = personalTodoErrorInfoKey(view.sync.lastError);
	const progress = item.subtodoProgress;
	const retryable = view.sync.phase === "conflict" || view.sync.phase === "error" || view.sync.phase === "unknown";
	const blockedNotice = todo.notice?.itemId === item.id ? todo.notice.key : null;
	const pending = todo.pendingIds.includes(item.id);

	return (
		<div className={cn("flex shrink-0 flex-col gap-1 rounded-lg border border-border/50 px-2 py-1.5 transition-colors", todo.selected?.item.id === item.id ? "bg-accent" : "hover:bg-muted/50")}>
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={pending} title={t(item.status === "done" ? "personalTodo.toggleReopen" : "personalTodo.toggleDone")} onClick={() => void todo.toggleStatus(view)}>
					{item.status === "done" ? <CheckCircle2 className="size-4 text-success" aria-hidden="true" /> : <Circle className="size-4 text-muted-foreground" aria-hidden="true" />}
					<span className="sr-only">{t(personalTodoStatusKey(item.status))}</span>
				</Button>
				<button type="button" className="min-w-0 flex-1 text-left" onClick={() => todo.select(item.id)}>
					<span className={cn("block truncate text-body text-foreground", item.status === "cancelled" && "text-muted-foreground line-through")}>{item.title}</span>
				</button>
				<span className={cn("shrink-0 rounded-sm border px-1 text-micro", badge.tone === "danger" ? "border-danger/50 text-danger" : badge.tone === "warning" ? "border-warning/50 text-warning" : "border-border/60 text-muted-foreground")}>{t(badge.key)}</span>
				{retryable && (
					<Button variant="ghost" size="icon" className="size-6 shrink-0" title={t("personalTodo.retry")} onClick={() => void todo.retryItem(item.id)}>
						<RotateCcw className="size-3.5" aria-hidden="true" />
					</Button>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2 pl-8 text-micro text-muted-foreground">
				{item.category && <span className="rounded-sm border border-border/60 px-1">{item.category}</span>}
				{item.deadline && <span>{item.deadline}</span>}
				{progress.total > 0 && (
					<span className="flex items-center gap-1">
						<ListTree className="size-3" aria-hidden="true" />
						{t("personalTodo.subtodoProgress", { done: progress.done, total: progress.total })}
					</span>
				)}
				{view.linkedTasks.length > 0 && (
					<span className="flex items-center gap-1" title={t("personalTodo.linkedTasksReadOnly")}>
						<Link2 className="size-3" aria-hidden="true" />
						{t("personalTodo.linkedTaskCount", { count: view.linkedTasks.length })}
					</span>
				)}
			</div>
			{(blockedNotice || errorKey) && <p className={cn("pl-8 text-micro", errorKey ? "text-danger" : "text-warning")}>{t(blockedNotice ?? errorKey ?? "personalTodo.errorInternalError")}</p>}
		</div>
	);
}
