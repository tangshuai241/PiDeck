/**
 * 阅读页：作品/版本 + 目录 + 按章正文 + 笔记/历史侧栏的薄装配。
 *
 * 这个组件只做四件事，业务都在各域 hook 与 utils 里：
 * 1. 决定页面级状态显示什么（未接入 / 连不上 / 需要密码 / 加载中 / 正文工作区）；
 * 2. 把选中版本、正文身份、位置控制器交给子面板；
 * 3. 维持三栏布局与侧栏分区切换（本地 UI 状态，不放 atom）；
 * 4. 重开时自动回到上次那一章：位置计划指向的章节在目录里时打开它一次，
 *    之后由位置控制器在正文加载完成后恢复滚动位置（「同版同章同位置」）。
 *
 * 页面未打开 = 本组件未挂载 = 没有任何阅读请求（不启动探测、无定时器、无轮询）。
 */
import { useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { BookMarked, History, Loader2, NotebookPen, PlugZap, ServerOff, WifiOff } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingErrorInfo } from "../../../../shared/types/reading";
import { useReadingClient, useReadingCore } from "../../hooks/useReadingCore";
import { useReadingHistory } from "../../hooks/useReadingHistory";
import { useReadingNotes } from "../../hooks/useReadingNotes";
import { useReadingPosition } from "../../hooks/useReadingPosition";
import { readingSelectionAtom } from "../../atoms/reading-atoms";
import { Button } from "../ui-shadcn/button";
import { ReadingChapterView } from "./ReadingChapterView";
import { ReadingConnectionPanel } from "./ReadingConnectionPanel";
import { ReadingHistoryPanel } from "./ReadingHistoryPanel";
import { ReadingLibraryPanel } from "./ReadingLibraryPanel";
import { ReadingNotesPanel } from "./ReadingNotesPanel";
import { ReadingInlineError, ReadingNoticePanel } from "./ReadingNotices";
import { ReadingTocPanel } from "./ReadingTocPanel";
import { ReadingMaterialEntry } from "./ReadingMaterialEntry";
import { applyReadingSelectionSnapshot } from "../../utils/readingSelection";

export function ReadingPage(props: { projectId?: string; onOpenSession?: (projectId: string, sessionId: string) => void | Promise<void> }) {
	const client = useReadingClient();
	const core = useReadingCore({ client });
	const notes = useReadingNotes({ client, workId: core.selected?.workId ?? null, editionId: core.selected?.editionId ?? null });
	// 历史只在 ready 后启用：fresh/断开时 client=null，不得旁路 fresh 门去请求来源；
	// connectionKey（当前 baseUrl）变化时 hook 内会作废在飞票据并清空旧地址状态。
	const history = useReadingHistory({ client: core.decision.kind === "ready" ? client : null, connectionKey: core.status?.connection.baseUrl ?? null });
	const setSelection = useSetAtom(readingSelectionAtom);
	const [sidePanel, setSidePanel] = useState<"notes" | "history">("notes");
	const [connectError, setConnectError] = useState<ReadingErrorInfo | null>(null);
	// ready 态同样要能改服务地址/断开：复用同一个 ReadingConnectionPanel（无新 IPC）
	const [connectionOpen, setConnectionOpen] = useState(false);

	const contentVersion = core.edition?.identity.contentVersion ?? null;
	const position = useReadingPosition({
		client,
		workId: core.selected?.workId ?? null,
		editionId: core.selected?.editionId ?? null,
		contentVersion,
		chapterLoaded: core.chapter !== null,
		chapterHref: core.chapterHref,
		chapterNum: core.chapter?.chapterNum ?? null,
		chapterTextDigest: core.chapter?.textDigest ?? null,
		tocHrefs: core.tocHrefs,
	});

	const { chapter, chapterLoading, edition, openChapter, selected } = core;
	// P04：材料入口需要书名/版本名/章节标题（只作来源标签，不做定位）。
	const selectedWorkTitle = selected ? (core.libraryWorks.find((work) => work.workId === selected.workId)?.title ?? null) : null;
	const planHref = position.plan.kind === "restore" ? position.plan.chapterHref : null;
	/** 每个版本只自动跳一次：手动关掉章节后不再把用户拉回去。 */
	const autoOpenRef = useRef<{ bookKey: string; opened: boolean }>({ bookKey: "", opened: false });
	useEffect(() => {
		const bookKey = selected ? `${selected.workId}:${selected.editionId}` : "";
		if (autoOpenRef.current.bookKey !== bookKey) autoOpenRef.current = { bookKey, opened: false };
		if (planHref === null || autoOpenRef.current.opened || chapter !== null || chapterLoading) return;
		const item = (edition?.toc ?? []).find((entry) => entry.href.trim() === planHref.trim());
		if (!item) return;
		autoOpenRef.current.opened = true;
		void openChapter(item);
	}, [chapter, chapterLoading, edition, openChapter, planHref, selected]);

	if (!core.clientAvailable) {
		return <ReadingNoticePanel icon={<ServerOff className="size-4" aria-hidden="true" />} titleKey="reading.noticeUnsupportedTitle" bodyKey="reading.noticeUnsupportedBody" />;
	}
	if (core.decision.kind === "loading") {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-caption text-muted-foreground">
				<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
				{t("reading.statusLoading")}
			</div>
		);
	}
	if (core.decision.kind === "needsConnection" || core.decision.kind === "unavailable" || core.decision.kind === "unsupported") {
		return (
			<ReadingNoticePanel
				icon={<WifiOff className="size-4" aria-hidden="true" />}
				titleKey={core.decision.kind === "needsConnection" ? "reading.noticeNeedsConnectionTitle" : "reading.noticeUnavailableTitle"}
				bodyKey={core.decision.kind === "needsConnection" ? "reading.noticeNeedsConnectionBody" : "reading.noticeUnavailableBody"}
			>
				{connectError && <ReadingInlineError messageKey={connectError.code === "secureStorageUnavailable" ? "reading.errorSecureStorage" : "reading.errorNeedsConnection"} />}
				{core.decision.kind !== "unsupported" && (
					<ReadingConnectionPanel
						connection={core.status?.connection ?? null}
						secureStorageAvailable={connectError?.code !== "secureStorageUnavailable"}
						busy={core.statusLoading}
						onConnect={(input) =>
							void core.connect(input).then((error) => {
								setConnectError(error);
								if (error === null) setSidePanel("notes");
							})
						}
						onDisconnect={() => void core.disconnect()}
					/>
				)}
			</ReadingNoticePanel>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col gap-3">
			<header className="flex shrink-0 flex-wrap items-center gap-2">
				<span className="text-caption text-muted-foreground">{core.status?.connection.baseUrl ?? ""}</span>
				{core.status?.connection.connected === true && <span className="text-micro text-muted-foreground">{t("reading.connectionConnected")}</span>}
				<Button variant="ghost" size="sm" className="shrink-0" aria-expanded={connectionOpen} onClick={() => setConnectionOpen((open) => !open)}>
					<PlugZap className="size-3.5" aria-hidden="true" />
					{t("reading.connectionSettings")}
				</Button>
				{core.status?.notesApi === false && <span className="text-micro text-warning">{t("reading.capabilityNotesUnsupported")}</span>}
				{core.status?.historyApi === false && <span className="text-micro text-warning">{t("reading.capabilityHistoryUnsupported")}</span>}
				{edition && <span className="min-w-0 truncate text-micro text-muted-foreground">{t("reading.identitySource", { rel: edition.identity.filename ?? edition.identity.editionId, version: edition.identity.contentVersion })}</span>}
				<span className="min-w-0 flex-1" />
				{core.libraryError && <span className="text-micro text-danger">{t("reading.errorUnavailable")}</span>}
				{core.editionError && <span className="text-micro text-danger">{t("reading.errorNotFound")}</span>}
			</header>
			{connectionOpen && (
				<section className="shrink-0 rounded-lg border border-border/60 bg-bg-panel px-3 py-2">
					<ReadingConnectionPanel
						connection={core.status?.connection ?? null}
						secureStorageAvailable={connectError?.code !== "secureStorageUnavailable"}
						busy={core.statusLoading}
						onConnect={(input) =>
							void core.connect(input).then((error) => {
								setConnectError(error);
								if (error === null) setConnectionOpen(false);
							})
						}
						onDisconnect={() => void core.disconnect()}
					/>
					{connectError && <ReadingInlineError messageKey={connectError.code === "secureStorageUnavailable" ? "reading.errorSecureStorage" : "reading.errorNeedsConnection"} />}
				</section>
			)}
			<div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
				<aside className="flex min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border/60 bg-bg-panel p-2 lg:w-[280px]">
					<ReadingLibraryPanel works={core.libraryWorks} loading={core.libraryLoading} selected={core.selected} onSelect={core.selectBook} onRefresh={() => void core.refreshLibrary()} />
					<ReadingTocPanel toc={edition?.toc ?? []} activeHref={core.chapterHref} onOpen={(item) => void core.openChapter(item)} />
				</aside>
				<main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border/60 bg-bg-panel p-3">
					<ReadingChapterView
						chapter={chapter}
						requestHref={core.chapterHref}
						loading={chapterLoading}
						error={core.chapterError}
						workId={selected?.workId ?? ""}
						editionId={selected?.editionId ?? ""}
						editionSource={edition?.identity.filename ?? edition?.identity.editionId ?? null}
						contentVersion={contentVersion}
						position={position}
						selection={core.selection}
						selectionAction={
							selected ? (
								<ReadingMaterialEntry
									workId={selected.workId}
									editionId={selected.editionId}
									contentVersion={contentVersion}
									chapterHref={core.chapterHref ?? chapter?.href ?? ""}
									chapterNum={chapter?.chapterNum ?? null}
									workTitle={selectedWorkTitle}
									editionTitle={edition?.identity.filename ?? edition?.identity.editionId ?? null}
									chapterTitle={chapter?.title ?? null}
									selection={core.selection}
									projectId={props.projectId}
									onOpenSession={props.onOpenSession}
								/>
							) : null
						}
						onVerified={core.verifySelection}
						onSnapshot={(snapshot, quote) => setSelection((previous) => applyReadingSelectionSnapshot(previous, snapshot, quote))}
						onClearSnapshot={core.clearSelection}
					/>
				</main>
				<aside className="flex min-h-0 w-full shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border/60 bg-bg-panel p-2 lg:w-[340px]">
					<div className="flex shrink-0 gap-1">
						<Button variant={sidePanel === "notes" ? "secondary" : "ghost"} size="sm" onClick={() => setSidePanel("notes")}>
							<NotebookPen className="size-3.5" aria-hidden="true" />
							{t("reading.notesTitle")}
						</Button>
						<Button variant={sidePanel === "history" ? "secondary" : "ghost"} size="sm" onClick={() => setSidePanel("history")}>
							<History className="size-3.5" aria-hidden="true" />
							{t("reading.historyTitle")}
						</Button>
					</div>
					{sidePanel === "notes" ? <ReadingNotesPanel notes={notes} chapterLabel={chapter?.title ?? null} /> : <ReadingHistoryPanel history={history} />}
				</aside>
			</div>
			{chapter === null && (
				<p className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
					<BookMarked className="size-3 shrink-0" aria-hidden="true" />
					{t("reading.workspaceHint")}
				</p>
			)}
		</div>
	);
}
