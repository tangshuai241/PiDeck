/**
 * 阅读页的共用说明块：整体不可用、能力不足、内联失败原因。
 *
 * 单独成文件是为了让「服务不可用要说清原因」「坏文件原样错误」这类文案只有一处实现；
 * 错误一律用结构化 code 映射文案（见 utils/readingState），服务端原始文本只在
 * 「文件不可读」这类必须原样转达的场合单独附上。
 */
import type { ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";

/** 整块状态面板：服务未接入、连不上、需要密码（不伪造数据，也不隐藏入口）。 */
export function ReadingNoticePanel(props: { icon: ReactNode; titleKey: TranslationKey; bodyKey: TranslationKey; children?: ReactNode }) {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-5 py-4">
			<div className="flex items-center gap-2">
				<span className="shrink-0 text-muted-foreground">{props.icon}</span>
				<h2 className="text-body font-medium text-foreground">{t(props.titleKey)}</h2>
			</div>
			<p className="text-caption leading-5 text-muted-foreground">{t(props.bodyKey)}</p>
			{props.children}
		</div>
	);
}

/** 内联失败原因：顶部/面板内的单行说明；`detail` 只在必须原样转达服务端原因时给。 */
export function ReadingInlineError(props: { messageKey: TranslationKey; detail?: string | null; tone?: "danger" | "muted" }) {
	const tone = props.tone ?? "danger";
	const border = tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-border/60 bg-muted/20";
	const iconColor = tone === "danger" ? "text-danger" : "text-muted-foreground";
	return (
		<div className={`flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-caption text-foreground ${border}`}>
			<AlertTriangle className={`mt-0.5 size-3.5 shrink-0 ${iconColor}`} aria-hidden="true" />
			<span className="min-w-0">
				{t(props.messageKey)}
				{props.detail && <span className="ml-1 break-all text-muted-foreground">({props.detail})</span>}
			</span>
		</div>
	);
}

/** 中性提示行（位置已保存、陈旧回章首等），不属于错误。 */
export function ReadingHint(props: { messageKey: TranslationKey; params?: Record<string, string | number>; icon?: ReactNode }) {
	return (
		<p className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
			{props.icon ?? <Info className="size-3 shrink-0" aria-hidden="true" />}
			<span className="min-w-0 truncate">{t(props.messageKey, props.params)}</span>
		</p>
	);
}
