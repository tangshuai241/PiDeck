/**
 * 待办页：全宽列表／月历 + 按需详情抽屉，正式数据来自 `usePersonalTodo`。
 *
 * 为什么页面自己管状态呈现而不是复用 P01 的「未接入」说明：P01 的说明属于「数据源尚未接入」，
 * 而待办页已经实现——它需要的是运行期状态（服务版本不支持、账号未连接、缓存、队列、冲突）。
 * 静态 `availability: "ready"` 表示页面已实现；账号/服务/写入可用性只在打开这一页后显示
 * （不新增启动探测或后台轮询）。
 */
import { AlertTriangle, CalendarDays, CloudOff, List, Plus, RefreshCw, ServerOff, WifiOff } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { usePersonalTodo } from "../../hooks/usePersonalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { usePersonalTodoWorkspace } from "../../hooks/usePersonalTodoWorkspace";
import { personalTodoScopeKey, hasPersonalTodoFilters } from "../../utils/personalTodoQuery";
import { cn } from "../../lib/utils";
import { personalTodoErrorKey } from "../../utils/personalTodoState";
import { PersonalTodoCreateForm } from "./PersonalTodoCreateForm";
import { PersonalTodoDetail } from "./PersonalTodoDetail";
import { PersonalTodoFilters } from "./PersonalTodoFilters";
import { PersonalTodoList } from "./PersonalTodoList";
import { PersonalTodoNoticePanel } from "./PersonalTodoStates";
import { PersonalTodoPanel } from "./PersonalTodoPanel";
import { PersonalTodoCalendar } from "./PersonalTodoCalendar";

export function PersonalTodoPage(props: { projectId?: string; onOpenSession?: (projectId: string, sessionId: string) => void | Promise<void> }) {
	const todo = usePersonalTodo();
	const status = todo.status;

	// 接口未接入 / 云端版本不支持：不伪造数据，也不隐藏入口，说明清原因
	if (!todo.clientAvailable || (status !== null && !status.supported)) {
		return <PersonalTodoNoticePanel icon={<ServerOff className="size-4" aria-hidden="true" />} titleKey="personalTodo.unsupportedTitle" bodyKey="personalTodo.unsupportedBody" />;
	}
	// 账号未连接：待办沿用已连接的云端账号，这里不接受输入账号或密码
	if (status !== null && status.scope === null) {
		return <PersonalTodoNoticePanel icon={<CloudOff className="size-4" aria-hidden="true" />} titleKey="personalTodo.notConnectedTitle" bodyKey="personalTodo.notConnectedBody" />;
	}
	return <PersonalTodoWorkspaceBody key={personalTodoScopeKey(status?.scope)} todo={todo} projectId={props.projectId} />;
}

/** 以账号为挂载边界，切账号清空本页输入，关闭抽屉则保留本账号草稿。 */
function PersonalTodoWorkspaceBody({ todo, projectId }: { todo: PersonalTodoController; projectId?: string }) {
	const workspace = usePersonalTodoWorkspace(todo);
	const counts = { today: workspace.groups.find((group) => group.id === "today")?.items.length ?? 0, overdue: workspace.groups.find((group) => group.id === "overdue")?.items.length ?? 0, upcoming: workspace.groups.find((group) => group.id === "upcoming")?.items.length ?? 0 };
	const errorKey = todo.pageError ? personalTodoErrorKey(todo.pageError.code) : null;
	const scoped = todo.hasMore || hasPersonalTodoFilters(todo.query);

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-personal-todo-workspace>
			<header className="flex shrink-0 flex-wrap items-start gap-3 pb-7">
				<div className="mr-auto flex flex-col gap-1.5">
					<h1 className="text-2xl leading-8 font-semibold tracking-tight text-foreground">{t("personalTodo.pageTitle")}</h1>
					<p className="text-body text-muted-foreground">{t("personalTodo.dateSummary", counts)}</p>
				</div>
				<div className="flex items-center rounded-lg bg-muted/60 p-1" role="group" aria-label={t("personalTodo.viewMode")}>
					{(["list", "calendar"] as const).map((mode) => {
						const Icon = mode === "list" ? List : CalendarDays;
						return (
							<Button key={mode} variant="ghost" size="sm" className={cn("h-8 gap-1.5 rounded-md px-3 text-muted-foreground", workspace.mode === mode && "bg-background text-foreground shadow-sm hover:bg-background")} aria-pressed={workspace.mode === mode} onClick={() => workspace.setMode(mode)}>
								<Icon className="size-3.5" />
								{t(mode === "list" ? "personalTodo.listView" : "personalTodo.calendarView")}
							</Button>
						);
					})}
				</div>
				<Button className="h-10 gap-2 rounded-lg px-4" disabled={!todo.status?.scope} onClick={() => workspace.openCreate()}>
					<Plus className="size-4" />
					{t("personalTodo.createTitle")}
				</Button>
			</header>
			<div className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden">
				{todo.source === "cache" && (
					<span className="flex items-center gap-1 rounded-sm border border-border/60 px-1.5 text-micro text-muted-foreground">
						<WifiOff className="size-3" aria-hidden="true" />
						{t("personalTodo.cacheSource")}
					</span>
				)}
				{todo.summary &&
					queueBadges(todo.summary).map((entry) => (
						<span key={entry.key} className="rounded-sm border border-border/60 px-1.5 text-micro text-muted-foreground">
							{t(entry.key, { count: entry.count })}
						</span>
					))}
			</div>

			{errorKey && (
				<div className="flex shrink-0 items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-caption text-foreground">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
					<span>{t(errorKey)}</span>
				</div>
			)}

			<PersonalTodoFilters todo={todo} workspace={workspace} />
			{workspace.mode === "list" ? <PersonalTodoList todo={todo} workspace={workspace} /> : <PersonalTodoCalendar todo={todo} workspace={workspace} />}
			<footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border/50 pt-2 text-caption text-muted-foreground">
				<span className="mr-auto">{t(scoped ? "personalTodo.loadedWindow" : "personalTodo.loadedCount", { count: todo.items.length })}</span>
				{todo.hasMore && (
					<Button variant="ghost" size="sm" disabled={todo.loadingMore} onClick={todo.loadMore}>
						{t(todo.loadingMore ? "personalTodo.loading" : "personalTodo.loadMore")}
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={todo.refresh} disabled={todo.loading}>
					<RefreshCw className={cn("size-3.5", todo.loading && "animate-spin motion-reduce:animate-none")} />
					{t("personalTodo.refresh")}
				</Button>
			</footer>
			<PersonalTodoPanel open={workspace.creating || todo.selected !== null} title={t(workspace.creating ? "personalTodo.createTitle" : "personalTodo.detailTitle")} onClose={workspace.closePanel} openerRef={workspace.openerRef}>
				{workspace.creating ? (
					<PersonalTodoCreateForm todo={todo} fields={workspace.fields} onFieldsChange={workspace.setFields} submitting={workspace.createSaving} onSubmit={workspace.submitCreate} />
				) : (
					todo.selected && <PersonalTodoDetail key={todo.selected.item.id} todo={todo} view={todo.selected} projectId={projectId} />
				)}
			</PersonalTodoPanel>
		</div>
	);
}

/** 队列摘要角标：只显示非零项，避免「0 条待同步」这类噪音。 */
function queueBadges(summary: { pending: number; sending: number; conflict: number; unknown: number; error: number }): { key: TranslationKey; count: number }[] {
	const badges: { key: TranslationKey; count: number }[] = [];
	if (summary.sending > 0) badges.push({ key: "personalTodo.queueSending", count: summary.sending });
	if (summary.pending > 0) badges.push({ key: "personalTodo.queuePending", count: summary.pending });
	if (summary.conflict > 0) badges.push({ key: "personalTodo.queueConflict", count: summary.conflict });
	if (summary.unknown > 0) badges.push({ key: "personalTodo.queueUnknown", count: summary.unknown });
	if (summary.error > 0) badges.push({ key: "personalTodo.queueError", count: summary.error });
	return badges;
}
