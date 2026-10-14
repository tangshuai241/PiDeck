/**
 * 待办页的共用状态块：空态（区分「本来没有」与「筛选后没有」）、首屏加载、整体说明面板。
 *
 * 单独成文件是为了避免页面与列表互相 import（各写一份会让空态文案与清空筛选行为分叉）。
 */
import { Loader2 } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/**
 * 列表为空：区分「本来没有」「筛选后没有」与「已加载窗口内没有（还有下一页）」。
 * 最后一种必须给继续加载入口并说清已看范围：筛选在主进程内对已取回窗口做，
 * 未加载的页不代表不存在。
 */
export function PersonalTodoEmptyState(props: { hasFilters: boolean; onClearFilters: () => void; loadedPages?: number; pageLimit?: number | null }) {
	const windowed = (props.loadedPages ?? 0) > 0 && props.pageLimit != null;
	if (windowed) {
		return (
			<div className="flex flex-col items-center gap-2 px-1 py-4 text-center">
				<p className="text-caption text-muted-foreground">{t("personalTodo.emptyWindow", { pages: props.loadedPages ?? 0, limit: props.pageLimit ?? 0 })}</p>
				{props.hasFilters && (
					<Button variant="ghost" size="sm" onClick={props.onClearFilters}>
						{t("personalTodo.clearFilters")}
					</Button>
				)}
			</div>
		);
	}
	if (!props.hasFilters) return <p className="px-1 py-6 text-center text-caption text-muted-foreground">{t("personalTodo.empty")}</p>;
	return (
		<div className="flex flex-col items-center gap-2 px-1 py-6 text-center">
			<p className="text-caption text-muted-foreground">{t("personalTodo.emptyFiltered")}</p>
			<Button variant="ghost" size="sm" onClick={props.onClearFilters}>
				{t("personalTodo.clearFilters")}
			</Button>
		</div>
	);
}

/** 首屏加载占位（加载更多由列表底部按钮表达）。 */
export function PersonalTodoLoadingState() {
	return (
		<div className="flex items-center justify-center gap-2 px-1 py-6 text-caption text-muted-foreground">
			<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
			{t("personalTodo.loading")}
		</div>
	);
}

/** 整体状态面板：服务版本不支持、账号未连接等（不伪造数据，也不隐藏入口）。 */
export function PersonalTodoNoticePanel(props: { icon: React.ReactNode; titleKey: TranslationKey; bodyKey: TranslationKey }) {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-5 py-4">
			<div className="flex items-center gap-2">
				<span className="shrink-0 text-muted-foreground">{props.icon}</span>
				<h2 className="text-body font-medium text-foreground">{t(props.titleKey)}</h2>
			</div>
			<p className="text-caption leading-5 text-muted-foreground">{t(props.bodyKey)}</p>
		</div>
	);
}
