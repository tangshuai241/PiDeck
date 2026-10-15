/** 待办的展示策略：只给已加载记录分组，不改写日期、身份或云端查询规则。 */
import type { PersonalTodoView } from "../../../shared/types/personalTodo";

export const PERSONAL_TODO_GROUPS = ["overdue", "today", "upcoming", "undated", "completed", "cancelled"] as const;
export type PersonalTodoGroupId = (typeof PERSONAL_TODO_GROUPS)[number];
export type PersonalTodoGroup = { id: PersonalTodoGroupId; items: PersonalTodoView[] };
export type PersonalTodoDisplayOrder = "source" | "deadline" | "urgency";

/** 只认明确且有效的日历日期；历史自然语言与带时区的原文继续原样展示。 */
export function personalTodoCalendarDate(value: string | null): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split("-").map(Number);
	if (year < 1 || month < 1 || month > 12 || day < 1) return null;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= days[month - 1] ? value : null;
}

/** 本机的今天仅用于界面归组；不把云端 deadline 转成时间戳。 */
export function personalTodoLocalDay(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 取消与完成先于日期分组，避免历史事项被重新算成逾期待办。 */
export function personalTodoGroupId(view: PersonalTodoView, today: string): PersonalTodoGroupId {
	if (view.item.status === "done") return "completed";
	if (view.item.status === "cancelled") return "cancelled";
	const day = personalTodoCalendarDate(view.item.deadline);
	if (!day) return "undated";
	return day < today ? "overdue" : day === today ? "today" : "upcoming";
}

/** 展示排序只作用于已加载窗口；稳定排序保留同值条目的服务端先后顺序。 */
export function groupPersonalTodos(items: readonly PersonalTodoView[], today: string, order: PersonalTodoDisplayOrder = "source"): PersonalTodoGroup[] {
	const groups: PersonalTodoGroup[] = PERSONAL_TODO_GROUPS.map((id) => ({ id, items: [] }));
	for (const view of items) groups.find((group) => group.id === personalTodoGroupId(view, today))?.items.push(view);
	if (order !== "source") {
		for (const group of groups) {
			group.items.sort((left, right) => {
				if (order === "urgency") return (right.item.urgency ?? -1) - (left.item.urgency ?? -1);
				const a = personalTodoCalendarDate(left.item.deadline);
				const b = personalTodoCalendarDate(right.item.deadline);
				if (a === b) return 0;
				if (a === null) return 1;
				if (b === null) return -1;
				return a < b ? -1 : 1;
			});
		}
	}
	return groups;
}

/** 月视图按本机日历生成整周网格；日期生成不触碰记录的原始字符串。 */
export function personalTodoMonthDays(month: Date): { day: string; inMonth: boolean }[] {
	const first = new Date(month.getFullYear(), month.getMonth(), 1);
	const count = Math.ceil((first.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
	return Array.from({ length: count }, (_, index) => {
		const date = new Date(first.getFullYear(), first.getMonth(), index - first.getDay() + 1);
		return { day: personalTodoLocalDay(date), inMonth: date.getMonth() === month.getMonth() };
	});
}
