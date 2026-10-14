/**
 * 旧阅读历史面板：两个来源各自分页，按需回看原始 JSON。
 *
 * 呈现纪律（契约 §历史）：
 * - 两个 source 分开列；同 id 不同 source 是两个条目（hook 的 atom 也分族）；
 * - `unattributed` 只加标注，不猜归属；不可读文件留在列表里并原样显示服务端给的原因；
 * - 每页给「加载更多」（有游标才给）；回看时明确 truncated；原文标注「不是 Pi 会话」；
 * - 接口未部署时明确说「服务未提供」，不放示例数据冒充实迁记录。
 */
import { useState } from "react";
import { FileJson2, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingHistorySession, ReadingHistorySourceName } from "../../../../shared/types/reading";
import type { ReadingHistoryController } from "../../hooks/useReadingHistory";
import { readingErrorInfoKey } from "../../utils/readingState";
import { readingHistoryAttributionKey, readingHistoryCountEntries, readingHistorySessionKey, readingHistoryUnreadable } from "../../utils/readingHistory";
import { Button } from "../ui-shadcn/button";
import { ReadingHint, ReadingInlineError } from "./ReadingNotices";

export function ReadingHistoryPanel(props: { history: ReadingHistoryController }) {
	const { history } = props;
	const [active, setActive] = useState<ReadingHistorySourceName>("deepread-current");
	if (!history.clientAvailable || history.unsupported) return <ReadingInlineError messageKey="reading.capabilityUnsupported" tone="muted" />;
	if (history.sourcesError) return <ReadingInlineError messageKey={readingErrorInfoKey(history.sourcesError) ?? "reading.errorInternal"} />;
	if (history.sourcesLoading && history.sources.length === 0) {
		return (
			<div className="flex items-center gap-2 text-caption text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
				{t("reading.historyLoading")}
			</div>
		);
	}
	const state = history.stateFor(active);
	const read = history.readState;

	return (
		<div className="flex min-h-0 shrink-0 flex-col gap-3">
			<header className="flex flex-wrap items-center gap-2">
				<span className="text-caption font-medium text-foreground">{t("reading.historyTitle")}</span>
				<span className="min-w-0 flex-1" />
				<Button variant="ghost" size="sm" disabled={state.loading} onClick={() => void history.loadSource(active)}>
					<RefreshCw className={state.loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
					{t("reading.historyReload")}
				</Button>
			</header>
			<div className="flex flex-wrap gap-1">
				{history.sources.map((source) => (
					<Button key={source.source} variant={source.source === active ? "secondary" : "ghost"} size="sm" onClick={() => setActive(source.source)}>
						{source.label}
						<span className="ml-1 text-micro text-muted-foreground">{source.count}</span>
					</Button>
				))}
			</div>
			{history.sources.find((source) => source.source === active)?.readable === false && <ReadingHint messageKey="reading.historySourceUnreadable" />}
			{state.error && <ReadingInlineError messageKey={readingErrorInfoKey(state.error) ?? "reading.errorInternal"} />}
			{state.sessions.length === 0 && !state.loading && <p className="text-micro text-muted-foreground">{t("reading.historyEmpty")}</p>}
			<ul className="flex flex-col gap-1">
				{state.sessions.map((session) => (
					<SessionRow key={readingHistorySessionKey(session)} session={session} active={read.key === readingHistorySessionKey(session)} onRead={() => void history.readSession(session.source, session.id)} />
				))}
			</ul>
			{state.nextCursor !== null && (
				<Button variant="ghost" size="sm" className="self-start" disabled={state.loadingMore} onClick={() => void history.loadMore(active)}>
					<MoreHorizontal className="size-3.5" aria-hidden="true" />
					{t("reading.historyMore")}
				</Button>
			)}
			{read.loading && (
				<div className="flex items-center gap-2 text-micro text-muted-foreground">
					<Loader2 className="size-3 animate-spin" aria-hidden="true" />
					{t("reading.historyReadingRaw")}
				</div>
			)}
			{read.result && !read.result.ok && <ReadingInlineError messageKey={readingErrorInfoKey(read.result.error) ?? "reading.errorInternal"} />}
			{read.result?.ok === true && (
				<section className="flex min-h-0 flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 p-2">
					<header className="flex items-center gap-1.5">
						<FileJson2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate text-caption text-foreground">{t("reading.historyRawTitle")}</span>
						<Button variant="ghost" size="sm" onClick={history.clearRead}>
							{t("reading.noteClose")}
						</Button>
					</header>
					<ReadingHint messageKey="reading.historyNotPiSession" />
					{read.result.truncated && <ReadingHint messageKey="reading.historyTruncated" />}
					{/* 原文只读：逐字节来自本次响应，不改写、不重新序列化 */}
					<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-background/60 p-2 text-micro leading-4 text-foreground">{read.result.raw}</pre>
				</section>
			)}
		</div>
	);
}

/** 单条旧会话：归属未知单独标注；不可读时显示服务端原文原因（不做「坏文件」之类的改写）。 */
function SessionRow(props: { session: ReadingHistorySession; active: boolean; onRead: () => void }) {
	const attributionKey = readingHistoryAttributionKey(props.session.attribution);
	const counts = readingHistoryCountEntries(props.session);
	return (
		<li className={`flex flex-col gap-0.5 rounded-lg border px-2 py-1.5 ${props.active ? "border-border bg-accent/40" : "border-border/60"}`}>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-caption text-foreground">{props.session.title ?? props.session.id}</span>
				{readingHistoryUnreadable(props.session) ? (
					<span className="shrink-0 text-micro text-danger">{t("reading.historyUnreadable")}</span>
				) : (
					<Button variant="ghost" size="sm" onClick={props.onRead}>
						{t("reading.historyReadRaw")}
					</Button>
				)}
			</div>
			<span className="min-w-0 truncate text-micro text-muted-foreground">{[props.session.bookLabel, props.session.chapterLabel].filter(Boolean).join(" · ") || t("reading.historyNoLabels")}</span>
			<div className="flex flex-wrap items-center gap-1 text-micro text-muted-foreground">
				{attributionKey && <span className="rounded-sm border border-border/60 px-1">{t(attributionKey)}</span>}
				{props.session.model !== null && <span>{props.session.model}</span>}
				{counts.map((entry) => (
					<span key={entry.key}>
						{entry.key} {entry.value}
					</span>
				))}
			</div>
			{readingHistoryUnreadable(props.session) && props.session.error !== null && <span className="break-all text-micro text-danger">{props.session.error}</span>}
		</li>
	);
}
