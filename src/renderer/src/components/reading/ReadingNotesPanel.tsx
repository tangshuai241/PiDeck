/**
 * 笔记面板：列表（主账 + 归属未知分开）、读取、未确认草稿、编辑器。
 *
 * 只呈现 hook 给出的事实：
 * - 旧笔记的 `chapterLabel` 原文显示，`unlocated`/`linkStatus` 由服务端判定并如实标注（绝不宣称精准定位）；
 * - 未确认草稿按 requestId 列在独立分区，可「重试」（复用原请求）或「丢弃」（仅本地）；
 * - 服务未提供笔记能力时给内联原因，正文阅读不受影响。
 */
import { AlertTriangle, Database, FileWarning, Plus, RotateCcw, Trash2 } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingNoteDraft, ReadingNoteSummary } from "../../../../shared/types/reading";
import type { ReadingNotesController } from "../../hooks/useReadingNotes";
import { readingErrorInfoKey } from "../../utils/readingState";
import { readingNoteLocationHint, readingNoteSaveStateKey, readingNoteSectionLabelKey } from "../../utils/readingNotes";
import { Button } from "../ui-shadcn/button";
import { ReadingHint, ReadingInlineError } from "./ReadingNotices";
import { ReadingNoteEditor } from "./ReadingNoteEditor";

export function ReadingNotesPanel(props: { notes: ReadingNotesController; chapterLabel: string | null }) {
	const { notes } = props;
	if (notes.unsupported) return <ReadingInlineError messageKey="reading.capabilityUnsupported" tone="muted" />;

	return (
		<div className="flex min-h-0 shrink-0 flex-col gap-3">
			{notes.error && <ReadingInlineError messageKey={readingErrorInfoKey(notes.error) ?? "reading.errorInternal"} />}
			{notes.draftIssue && <ReadingInlineError messageKey="reading.noteDraftIssue" detail={notes.draftIssue.message} />}
			<section className="flex flex-col gap-1">
				<header className="flex items-center justify-between gap-2">
					<span className="text-caption font-medium text-foreground">{t("reading.notesTitle")}</span>
					<Button variant="ghost" size="sm" onClick={() => notes.selectTarget(null, "create")}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("reading.noteCreate")}
					</Button>
				</header>
				{notes.notes.length === 0 && <p className="text-micro text-muted-foreground">{t("reading.notesEmpty")}</p>}
				<ul className="flex flex-col gap-1">
					{notes.notes.map((note) => (
						<NoteRow key={note.noteId} note={note} onOpen={() => void notes.openNote(note.noteId)} onEdit={() => notes.selectTarget(note.noteId, "append")} />
					))}
				</ul>
			</section>
			{notes.unattributed.length > 0 && (
				<section className="flex flex-col gap-1">
					<header className="flex items-center gap-1.5">
						<span className="text-caption font-medium text-foreground">{t("reading.notesUnattributedTitle")}</span>
						<span className="text-micro text-muted-foreground">{t("reading.notesUnattributedHint")}</span>
					</header>
					<ul className="flex flex-col gap-1">
						{notes.unattributed.map((note) => (
							<NoteRow key={note.noteId} note={note} onOpen={() => void notes.openNote(note.noteId)} onEdit={() => notes.selectTarget(note.noteId, "append")} />
						))}
					</ul>
				</section>
			)}
			{notes.open && (
				<section className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 p-2">
					<header className="flex flex-wrap items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-caption text-foreground">{notes.open.note.name}</span>
						<Button variant="ghost" size="sm" onClick={notes.closeNote}>
							{t("reading.noteClose")}
						</Button>
					</header>
					{notes.open.truncated && <ReadingHint messageKey="reading.noteTruncated" />}
					<p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-caption leading-5 text-foreground">{notes.open.content}</p>
				</section>
			)}
			<ReadingNoteEditor notes={notes} chapterLabel={props.chapterLabel} />
			{notes.drafts.length > 0 && (
				<section className="flex flex-col gap-1">
					<span className="text-caption font-medium text-foreground">{t("reading.noteDraftTitle")}</span>
					{notes.drafts.map((draft) => (
						<DraftRow key={draft.requestId} draft={draft} onRetry={() => void notes.retryDraft(draft.requestId)} onDiscard={() => void notes.discardDraft(draft.requestId)} />
					))}
				</section>
			)}
			{notes.submitState.lastState && <ReadingHint messageKey={readingNoteSaveStateKey(notes.submitState.lastState)} />}
		</div>
	);
}

/** 单条笔记：章节标签原文 + 定位提示；summary 只来自服务端。 */
function NoteRow(props: { note: ReadingNoteSummary; onOpen: () => void; onEdit: () => void }) {
	const hint = readingNoteLocationHint(props.note);
	return (
		<li className="flex flex-col gap-0.5 rounded-sm px-2 py-1 hover:bg-accent/40">
			<div className="flex items-center gap-2">
				<button type="button" className="min-w-0 flex-1 truncate text-left text-caption text-foreground" onClick={props.onOpen}>
					{props.note.name}
				</button>
				<button type="button" className="shrink-0 text-micro text-muted-foreground hover:text-foreground" onClick={props.onEdit}>
					{t("reading.noteAppend")}
				</button>
			</div>
			<span className="min-w-0 truncate text-micro text-muted-foreground">
				{hint.label ?? t("reading.noteNoLabel")}
				{hint.hintKey && <span className="ml-1 text-warning">· {t(hint.hintKey)}</span>}
			</span>
		</li>
	);
}

/** 未确认草稿：显示原操作与原载荷摘要，提供「重试原请求」与「丢弃（仅本地）」。 */
function DraftRow(props: { draft: ReadingNoteDraft; onRetry: () => void; onDiscard: () => void }) {
	const sectionKey = props.draft.section !== null ? readingNoteSectionLabelKey(props.draft.section) : null;
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-muted/20 px-2 py-1.5">
			<div className="flex items-center gap-2">
				<FileWarning className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate text-caption text-foreground">
					{t("reading.noteDraftOp", { op: props.draft.op })}
					{sectionKey ? ` · ${t(sectionKey)}` : ""}
				</span>
				<Button variant="ghost" size="sm" onClick={props.onRetry}>
					<RotateCcw className="size-3.5" aria-hidden="true" />
					{t("reading.noteRetryDraft")}
				</Button>
				<Button variant="ghost" size="sm" onClick={props.onDiscard}>
					<Trash2 className="size-3.5" aria-hidden="true" />
					{t("reading.noteDiscardDraft")}
				</Button>
			</div>
			<p className="max-h-16 overflow-hidden whitespace-pre-wrap break-words text-micro leading-4 text-muted-foreground">{props.draft.content}</p>
			<p className="flex items-center gap-1.5 text-micro text-muted-foreground">
				<Database className="size-3 shrink-0" aria-hidden="true" />
				{props.draft.requestId}
			</p>
			{props.draft.op === "create" && props.draft.chapterLabel !== null && (
				<p className="flex items-center gap-1.5 text-micro text-muted-foreground">
					<AlertTriangle className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
					{t("reading.noteChapterLabel", { label: props.draft.chapterLabel })}
				</p>
			)}
		</div>
	);
}
