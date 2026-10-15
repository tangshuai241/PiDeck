/** 新建与详情编辑的字段缓冲共用选择器；这里选择只改草稿，提交仍由原表单负责。 */
import type { PersonalTodoDraftFields } from "../../utils/personalTodoDraft";
import { t } from "../../i18n";
import { PersonalTodoCategoryPicker, PersonalTodoUrgencyPicker } from "./PersonalTodoFieldPickers";
import { PersonalTodoDatePicker } from "./PersonalTodoDatePicker";

export function PersonalTodoDraftPickers(props: { fields: PersonalTodoDraftFields; onChange: (field: keyof PersonalTodoDraftFields, value: string) => void; categories: readonly string[]; disabled?: boolean }) {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			<label className="flex min-w-0 flex-col gap-1.5 text-caption text-muted-foreground">
				{t("personalTodo.fieldCategory")}
				<PersonalTodoCategoryPicker
					className="h-9 w-full border border-input px-2"
					label={t("personalTodo.fieldCategory")}
					categories={props.categories}
					value={props.fields.category || null}
					disabled={props.disabled}
					onChange={(value) => {
						props.onChange("category", value ?? "");
						return true;
					}}
				/>
			</label>
			<label className="flex min-w-0 flex-col gap-1.5 text-caption text-muted-foreground">
				{t("personalTodo.fieldDeadline")}
				<PersonalTodoDatePicker
					className="h-9 w-full border border-input px-2"
					label={t("personalTodo.fieldDeadline")}
					value={props.fields.deadline || null}
					disabled={props.disabled}
					onChange={(value) => {
						props.onChange("deadline", value ?? "");
						return true;
					}}
				/>
			</label>
			<label className="flex min-w-0 flex-col gap-1.5 text-caption text-muted-foreground">
				{t("personalTodo.fieldUrgency")}
				<PersonalTodoUrgencyPicker
					className="h-9 w-full border border-input px-2"
					label={t("personalTodo.fieldUrgency")}
					value={props.fields.urgency === "" ? null : Number(props.fields.urgency)}
					disabled={props.disabled}
					onChange={(value) => {
						props.onChange("urgency", value === null ? "" : String(value));
						return true;
					}}
				/>
			</label>
		</div>
	);
}
