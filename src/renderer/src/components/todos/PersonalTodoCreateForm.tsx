/**
 * 新建待办抽屉的受控表单，输入与提交生命周期由页面 hook 持有。
 *
 * 规则：关闭抽屉保留输入；受理成功只清理本次提交的草稿，不覆盖后来输入。
 * 新建不消耗模型、不触发分类器；分类与日期都是用户输入的原文。
 */
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import type { PersonalTodoDraftFields } from "../../utils/personalTodoDraft";
import { PersonalTodoDraftPickers } from "./PersonalTodoDraftPickers";

export function PersonalTodoCreateForm({ todo, fields, onFieldsChange, submitting, onSubmit }: { todo: PersonalTodoController; fields: PersonalTodoDraftFields; onFieldsChange: (fields: PersonalTodoDraftFields) => void; submitting: boolean; onSubmit: () => Promise<void> }) {
	const noticeKey = todo.notice?.itemId === "create" ? todo.notice.key : null;

	const update = (field: keyof PersonalTodoDraftFields, value: string) => onFieldsChange({ ...fields, [field]: value });

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit().catch(() => undefined);
			}}
		>
			<Input className="h-12 border-0 px-0 text-xl font-semibold shadow-none focus-visible:ring-0" value={fields.title} aria-label={t("personalTodo.fieldTitle")} placeholder={t("personalTodo.fieldTitle")} onChange={(event) => update("title", event.target.value)} />
			<Textarea className="min-h-[160px] text-body" value={fields.note} aria-label={t("personalTodo.fieldNote")} placeholder={t("personalTodo.fieldNote")} onChange={(event) => update("note", event.target.value)} />
			<PersonalTodoDraftPickers fields={fields} onChange={update} categories={todo.items.flatMap((view) => (view.item.category ? [view.item.category] : []))} disabled={submitting} />
			{noticeKey && <p className="text-micro text-danger">{t(noticeKey)}</p>}
			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={submitting || !fields.title.trim()}>
					<Plus className="size-3.5" aria-hidden="true" />
					{t("personalTodo.create")}
				</Button>
				<span className="text-micro text-muted-foreground">{t("personalTodo.createHint")}</span>
			</div>
		</form>
	);
}
