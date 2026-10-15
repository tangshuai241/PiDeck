/** 列表与详情共用的子待办新增入口，Enter 提交，不自动完成父项。 */
import { Plus } from "lucide-react";
import type { PersonalTodoView } from "../../../../shared/types/personalTodo";
import type { PersonalTodoController } from "../../hooks/usePersonalTodo";
import { usePersonalTodoSubtodoComposer } from "../../hooks/usePersonalTodoSubtodoForm";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

export function PersonalTodoSubtodoQuickAdd({ todo, view, className }: { todo: PersonalTodoController; view: PersonalTodoView; className?: string }) {
	const form = usePersonalTodoSubtodoComposer(todo, view);
	return (
		<form
			className={cn("flex items-center gap-2", className)}
			onSubmit={(event) => {
				event.preventDefault();
				void form.submit().catch(() => undefined);
			}}
		>
			<Input className="h-8 min-w-0 flex-1 text-caption" aria-label={t("personalTodo.subtodoPlaceholder")} value={form.text} placeholder={t("personalTodo.subtodoPlaceholder")} onChange={(event) => form.setText(event.target.value)} />
			<Button type="submit" variant="ghost" size="sm" className="shrink-0" disabled={!form.text.trim() || form.saving || todo.pendingIds.includes(view.item.id)}>
				<Plus className="size-3.5" />
				{t("personalTodo.subtodoAdd")}
			</Button>
		</form>
	);
}
