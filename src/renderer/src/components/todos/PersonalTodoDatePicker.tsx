/** 日期浮层：共享日历、快捷日期、清除和原文输入；选中日期使用本机日历键保存。 */
import { useRef, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { enUS, zhCN, zhTW } from "date-fns/locale";
import { getI18nLocale, t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { personalTodoLocalDay } from "../../utils/personalTodoPresentation";
import { personalTodoPickerDate, personalTodoQuickDate } from "../../utils/personalTodoDateSelection";
import { Button } from "../ui-shadcn/button";
import { Calendar } from "../ui-shadcn/calendar";
import { Input } from "../ui-shadcn/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import type { PersonalTodoPickerProps } from "./PersonalTodoFieldPickers";

const QUICK_DATES: { kind: "today" | "tomorrow" | "nextMonday" | "fortnight"; key: TranslationKey }[] = [
	{ kind: "today", key: "personalTodo.groupToday" },
	{ kind: "tomorrow", key: "personalTodo.dateTomorrow" },
	{ kind: "nextMonday", key: "personalTodo.dateNextMonday" },
	{ kind: "fortnight", key: "personalTodo.dateFortnight" },
];

export function PersonalTodoDatePicker(props: PersonalTodoPickerProps<string | null>) {
	const [open, setOpen] = useState(false);
	const [raw, setRaw] = useState(props.value ?? "");
	const [month, setMonth] = useState(() => personalTodoPickerDate(props.value) ?? new Date());
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const language = getI18nLocale();
	const locale = language === "zh-CN" ? zhCN : language === "zh-TW" ? zhTW : enUS;
	const choose = async (value: string | null) => {
		if (busyRef.current || props.disabled) return;
		if (value === props.value) {
			setOpen(false);
			return;
		}
		setRaw(value ?? "");
		busyRef.current = true;
		setBusy(true);
		try {
			if (await props.onChange(value)) setOpen(false);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				if (value) {
					props.onBegin?.();
					setRaw(props.value ?? "");
					setMonth(personalTodoPickerDate(props.value) ?? new Date());
				}
				setOpen(value);
			}}
		>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" disabled={props.disabled || busy} aria-label={props.label} title={props.value ?? undefined} className={cn("h-8 min-w-0 justify-start gap-1.5 px-1.5 text-caption font-normal text-muted-foreground tabular-nums hover:bg-muted/60", props.className)}>
					{busy ? <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <CalendarDays className="size-3.5 shrink-0" />}
					<span className="truncate">{props.value || t("personalTodo.dateUnset")}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto max-w-[calc(100vw-24px)] rounded-xl p-0 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none" aria-label={props.label}>
				<div className="flex max-w-80 flex-wrap gap-1 border-b border-border/60 p-3">
					{QUICK_DATES.map((entry) => (
						<Button key={entry.kind} type="button" variant="outline" size="sm" className="h-7 px-2 text-caption font-normal shadow-none" disabled={busy} onClick={() => void choose(personalTodoQuickDate(entry.kind, new Date())).catch(() => undefined)}>
							{t(entry.key)}
						</Button>
					))}
					<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-caption font-normal text-danger" disabled={busy} onClick={() => void choose(null).catch(() => undefined)}>
						{t("personalTodo.dateClear")}
					</Button>
				</div>
				<Calendar
					mode="single"
					required
					locale={locale}
					weekStartsOn={1}
					month={month}
					onMonthChange={setMonth}
					selected={personalTodoPickerDate(raw)}
					onSelect={(date) => {
						if (date) void choose(personalTodoLocalDay(date)).catch(() => undefined);
					}}
					disabled={busy}
					labels={{ labelPrevious: () => t("personalTodo.previousMonth"), labelNext: () => t("personalTodo.nextMonth") }}
					className="mx-auto w-[300px] max-w-full p-3"
					classNames={{
						months: "relative flex w-full flex-col",
						month: "flex w-full flex-col gap-2",
						nav: "absolute inset-x-0 top-0 flex h-9 w-full items-center justify-between",
						button_previous: "size-8 p-0",
						button_next: "size-8 p-0",
						month_caption: "flex h-9 items-center justify-center px-10",
						month_grid: "w-full table-fixed border-collapse",
						weekdays: "table-row",
						weekday: "h-8 text-center text-caption font-normal text-muted-foreground",
						week: "table-row",
						day: "h-10 w-[14.2857%] p-0 text-center align-middle",
						day_button: "mx-auto size-9 min-w-9 rounded-md",
					}}
				/>
				<div className="flex max-w-80 items-center gap-2 border-t border-border/60 p-3">
					<Input
						className="h-8 min-w-0 flex-1 text-caption"
						value={raw}
						disabled={busy}
						aria-label={t("personalTodo.dateOriginal")}
						placeholder={t("personalTodo.dateFormat")}
						onChange={(event) => setRaw(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void choose(raw.trim() || null).catch(() => undefined);
							}
						}}
					/>
					<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void choose(raw.trim() || null).catch(() => undefined)}>
						{t("personalTodo.apply")}
					</Button>
				</div>
				{props.error && (
					<p className="max-w-80 px-3 pb-3 text-caption leading-5 text-danger" role="alert">
						{t(props.error)}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
