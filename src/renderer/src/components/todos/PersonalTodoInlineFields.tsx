/** 同一组行内字段在列表与详情展示态共用；浮层打开时固定事项与 revision。 */
import { useRef } from "react";
import type { PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { personalTodoCalendarDate } from "../../utils/personalTodoPresentation";
import { PersonalTodoCategoryPicker, PersonalTodoStatusPicker, PersonalTodoUrgencyPicker } from "./PersonalTodoFieldPickers";
import { PersonalTodoDatePicker } from "./PersonalTodoDatePicker";

export function PersonalTodoInlineFields({ todo, view, today, showLabels = false }: { todo: PersonalTodoController; view: PersonalTodoView; today: string; showLabels?: boolean }) {
	const snapshot = useRef(view);
	const begin = () => {
		snapshot.current = view;
		todo.dismissNotice();
	};
	const item = view.item;
	const disabled = todo.pendingIds.includes(item.id);
	const error = todo.notice?.itemId === item.id ? todo.notice.key : null;
	const categories = todo.items.flatMap((entry) => (entry.item.category ? [entry.item.category] : []));
	const day = personalTodoCalendarDate(item.deadline);
	return (
		<>
			<div className="min-w-0">
				{showLabels && <p className="mb-1 text-caption text-muted-foreground">{t("personalTodo.fieldCategory")}</p>}
				<PersonalTodoCategoryPicker label={t("personalTodo.changeCategory", { title: item.title })} value={item.category} categories={categories} disabled={disabled} error={error} onBegin={begin} onChange={(category) => todo.patchInline(snapshot.current, { category })} className="w-full" />
			</div>
			<div className="min-w-0">
				{showLabels && <p className="mb-1 text-caption text-muted-foreground">{t("personalTodo.filterStatus")}</p>}
				<PersonalTodoStatusPicker label={t("personalTodo.changeStatus", { title: item.title })} value={item.status} disabled={disabled} error={error} onBegin={begin} onChange={(status) => todo.setInlineStatus(snapshot.current, status)} className={cn("w-full", item.status === "done" && "text-success")} />
			</div>
			<div className="min-w-0">
				{showLabels && <p className="mb-1 text-caption text-muted-foreground">{t("personalTodo.fieldUrgency")}</p>}
				<PersonalTodoUrgencyPicker label={t("personalTodo.changeUrgency", { title: item.title })} value={item.urgency} disabled={disabled} error={error} onBegin={begin} onChange={(urgency) => todo.patchInline(snapshot.current, { urgency })} className={cn("w-full", item.urgency === 3 && "text-danger")} />
			</div>
			<div className="min-w-0">
				{showLabels && <p className="mb-1 text-caption text-muted-foreground">{t("personalTodo.fieldDeadline")}</p>}
				<PersonalTodoDatePicker
					label={t("personalTodo.changeDeadline", { title: item.title })}
					value={item.deadline}
					disabled={disabled}
					error={error}
					onBegin={begin}
					onChange={(deadline) => todo.patchInline(snapshot.current, { deadline })}
					className={cn("w-full", item.status === "open" && day !== null && day < today && "text-danger")}
				/>
			</div>
		</>
	);
}
