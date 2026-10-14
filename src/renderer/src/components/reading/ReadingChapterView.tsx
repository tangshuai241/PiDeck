/**
 * 正文视图（按章纯文本）：拥有滚动视口，负责位置恢复/写回与选区核验入口。
 *
 * 为什么滚动与选区都放在这个组件：它们是同一块 DOM 的两件事——只有这里量得到真实视口，
 * 也只有这里拿得到用户选中的文本。但组件只「上报事实」：该不该恢复、要不要写位置、
 * 偏移填不填，全部交给 utils 里的纯策略（readingPosition / readingSelection）。
 *
 * 三条硬规则：
 * - 恢复只在正文加载完成、容器有真实高度时执行一次（restore.key 幂等）；零高度不覆盖。
 * - 保存只上报「真实可滚动视口」的 fraction；不可滚动时不报（避免用 0 顶掉旧位置）。
 * - 偏移只在核验通过时进快照；核验不通过就如实显示状态，不猜 start/end。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingChapter, ReadingErrorInfo, ReadingQuoteResult, ReadingSelectionSnapshot } from "../../../../shared/types/reading";
import type { ReadingPositionController } from "../../hooks/useReadingPosition";
import type { ReadingSelectionState } from "../../atoms/reading-atoms";
import { Button } from "../ui-shadcn/button";
import { ReadingHint, ReadingInlineError } from "./ReadingNotices";
import { readingErrorInfoKey } from "../../utils/readingState";
import { createReadingSelectionSnapshot, readingQuoteOffsets, readingQuoteStatusKey, readingSelectionVerifiable } from "../../utils/readingSelection";

export function ReadingChapterView(props: {
	chapter: ReadingChapter | null;
	requestHref: string | null;
	loading: boolean;
	error: ReadingErrorInfo | null;
	workId: string;
	editionId: string;
	/** 版本来源（文件名或 editionId）：与 contentVersion 一起固定「读的是哪一份」 */
	editionSource: string | null;
	contentVersion: string | null;
	position: ReadingPositionController;
	selection: ReadingSelectionState;
	/** P04：选区动作插槽（带入会话）；由阅读页合成，章节视图不认材料域。 */
	selectionAction?: ReactNode;
	onVerified: (text: string) => Promise<ReadingQuoteResult | null>;
	onSnapshot: (snapshot: ReadingSelectionSnapshot, quote: ReadingQuoteResult) => void;
	onClearSnapshot: () => void;
}) {
	const { chapter, position, editionId, workId, contentVersion, requestHref, onVerified, onSnapshot } = props;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const frameRef = useRef<number | null>(null);
	const lastReportedRef = useRef<number | null>(null);
	const [selectedText, setSelectedText] = useState("");

	/** 视口测量与上报：rAF 合并滚动事件；fraction 变化小于 1% 不打扰 hook。 */
	const reportViewport = useCallback(() => {
		const node = scrollRef.current;
		if (!node) return;
		const fraction = node.scrollHeight > node.clientHeight ? node.scrollTop / (node.scrollHeight - node.clientHeight) : 0;
		if (!(node.scrollHeight > node.clientHeight)) return;
		if (lastReportedRef.current !== null && Math.abs(fraction - lastReportedRef.current) < 0.01) return;
		lastReportedRef.current = fraction;
		position.reportViewport({ fraction, viewportHeight: node.clientHeight, scrollHeight: node.scrollHeight });
	}, [position]);

	useEffect(() => {
		const node = scrollRef.current;
		if (!node) return;
		const onScroll = () => {
			if (frameRef.current !== null) return;
			frameRef.current = window.requestAnimationFrame(() => {
				frameRef.current = null;
				reportViewport();
			});
		};
		node.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			node.removeEventListener("scroll", onScroll);
			if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		};
	}, [reportViewport]);

	/** 恢复：正文已渲染、容器可滚动时应用一次；恢复完回报 ack（hook 才不会重复下发）。 */
	useLayoutEffect(() => {
		const restore = position.restore;
		const node = scrollRef.current;
		if (!restore || !node || chapter === null) return;
		const span = node.scrollHeight - node.clientHeight;
		if (span > 0) {
			node.scrollTop = Math.round(restore.fraction * span);
			lastReportedRef.current = restore.fraction;
		}
		position.ackRestore(restore.key);
	}, [chapter, position]);

	/** 选区核验：选中文本 → 交主进程核验（P03 不发往任何会话），状态与快照都在这里呈现。 */
	const captureSelection = useCallback(() => {
		const text = window.getSelection()?.toString() ?? "";
		const trimmed = text.trim();
		if (!readingSelectionVerifiable(trimmed) || trimmed === selectedText) return;
		setSelectedText(trimmed);
		void (async () => {
			const quote = await onVerified(trimmed);
			if (quote === null || !quote.ok) return;
			// 快照身份取自本次正文：版本、章节 href 都是「实际读到的这一份」
			onSnapshot(createReadingSelectionSnapshot({ workId, editionId, contentVersion: contentVersion ?? quote.identity.contentVersion, chapterHref: requestHref ?? chapter?.href ?? "", chapterNum: chapter?.chapterNum ?? null, text: trimmed, quote }), quote);
		})();
	}, [chapter?.chapterNum, chapter?.href, contentVersion, editionId, onSnapshot, onVerified, requestHref, selectedText, workId]);

	if (props.loading) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-caption text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
				{t("reading.chapterLoading")}
			</div>
		);
	}
	const errorKey = readingErrorInfoKey(props.error);
	if (errorKey) {
		return (
			<div className="flex h-full flex-col gap-3">
				<ReadingInlineError messageKey={errorKey} />
			</div>
		);
	}
	if (chapter === null) {
		return <div className="flex h-full items-center justify-center text-caption text-muted-foreground">{t("reading.chapterEmpty")}</div>;
	}

	const offsets = readingQuoteOffsets(props.selection.quote);
	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<header className="flex shrink-0 flex-wrap items-baseline gap-2">
				<span className="min-w-0 truncate text-body font-medium text-foreground">{chapter.title.trim().length > 0 ? chapter.title : (props.requestHref ?? "")}</span>
				<span className="shrink-0 text-micro text-muted-foreground">{t("reading.chapterWordCount", { count: chapter.wordCount })}</span>
				<span className="min-w-0 flex-1" />
				{props.editionSource && <span className="min-w-0 truncate text-micro text-muted-foreground">{props.editionSource}</span>}
				<span className="shrink-0 text-micro text-muted-foreground">{t("reading.contentVersion", { version: contentVersion ?? "—" })}</span>
			</header>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{props.position.saving && <ReadingHint messageKey="reading.positionSaving" />}
				{!props.position.saving && props.position.savedAt !== null && <ReadingHint messageKey="reading.positionSaved" />}
				{props.position.staleReasonKey && <ReadingHint messageKey={props.position.staleReasonKey} />}
				<ReadingHint messageKey="reading.selectionHint" />
			</div>
			{props.selection.error && <ReadingInlineError messageKey={readingErrorInfoKey(props.selection.error) ?? "reading.errorInternal"} />}
			{selectedText.length > 0 && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
					{props.selection.verifying ? (
						<Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
					) : (
						<span className="text-caption text-foreground">{props.selection.quote !== null && props.selection.quote.ok ? t(readingQuoteStatusKey(props.selection.quote.status)) : t("reading.quoteUnknown")}</span>
					)}
					<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{selectedText.slice(0, 80)}</span>
					<span className="shrink-0 text-micro text-muted-foreground">{offsets.start !== null && offsets.end !== null ? t("reading.selectionOffsets", { start: offsets.start, end: offsets.end }) : t("reading.selectionOffsetsUnknown")}</span>
					{props.selectionAction}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setSelectedText("");
							props.onClearSnapshot();
						}}
					>
						{t("reading.selectionClear")}
					</Button>
				</div>
			)}
			{props.selection.snapshot && <ReadingHint icon={null} messageKey="reading.selectionSnapshot" params={{ chapter: props.selection.snapshot.chapterHref, version: props.selection.snapshot.contentVersion }} />}
			{/* 正文纯文本保真：whitespace-pre-wrap 保留段落与换行，不注入 HTML、不做 EPUB 原版排版 */}
			<div ref={scrollRef} onMouseUp={captureSelection} onKeyUp={captureSelection} className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-bg-panel px-4 py-3">
				<p className="whitespace-pre-wrap break-words text-body leading-7 text-foreground">{chapter.text}</p>
			</div>
		</div>
	);
}
