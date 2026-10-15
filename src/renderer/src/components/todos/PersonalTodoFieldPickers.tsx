/** 待办的共享选择器：列表、新建和详情复用相同值域、选中态与键盘行为。 */
import { useRef, useState, type ReactNode } from "react";
import { Check, CheckCircle2, Circle, CircleAlert, Loader2, Minus, Search, SignalHigh, SignalLow, SignalMedium, XCircle } from "lucide-react";
import type { PersonalTodoStatus } from "../../../../shared/types/personalTodo";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";

export type PersonalTodoPickerProps<T> = {
	value: T;
	label: string;
	disabled?: boolean;
	className?: string;
	onChange: (value: T) => boolean | Promise<boolean>;
	onBegin?: () => void;
	error?: TranslationKey | null;
};
type Choice<T> = { value: T; label: string; icon: ReactNode };

/** 异步受理成功才关闭菜单；受理失败保持当前选项和错误提示，不自动重试。 */
function ChoicePicker<T extends string | number | null>(props: PersonalTodoPickerProps<T> & { options: Choice<T>[]; numberKeys?: boolean }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const selected = props.options.find((option) => option.value === props.value);
	const choose = async (option: Choice<T>) => {
		if (busyRef.current || props.disabled) return;
		if (option.value === props.value) {
			setOpen(false);
			return;
		}
		busyRef.current = true;
		setBusy(true);
		try {
			if (await props.onChange(option.value)) setOpen(false);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	return (
		<DropdownMenu
			open={open}
			onOpenChange={(value) => {
				if (value) props.onBegin?.();
				setOpen(value);
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" disabled={props.disabled || busy} aria-label={props.label} className={cn("h-8 min-w-0 justify-start gap-1.5 px-1.5 text-caption font-normal text-muted-foreground hover:bg-muted/60", props.className)}>
					{busy ? <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : selected?.icon}
					<span className="truncate">{selected?.label ?? t("personalTodo.valueUnset")}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="min-w-52 rounded-xl p-1.5 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
				onKeyDown={(event) => {
					if (!props.numberKeys || event.ctrlKey || event.metaKey || event.altKey) return;
					const index = Number(event.key) - 1;
					if (/^[1-9]$/.test(event.key) && props.options[index]) {
						event.preventDefault();
						void choose(props.options[index]).catch(() => undefined);
					}
				}}
			>
				{props.options.map((option, index) => (
					<DropdownMenuItem
						key={String(option.value)}
						role="menuitemradio"
						aria-checked={option.value === props.value}
						aria-label={option.label}
						disabled={busy || props.disabled}
						className="min-h-9 gap-2 rounded-md px-2 text-body"
						onSelect={(event) => {
							event.preventDefault();
							void choose(option).catch(() => undefined);
						}}
					>
						{option.icon}
						<span className="flex-1">{option.label}</span>
						{props.numberKeys && <kbd className="rounded border border-border px-1 text-micro text-muted-foreground">{index + 1}</kbd>}
						{option.value === props.value && <Check className="ml-1 size-3.5" />}
					</DropdownMenuItem>
				))}
				{props.error && (
					<p className="px-2 py-2 text-caption leading-5 text-danger" role="alert">
						{t(props.error)}
					</p>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** 紧急度沿用云端 0–3 与 null；这里只把数字换成可读标签，不重写旧记录。 */
export function PersonalTodoUrgencyPicker(props: PersonalTodoPickerProps<number | null>) {
	return (
		<ChoicePicker
			{...props}
			options={[
				{ value: 3, label: t("personalTodo.priorityUrgent"), icon: <CircleAlert className="size-3.5 shrink-0 text-danger" /> },
				{ value: 2, label: t("personalTodo.priorityHigh"), icon: <SignalHigh className="size-3.5 shrink-0" /> },
				{ value: 1, label: t("personalTodo.priorityMedium"), icon: <SignalMedium className="size-3.5 shrink-0" /> },
				{ value: 0, label: t("personalTodo.priorityLow"), icon: <SignalLow className="size-3.5 shrink-0 text-muted-foreground" /> },
				{ value: null, label: t("personalTodo.priorityNone"), icon: <Minus className="size-3.5 shrink-0 text-muted-foreground" /> },
			]}
		/>
	);
}

/** 只展示云端真正支持的状态，快捷键仅在本菜单内生效。 */
export function PersonalTodoStatusPicker(props: PersonalTodoPickerProps<PersonalTodoStatus>) {
	return (
		<ChoicePicker
			{...props}
			numberKeys
			options={[
				{ value: "open", label: t("personalTodo.statusOpen"), icon: <Circle className="size-3.5 shrink-0 text-muted-foreground" /> },
				{ value: "done", label: t("personalTodo.statusDone"), icon: <CheckCircle2 className="size-3.5 shrink-0 text-success" /> },
				{ value: "cancelled", label: t("personalTodo.statusCancelled"), icon: <XCircle className="size-3.5 shrink-0 text-muted-foreground" /> },
			]}
		/>
	);
}

/** 分类可从当前记录中选择，也可输入新分类；失败不清空搜索输入。 */
export function PersonalTodoCategoryPicker(props: PersonalTodoPickerProps<string | null> & { categories: readonly string[] }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const categories = [...new Set([...(props.value ? [props.value] : []), ...props.categories])].sort((a, b) => a.localeCompare(b));
	const visible = categories.filter((category) => category.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const choose = async (value: string | null) => {
		if (busyRef.current || props.disabled) return;
		if (value === props.value) {
			setOpen(false);
			return;
		}
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
					setQuery("");
				}
				setOpen(value);
			}}
		>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" disabled={props.disabled || busy} aria-label={props.label} className={cn("h-8 min-w-0 justify-start gap-2 px-1.5 text-caption font-normal text-foreground hover:bg-muted/60", props.className)}>
					{props.value && <span className="size-2 shrink-0 rounded-[3px] bg-primary/75" />}
					<span className="truncate">{props.value ?? t("personalTodo.categoryNone")}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 rounded-xl p-2 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none" aria-label={props.label}>
				<div className="relative mb-2">
					<Search className="pointer-events-none absolute top-2.5 left-2 size-3.5 text-muted-foreground" />
					<Input
						autoFocus
						className="h-9 pl-7"
						aria-label={t("personalTodo.categorySearch")}
						placeholder={t("personalTodo.categorySearch")}
						disabled={busy}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && query.trim()) {
								event.preventDefault();
								void choose(query.trim()).catch(() => undefined);
							}
						}}
					/>
				</div>
				<div className="flex max-h-52 flex-col overflow-y-auto" role="listbox" aria-label={t("personalTodo.fieldCategory")}>
					{visible.map((category) => (
						<Button key={category} type="button" variant="ghost" role="option" aria-selected={category === props.value} disabled={busy} className="h-9 shrink-0 justify-start gap-2 px-2 text-body font-normal" onClick={() => void choose(category).catch(() => undefined)}>
							<span className="size-2 shrink-0 rounded-[3px] bg-primary/75" />
							<span className="min-w-0 flex-1 truncate text-left">{category}</span>
							{category === props.value && <Check className="size-3.5" />}
						</Button>
					))}
				</div>
				{query.trim() && !categories.includes(query.trim()) && (
					<Button type="button" variant="ghost" disabled={busy} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left" onClick={() => void choose(query.trim()).catch(() => undefined)}>
						{t("personalTodo.categoryUse", { category: query.trim() })}
					</Button>
				)}
				<Button type="button" variant="ghost" className="mt-1 h-8 w-full justify-start border-t border-border/50 text-muted-foreground" disabled={busy} onClick={() => void choose(null).catch(() => undefined)}>
					<Minus className="size-3.5" />
					{t("personalTodo.categoryNone")}
				</Button>
				{props.error && (
					<p className="px-2 py-2 text-caption leading-5 text-danger" role="alert">
						{t(props.error)}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
