/**
 * 功能页正文的呈现分发：已注册渲染器的页面（见 personalWorkbenchPageRenderers）渲染自己的正文；
 * 其余页面走目录里的「未接入 / 不可用」说明。
 *
 * P01 只做导航时，两个页面都还没有数据源，所以正文统一是一段状态说明；P02 起待办页有了
 * 自己的运行期状态呈现，正文由页面自己给出——静态 `ready` 只表示页面已实现。
 *
 * 说明不接通数据源，也不提供「输入账号」之类的用户侧配置：接入是开发侧的事。
 */
import { t } from "../../i18n";
import { personalWorkbenchPageRenderer, type PersonalWorkbenchPageProps } from "./personalWorkbenchPageRenderers";
import { personalWorkbenchStatusKeys, type PersonalWorkbenchPageDescriptor } from "./personalWorkbenchPages";

export function PersonalWorkbenchPageBody({ page, projectId, onOpenSession }: { page: PersonalWorkbenchPageDescriptor } & PersonalWorkbenchPageProps) {
	const Renderer = personalWorkbenchPageRenderer(page.id);
	if (Renderer) return <Renderer projectId={projectId} onOpenSession={onOpenSession} />;

	const status = personalWorkbenchStatusKeys(page.availability);
	if (!status) return null;
	const Icon = page.icon;
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-5 py-4">
			<div className="flex items-center gap-2">
				<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<h2 className="text-body font-medium text-foreground">{t(status.titleKey)}</h2>
			</div>
			<p className="text-caption leading-5 text-muted-foreground">{t(status.bodyKey)}</p>
			<p className="text-caption leading-5 text-muted-foreground">
				{t(page.titleKey)}：{t(page.summaryKey)}
			</p>
		</div>
	);
}
