/**
 * 新建待办：未选中事项时在右栏呈现。
 *
 * 规则：受理成功才清空表单；失败保留输入（含请求 id），重试不会产生第二条记录。
 * 新建不消耗模型、不触发分类器；分类与日期都是用户输入的原文。
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import type { PersonalTodoDraftFields } from "../../utils/personalTodoDraft";

const EMPTY_FIELDS: PersonalTodoDraftFields = { title: "", note: "", category: "", deadline: "", urgency: "" };

export function PersonalTodoCreateForm({ todo }: { todo: PersonalTodoController }) {
	const [fields, setFields] = useState<PersonalTodoDraftFields>(EMPTY_FIELDS);
	const [submitting, setSubmitting] = useState(false);
	const noticeKey = todo.notice?.itemId === "create" ? todo.notice.key : null;

	const update = (field: keyof PersonalTodoDraftFields, value: string) => setFields((current) => ({ ...current, [field]: value }));

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (submitting) return;
				setSubmitting(true);
				void todo
					.createItem(fields)
					.then((ok) => {
						if (ok) setFields(EMPTY_FIELDS);
					})
					.catch(() => undefined)
					.finally(() => setSubmitting(false));
			}}
		>
			<span className="text-body font-medium text-foreground">{t("personalTodo.createTitle")}</span>
			<Input className="h-8 text-body" value={fields.title} placeholder={t("personalTodo.fieldTitle")} onChange={(event) => update("title", event.target.value)} />
			<Textarea className="min-h-[96px] text-body" value={fields.note} placeholder={t("personalTodo.fieldNote")} onChange={(event) => update("note", event.target.value)} />
			<div className="flex flex-wrap gap-2">
				<Input className="h-8 min-w-[140px] flex-1 text-body" value={fields.category} placeholder={t("personalTodo.fieldCategory")} onChange={(event) => update("category", event.target.value)} />
				<Input className="h-8 min-w-[140px] flex-1 text-body" value={fields.deadline} placeholder={t("personalTodo.fieldDeadlineHint")} onChange={(event) => update("deadline", event.target.value)} />
				<Input className="h-8 w-[100px] text-body" inputMode="numeric" value={fields.urgency} placeholder={t("personalTodo.urgencyUnset")} onChange={(event) => update("urgency", event.target.value)} />
			</div>
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
