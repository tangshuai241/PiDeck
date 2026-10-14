/**
 * 笔记编辑器：新建（create）与按白名单段落更新（update）/追加（append）。
 *
 * 只做三件事：把用户输入放进按书/笔记作用域的 atom、按白名单选段落、按回执显示状态。
 * CAS revision 从目标笔记的 summary 取（服务端不透明 hash），界面不构造、不改写；
 * 没有 revision 时明确说明只能新建或追加，不用空 revision 去撞服务端。
 */
import { Send } from "lucide-react";
import { t } from "../../i18n";
import { READING_NOTE_SECTIONS, readingNoteHasCas, readingNoteSaveStateKey } from "../../utils/readingNotes";
import type { ReadingNotesController } from "../../hooks/useReadingNotes";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Textarea } from "../ui-shadcn/textarea";
import { ReadingHint } from "./ReadingNotices";

export function ReadingNoteEditor(props: { notes: ReadingNotesController; chapterLabel: string | null }) {
	const { notes } = props;
	const target = notes.targetSummary;
	const casMissing = target !== null && !readingNoteHasCas(target);
	// 截断全文只能看：不允许用它做「覆盖」的底稿；追加与新建不受影响
	const updateBlocked = casMissing || notes.truncatedOpen;

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-bg-panel p-2">
			<div className="flex items-center gap-2">
				<Select value={notes.input.op} onValueChange={(value) => notes.selectTarget(target?.noteId ?? null, value === "create" ? "create" : value === "update" ? "update" : "append")}>
					<SelectTrigger size="sm" className="w-[132px]" aria-label={t("reading.noteOperation")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="create">{t("reading.noteCreate")}</SelectItem>
						<SelectItem value="update" disabled={target === null || updateBlocked}>
							{t("reading.noteUpdate")}
						</SelectItem>
						<SelectItem value="append" disabled={target === null || casMissing}>
							{t("reading.noteAppend")}
						</SelectItem>
					</SelectContent>
				</Select>
				<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{target === null ? t("reading.noteTargetNew") : t("reading.noteTarget", { name: target.name })}</span>
			</div>
			{notes.input.op === "create" ? (
				<Input value={notes.input.concept} onChange={(event) => notes.setConcept(event.target.value)} placeholder={t("reading.noteConcept")} aria-label={t("reading.noteConcept")} />
			) : (
				<Select value={notes.input.section} onValueChange={(value) => notes.setSection(value)}>
					<SelectTrigger size="sm" className="w-full" aria-label={t("reading.noteSection")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{READING_NOTE_SECTIONS.map((section) => (
							<SelectItem key={section.id} value={section.id}>
								{t(section.labelKey)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<Textarea value={notes.input.content} onChange={(event) => notes.setContent(event.target.value)} rows={5} placeholder={t("reading.noteContent")} aria-label={t("reading.noteContent")} />
			{(casMissing || notes.input.op === "create") && props.chapterLabel !== null && <ReadingHint messageKey="reading.noteChapterLabel" params={{ label: props.chapterLabel }} />}
			{casMissing && <ReadingHint messageKey="reading.noteCasMissing" />}
			{notes.truncatedOpen && <ReadingHint messageKey="reading.noteTruncated" />}
			<ReadingHint messageKey="reading.noteInputKept" />
			<div className="flex items-center gap-2">
				<Button size="sm" disabled={!notes.canSubmit} onClick={() => void notes.submit()}>
					<Send className="size-3.5" aria-hidden="true" />
					{t("reading.noteSubmit")}
				</Button>
				{notes.submitState.lastState && <span className="text-micro text-muted-foreground">{t(readingNoteSaveStateKey(notes.submitState.lastState))}</span>}
			</div>
		</div>
	);
}
