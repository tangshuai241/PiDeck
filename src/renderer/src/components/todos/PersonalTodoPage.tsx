/**
 * 待办页（P02）：列表 + 详情的两栏工作区，所有状态都来自 `usePersonalTodo`。
 *
 * 为什么页面自己管状态呈现而不是复用 P01 的「未接入」说明：P01 的说明属于「数据源尚未接入」，
 * 而待办页已经实现——它需要的是运行期状态（服务版本不支持、账号未连接、缓存、队列、冲突）。
 * 静态 `availability: "ready"` 表示页面已实现；账号/服务/写入可用性只在打开这一页后显示
 * （不新增启动探测或后台轮询）。
 */
import { AlertTriangle, CloudOff, RefreshCw, ServerOff, WifiOff } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { usePersonalTodo } from "../../hooks/usePersonalTodo";
import { personalTodoErrorKey } from "../../utils/personalTodoState";
import { PersonalTodoCreateForm } from "./PersonalTodoCreateForm";
import { PersonalTodoDetail } from "./PersonalTodoDetail";
import { PersonalTodoFilters } from "./PersonalTodoFilters";
import { PersonalTodoList } from "./PersonalTodoList";
import { PersonalTodoNoticePanel } from "./PersonalTodoStates";

export function PersonalTodoPage(props: { projectId?: string; onOpenSession?: (projectId: string, sessionId: string) => void | Promise<void> }) {
	const todo = usePersonalTodo();
	const status = todo.status;
	const list = { source: todo.source, error: todo.items.length === 0 ? todo.pageError : null };

	// 接口未接入 / 云端版本不支持：不伪造数据，也不隐藏入口，说明清原因
	if (!todo.clientAvailable || (status !== null && !status.supported)) {
		return <PersonalTodoNoticePanel icon={<ServerOff className="size-4" aria-hidden="true" />} titleKey="personalTodo.unsupportedTitle" bodyKey="personalTodo.unsupportedBody" />;
	}
	// 账号未连接：待办沿用已连接的云端账号，这里不接受输入账号或密码
	if (status !== null && status.scope === null) {
		return <PersonalTodoNoticePanel icon={<CloudOff className="size-4" aria-hidden="true" />} titleKey="personalTodo.notConnectedTitle" bodyKey="personalTodo.notConnectedBody" />;
	}

	const errorKey = list.error ? personalTodoErrorKey(list.error.code) : todo.pageError ? personalTodoErrorKey(todo.pageError.code) : null;

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<header className="flex shrink-0 flex-wrap items-center gap-2">
				<span className="text-body font-medium text-foreground">{t("personalWorkbench.todo")}</span>
				{list.source === "cache" && (
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
				<span className="min-w-0 flex-1" />
				<Button variant="ghost" size="sm" className="shrink-0" onClick={todo.refresh} disabled={todo.loading}>
					<RefreshCw className={todo.loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
					{t("personalTodo.refresh")}
				</Button>
			</header>

			{errorKey && (
				<div className="flex shrink-0 items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-caption text-foreground">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
					<span>{t(errorKey)}</span>
				</div>
			)}

			<div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
				<section className="flex min-h-0 w-full shrink-0 flex-col gap-2 rounded-lg border border-border/60 bg-bg-panel p-3 lg:w-[360px]">
					<PersonalTodoFilters todo={todo} />
					<PersonalTodoList todo={todo} />
				</section>
				<section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-bg-panel p-3">
					{todo.selected ? (
						<PersonalTodoDetail todo={todo} view={todo.selected} projectId={props.projectId} />
					) : (
						<div className="flex h-full min-h-0 flex-col gap-3">
							<PersonalTodoCreateForm todo={todo} />
							<p className="mt-auto text-caption text-muted-foreground">{t("personalTodo.selectHint")}</p>
						</div>
					)}
				</section>
			</div>
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
