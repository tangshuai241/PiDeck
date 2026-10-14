/**
 * 冲突面板：并列显示本人草稿与云端版本，由用户选择保留哪一份。
 *
 * 规则（任务规则：冲突显示本人草稿与云端版本、不自动覆盖）：
 * - 两份内容都来自契约视图（`draft` / `confirmed`），界面不自行合并、不挑一份覆盖另一份；
 * - `keepMine` 由主进程以云端最新 revision 重放草稿，`takeCloud` 丢弃草稿；
 * - 选择前不隐藏任一方的差异字段，用户能看清自己改了什么、云端改了什么。
 */
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import type { PersonalTodo, PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";

const COMPARE_FIELDS: { labelKey: Parameters<typeof t>[0]; read: (item: PersonalTodo) => string }[] = [
	{ labelKey: "personalTodo.fieldTitle", read: (item) => item.title },
	{ labelKey: "personalTodo.fieldNote", read: (item) => item.note },
	{ labelKey: "personalTodo.fieldCategory", read: (item) => item.category ?? "" },
	{ labelKey: "personalTodo.fieldDeadline", read: (item) => item.deadline ?? "" },
	{ labelKey: "personalTodo.fieldUrgency", read: (item) => (item.urgency === null ? "" : String(item.urgency)) },
];

export function PersonalTodoConflictPanel({ todo, view }: { todo: PersonalTodoController; view: PersonalTodoView }) {
	const mine = view.draft;
	const cloud = view.confirmed;
	if (!mine || !cloud) return null;
	const pending = todo.pendingIds.includes(view.item.id);

	return (
		<section className="flex shrink-0 flex-col gap-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2">
			<div className="flex flex-col gap-0.5">
				<span className="text-body font-medium text-foreground">{t("personalTodo.conflictTitle")}</span>
				<span className="text-micro text-muted-foreground">{t("personalTodo.conflictBody")}</span>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<ConflictSide titleKey="personalTodo.conflictMine" item={mine} other={cloud} />
				<ConflictSide titleKey="personalTodo.conflictCloud" item={cloud} other={mine} />
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={pending} onClick={() => void todo.resolveConflict(view.item.id, "keepMine")}>
					{t("personalTodo.conflictKeepMine")}
				</Button>
				<Button variant="outline" size="sm" disabled={pending} onClick={() => void todo.resolveConflict(view.item.id, "takeCloud")}>
					{t("personalTodo.conflictTakeCloud")}
				</Button>
			</div>
		</section>
	);
}

function ConflictSide(props: { titleKey: Parameters<typeof t>[0]; item: PersonalTodo; other: PersonalTodo }) {
	return (
		<div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/50 bg-bg-panel px-2 py-1.5">
			<span className="text-caption font-medium text-foreground">{t(props.titleKey)}</span>
			{COMPARE_FIELDS.map((field) => {
				const value = field.read(props.item);
				const differs = value !== field.read(props.other);
				return (
					<div key={field.labelKey} className="flex min-w-0 flex-col">
						<span className="text-micro text-muted-foreground">{t(field.labelKey)}</span>
						<span className={differs ? "text-caption whitespace-pre-wrap break-words text-warning" : "text-caption whitespace-pre-wrap break-words text-foreground"}>{value || t("personalTodo.valueUnset")}</span>
					</div>
				);
			})}
		</div>
	);
}
