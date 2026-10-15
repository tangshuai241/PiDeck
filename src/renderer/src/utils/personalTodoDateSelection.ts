/** 日期选择器的日历换算：只转换已验证的日期，不把历史原文当时间戳解析。 */
import { personalTodoCalendarDate, personalTodoLocalDay } from "./personalTodoPresentation";

/** Calendar 需要本机 Date；用 setFullYear 避免 00–99 年被 JS 自动变成 1900 年。 */
export function personalTodoPickerDate(value: string | null): Date | undefined {
	const valid = personalTodoCalendarDate(value);
	if (!valid) return undefined;
	const [year, month, day] = valid.split("-").map(Number);
	const date = new Date(0);
	date.setFullYear(year, month - 1, day);
	date.setHours(12, 0, 0, 0);
	return date;
}

/** 相对日期用日历天计算，跨月、跨年和夏令时都不按 24h 毫秒数硬加。 */
export function personalTodoQuickDate(kind: "today" | "tomorrow" | "nextMonday" | "fortnight", now: Date): string {
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
	const offset = kind === "today" ? 0 : kind === "tomorrow" ? 1 : kind === "fortnight" ? 14 : (8 - date.getDay()) % 7 || 7;
	date.setDate(date.getDate() + offset);
	return personalTodoLocalDay(date);
}
