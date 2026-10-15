/**
 * 待办详情与编辑：字段表单、子待办、关联任务（只读）、冲突与重试入口。
 *
 * 规则：
 * - 表单缓冲由 hook 按「账号 + 事项」持有；提交失败或冲突时缓冲保留，只有受理成功才清；
 * - 冲突并列显示本人草稿与云端版本，由用户选择保留哪一份，不自动覆盖；
 * - 关联任务是只读展示（首版），悬挂 id 保留并标注缺失，不静默删除；
 * - 长备注完整读写，不在界面上截断。
 */
import { useState } from "react";
import { ListTree, Link2, MessagesSquare, RotateCcw, Save, Undo2 } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import type { PersonalTodoSubtask, PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { personalTodoErrorInfoKey, personalTodoLinkedTaskKey, personalTodoStatusKey, personalTodoSyncBadge, personalTodoWriteNoticeKey } from "../../utils/personalTodoState";
import { PersonalTodoConflictPanel } from "./PersonalTodoConflictPanel";
import { TodoMaterialEntry, TodoMaterialPanel } from "./TodoMaterialEntry";
import { PersonalTodoDraftPickers } from "./PersonalTodoDraftPickers";
import { PersonalTodoInlineFields } from "./PersonalTodoInlineFields";
import { PersonalTodoSubtodoQuickAdd } from "./PersonalTodoSubtodoQuickAdd";
import { usePersonalTodoSubtodoEditor } from "../../hooks/usePersonalTodoSubtodoForm";
import { personalTodoLocalDay } from "../../utils/personalTodoPresentation";

export function PersonalTodoDetail({ todo, view, projectId }: { todo: PersonalTodoController; view: PersonalTodoView; projectId?: string }) {
	const item = view.item;
	const badge = personalTodoSyncBadge(view.sync.phase);
	const editing = todo.draft !== null;
	const pending = todo.pendingIds.includes(item.id);
	const errorKey = todo.draft?.lastError ? personalTodoErrorInfoKey(todo.draft.lastError) : personalTodoErrorInfoKey(view.sync.lastError);
	const writeNoticeKey = personalTodoWriteNoticeKey(todo.write);
	const conflicted = view.sync.phase === "conflict" && view.confirmed !== null;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
			<header className="flex shrink-0 flex-wrap items-center gap-2">
				<span className="rounded-sm border border-border/60 px-1 text-micro text-muted-foreground">{t(personalTodoStatusKey(item.status))}</span>
				<span className={cn("rounded-sm border px-1 text-micro", badge.tone === "danger" ? "border-danger/50 text-danger" : badge.tone === "warning" ? "border-warning/50 text-warning" : "border-border/60 text-muted-foreground")}>{t(badge.key)}</span>
				{view.sync.pendingCount > 1 && <span className="text-micro text-muted-foreground">{t("personalTodo.pendingCount", { count: view.sync.pendingCount })}</span>}
				<span className="min-w-0 flex-1" />
				<TodoMaterialEntry view={view} projectId={projectId} />
				<Button variant="ghost" size="sm" className="shrink-0" disabled={pending} onClick={() => void todo.toggleStatus(view)}>
					{t(item.status === "done" ? "personalTodo.toggleReopen" : "personalTodo.toggleDone")}
				</Button>
				{!editing && (
					<Button variant="ghost" size="sm" className="shrink-0" onClick={() => todo.beginEdit(view)}>
						{t("personalTodo.edit")}
					</Button>
				)}
			</header>

			{(errorKey || writeNoticeKey || (conflicted && todo.write?.available === false)) && (
				<div className="flex shrink-0 flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-caption">
					{errorKey && <span className="text-danger">{t(errorKey)}</span>}
					{writeNoticeKey && <span className="text-muted-foreground">{t(writeNoticeKey, todo.write?.reason ? { reason: todo.write.reason } : undefined)}</span>}
				</div>
			)}

			{conflicted ? <PersonalTodoConflictPanel todo={todo} view={view} /> : null}

			{editing && todo.draft ? (
				<div className="flex shrink-0 flex-col gap-2">
					<Field labelKey="personalTodo.fieldTitle">
						<Input className="h-8 text-body" value={todo.draft.fields.title} onChange={(event) => todo.updateDraftField("title", event.target.value)} />
					</Field>
					<Field labelKey="personalTodo.fieldNote">
						{/* 长备注完整读写：不设 maxLength、不做截断 */}
						<Textarea className="min-h-[96px] text-body" value={todo.draft.fields.note} onChange={(event) => todo.updateDraftField("note", event.target.value)} />
					</Field>
					<PersonalTodoDraftPickers fields={todo.draft.fields} onChange={todo.updateDraftField} categories={todo.items.flatMap((entry) => (entry.item.category ? [entry.item.category] : []))} disabled={pending} />
					<div className="flex items-center gap-2">
						<Button size="sm" disabled={pending || !todo.draft.dirty} onClick={() => void todo.saveDraft()}>
							<Save className="size-3.5" aria-hidden="true" />
							{t("personalTodo.save")}
						</Button>
						<Button variant="ghost" size="sm" disabled={pending} onClick={todo.discardDraft}>
							<Undo2 className="size-3.5" aria-hidden="true" />
							{t("personalTodo.discard")}
						</Button>
						{todo.draft.dirty && <span className="text-micro text-muted-foreground">{t("personalTodo.dirty")}</span>}
					</div>
				</div>
			) : (
				<div className="flex shrink-0 flex-col gap-6">
					<h2 className="text-2xl leading-8 font-semibold break-words text-foreground">{item.title}</h2>
					<div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg bg-muted/20 p-4">
						<PersonalTodoInlineFields todo={todo} view={view} today={personalTodoLocalDay(new Date())} showLabels />
					</div>
					<ReadonlyField labelKey="personalTodo.fieldNote" value={item.note} multiline />
				</div>
			)}

			<PersonalTodoSubtodos todo={todo} view={view} projectId={projectId} />

			{view.linkedTasks.length > 0 && (
				<section className="flex shrink-0 flex-col gap-1 rounded-lg border border-border/50 px-3 py-2">
					<div className="flex items-center gap-2 text-caption text-muted-foreground">
						<Link2 className="size-3.5" aria-hidden="true" />
						<span className="text-body text-foreground">{t("personalTodo.linkedTasks")}</span>
						<span className="text-micro">{t("personalTodo.linkedTasksReadOnly")}</span>
					</div>
					<ul className="flex flex-col gap-0.5">
						{view.linkedTasks.map((task) => (
							<li key={task.id} className={cn("text-caption", task.available === true ? "text-muted-foreground" : "text-warning")}>
								{t(personalTodoLinkedTaskKey(task), { id: task.id })}
							</li>
						))}
					</ul>
				</section>
			)}

			{view.sync.phase === "unknown" || view.sync.phase === "error" ? (
				<Button variant="outline" size="sm" className="shrink-0 self-start" disabled={pending} onClick={() => void todo.retryItem(item.id)}>
					<RotateCcw className="size-3.5" aria-hidden="true" />
					{t("personalTodo.retry")}
				</Button>
			) : null}
		</div>
	);
}

/** 一层子待办：新增、编辑文本、完成/重开；子项状态不影响父项。 */
export function PersonalTodoSubtodos({ todo, view, projectId }: { todo: PersonalTodoController; view: PersonalTodoView; projectId?: string }) {
	const editor = usePersonalTodoSubtodoEditor(todo, view);
	/** P04：当前要从哪个子项带入材料（null=未打开）与带入结果提示。 */
	const [materialSubtodoId, setMaterialSubtodoId] = useState<string | null>(null);
	const [materialNotice, setMaterialNotice] = useState<"brought" | "duplicate" | null>(null);
	const subtodos = view.item.subtodos;

	return (
		<section className="flex shrink-0 flex-col gap-2 rounded-lg border border-border/50 px-3 py-2">
			<div className="flex items-center gap-2 text-body text-foreground">
				<ListTree className="size-3.5 text-muted-foreground" aria-hidden="true" />
				{t("personalTodo.subtodos")}
			</div>
			{subtodos.length === 0 ? (
				<p className="text-caption text-muted-foreground">{t("personalTodo.subtodoEmpty")}</p>
			) : (
				<ul className="flex flex-col gap-1">
					{subtodos.map((subtodo) => (
						<SubtodoRow
							key={subtodo.id}
							subtodo={subtodo}
							editing={editor.draft?.id === subtodo.id}
							editingText={editor.draft?.text ?? ""}
							editingNote={editor.draft?.note ?? ""}
							saving={editor.saving}
							onEditingText={(value) => editor.change("text", value)}
							onEditingNote={(value) => editor.change("note", value)}
							onStartEdit={() => editor.start(subtodo)}
							onCancelEdit={editor.cancel}
							onSaveEdit={() => void editor.save().catch(() => undefined)}
							onToggle={() => void todo.toggleSubtodo(view, subtodo.id, subtodo.status === "done" ? "open" : "done")}
							onBringToSession={() => {
								setMaterialSubtodoId((current) => (current === subtodo.id ? null : subtodo.id));
								setMaterialNotice(null);
							}}
						/>
					))}
				</ul>
			)}
			{materialSubtodoId && (
				<div className="flex flex-col gap-1">
					<TodoMaterialPanel
						view={view}
						subtodoId={materialSubtodoId}
						projectId={projectId}
						onDone={(duplicate) => {
							setMaterialSubtodoId(null);
							setMaterialNotice(duplicate ? "duplicate" : "brought");
						}}
						onCancel={() => setMaterialSubtodoId(null)}
					/>
				</div>
			)}
			{materialNotice && <p className="text-micro text-muted-foreground">{t(materialNotice === "duplicate" ? "workbenchMaterial.noticeDuplicate" : "workbenchMaterial.noticeBrought")}</p>}
			{todo.notice?.itemId === view.item.id && (
				<p className="text-caption text-warning" role="alert">
					{t(todo.notice.key)}
				</p>
			)}
			<PersonalTodoSubtodoQuickAdd todo={todo} view={view} />
		</section>
	);
}

function SubtodoRow(props: {
	subtodo: PersonalTodoSubtask;
	editing: boolean;
	editingText: string;
	editingNote: string;
	saving: boolean;
	onEditingText: (value: string) => void;
	onEditingNote: (value: string) => void;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSaveEdit: () => void;
	onToggle: () => void;
	onBringToSession: () => void;
}) {
	const { subtodo } = props;
	if (props.editing) {
		return (
			<li className="flex flex-col gap-2 rounded-md bg-muted/20 p-2">
				<Input
					autoFocus
					className="h-8 min-w-0 text-caption"
					aria-label={t("personalTodo.subtodoEditTitle")}
					value={props.editingText}
					disabled={props.saving}
					onChange={(event) => props.onEditingText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							props.onSaveEdit();
						}
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							props.onCancelEdit();
						}
					}}
				/>
				<Textarea className="min-h-16 text-caption" aria-label={t("personalTodo.subtodoEditNote")} placeholder={t("personalTodo.subtodoEditNote")} value={props.editingNote} disabled={props.saving} onChange={(event) => props.onEditingNote(event.target.value)} />
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" disabled={props.saving || !props.editingText.trim()} onClick={props.onSaveEdit}>
						{t("personalTodo.save")}
					</Button>
					<Button variant="ghost" size="sm" disabled={props.saving} onClick={props.onCancelEdit}>
						{t("personalTodo.cancel")}
					</Button>
				</div>
			</li>
		);
	}
	return (
		<li className="flex items-center gap-2">
			<Button variant="ghost" size="icon" className="size-6 shrink-0" title={t(subtodo.status === "done" ? "personalTodo.toggleReopen" : "personalTodo.toggleDone")} onClick={props.onToggle}>
				<span className={cn("size-3 rounded-full border", subtodo.status === "done" ? "border-success bg-success" : "border-border-strong")} aria-hidden="true" />
				<span className="sr-only">{t(personalTodoStatusKey(subtodo.status))}</span>
			</Button>
			<div className="min-w-0 flex-1">
				<button type="button" disabled={props.saving} className={cn("max-w-full truncate text-left text-caption text-foreground", subtodo.status !== "open" && "line-through text-muted-foreground")} onClick={props.onStartEdit}>
					{subtodo.text}
				</button>
				{subtodo.note && <p className="mt-1 text-caption whitespace-pre-wrap break-words text-muted-foreground">{subtodo.note}</p>}
			</div>
			{subtodo.assignee && <span className="shrink-0 text-micro text-muted-foreground">{subtodo.assignee}</span>}
			<Button variant="ghost" size="icon" className="size-6 shrink-0" title={t("workbenchMaterial.bringToSession")} onClick={props.onBringToSession}>
				<MessagesSquare className="size-3" aria-hidden="true" />
				<span className="sr-only">{t("workbenchMaterial.bringToSession")}</span>
			</Button>
		</li>
	);
}

function Field(props: { labelKey: Parameters<typeof t>[0]; className?: string; children: React.ReactNode }) {
	return (
		<label className={cn("flex flex-col gap-1", props.className)}>
			<span className="text-micro text-muted-foreground">{t(props.labelKey)}</span>
			{props.children}
		</label>
	);
}

function ReadonlyField(props: { labelKey: Parameters<typeof t>[0]; value: string; multiline?: boolean }) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<span className="text-caption text-muted-foreground">{t(props.labelKey)}</span>
			{props.multiline ? <p className="text-body leading-6 whitespace-pre-wrap break-words text-foreground">{props.value || t("personalTodo.valueUnset")}</p> : <p className="break-words text-body text-foreground">{props.value}</p>}
		</div>
	);
}
