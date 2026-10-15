/** 待办页呈现状态的单一 owner；正式数据和写操作仍由 usePersonalTodo 持有。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { PersonalTodoController } from "./usePersonalTodo";
import type { PersonalTodoView } from "../../../shared/types/personalTodo";
import type { PersonalTodoDraftFields } from "../utils/personalTodoDraft";
import { groupPersonalTodos, personalTodoLocalDay, type PersonalTodoDisplayOrder, type PersonalTodoGroupId } from "../utils/personalTodoPresentation";

export const EMPTY_TODO_FIELDS: PersonalTodoDraftFields = { title: "", note: "", category: "", deadline: "", urgency: "" };

/** 页面按账号加 key 挂载此 hook，输入不会从一个账号流入另一个账号。 */
export function usePersonalTodoWorkspace(todo: PersonalTodoController) {
	const reduce = useReducedMotion();
	const [today, setToday] = useState(() => personalTodoLocalDay(new Date()));
	const [mode, setMode] = useState<"list" | "calendar">("list");
	const [order, setOrder] = useState<PersonalTodoDisplayOrder>("source");
	const [creating, setCreating] = useState(false);
	const [fields, setFields] = useState<PersonalTodoDraftFields>(EMPTY_TODO_FIELDS);
	const fieldsRef = useRef(fields);
	fieldsRef.current = fields;
	const [quickGroup, setQuickGroup] = useState<PersonalTodoGroupId | null>(null);
	const [quickTitles, setQuickTitles] = useState<Partial<Record<PersonalTodoGroupId, string>>>({});
	const [quickSaving, setQuickSaving] = useState(false);
	const [createSaving, setCreateSaving] = useState(false);
	const [openGroups, setOpenGroups] = useState<Record<PersonalTodoGroupId, boolean>>({ overdue: true, today: true, upcoming: true, undated: true, completed: false, cancelled: false });
	const [completionHolds, setCompletionHolds] = useState<Record<string, { group: PersonalTodoGroupId; index: number }>>({});
	const openerRef = useRef<HTMLElement | null>(null);
	const savingRef = useRef(false);
	const createSavingRef = useRef(false);
	const panelEpochRef = useRef(0);
	const aliveRef = useRef(true);
	const feedbackTimersRef = useRef(new Set<number>());
	const groups = useMemo(() => {
		const grouped = groupPersonalTodos(todo.items, today, order);
		// 已受理的完成操作先在原行播放勾选反馈，再移到折叠的完成组；不提前伪造完成状态。
		for (const [id, hold] of Object.entries(completionHolds)) {
			const completed = grouped.find((group) => group.id === "completed");
			const index = completed?.items.findIndex((view) => view.item.id === id) ?? -1;
			const origin = grouped.find((group) => group.id === hold.group);
			if (index >= 0 && completed && origin && origin !== completed) origin.items.splice(hold.index, 0, ...completed.items.splice(index, 1));
		}
		return grouped;
	}, [todo.items, today, order, completionHolds]);

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			for (const timer of feedbackTimersRef.current) window.clearTimeout(timer);
			feedbackTimersRef.current.clear();
		};
	}, []);

	useEffect(() => {
		let timer: number;
		const update = () => {
			window.clearTimeout(timer);
			const now = new Date();
			setToday(personalTodoLocalDay(now));
			const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
			timer = window.setTimeout(update, midnight.getTime() - now.getTime() + 50);
		};
		const resume = () => {
			if (!document.hidden) update();
		};
		update();
		document.addEventListener("visibilitychange", resume);
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", resume);
		};
	}, []);

	/** 对话框关闭后将焦点交回原来的行或新建按钮，避免落到隐藏的聊天输入框。 */
	const rememberOpener = () => {
		openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	};
	const openItem = (id: string) => {
		panelEpochRef.current++;
		rememberOpener();
		setCreating(false);
		todo.select(id);
	};
	const openCreate = (day?: string) => {
		panelEpochRef.current++;
		rememberOpener();
		// 已有未提交输入时继续原草稿；日历点选不覆盖用户写过的日期。
		setFields((current) => (Object.values(current).some(Boolean) ? current : { ...EMPTY_TODO_FIELDS, deadline: day ?? "" }));
		todo.select(null);
		setCreating(true);
	};
	const closePanel = () => {
		panelEpochRef.current++;
		setCreating(false);
		todo.select(null);
	};
	/** 关闭或换事项后到达的创建结果只结算原草稿，不关闭后来打开的详情。 */
	const submitCreate = async () => {
		if (createSavingRef.current) return;
		createSavingRef.current = true;
		setCreateSaving(true);
		const epoch = panelEpochRef.current;
		const submitted = fields;
		try {
			const ok = await todo.createItem(submitted);
			if (!aliveRef.current || !ok) return;
			setFields((current) => (current === submitted ? EMPTY_TODO_FIELDS : current));
			if (epoch === panelEpochRef.current && fieldsRef.current === submitted) closePanel();
		} finally {
			createSavingRef.current = false;
			if (aliveRef.current) setCreateSaving(false);
		}
	};
	/** 一次点击只产生一次原有状态操作；450ms 仅影响归组的呈现时间。 */
	const toggleStatus = async (view: PersonalTodoView) => {
		if (view.item.status === "open") {
			const group = groups.find((entry) => entry.items.some((item) => item.item.id === view.item.id));
			if (group) setCompletionHolds((current) => ({ ...current, [view.item.id]: { group: group.id, index: group.items.findIndex((item) => item.item.id === view.item.id) } }));
		}
		try {
			await todo.toggleStatus(view);
		} finally {
			if (aliveRef.current) {
				const timer = window.setTimeout(
					() => {
						feedbackTimersRef.current.delete(timer);
						setCompletionHolds((current) => {
							const next = { ...current };
							delete next[view.item.id];
							return next;
						});
					},
					reduce ? 0 : 450,
				);
				feedbackTimersRef.current.add(timer);
			}
		}
	};
	const submitQuick = async (group: PersonalTodoGroupId) => {
		const title = quickTitles[group]?.trim();
		if (!title || savingRef.current) return;
		savingRef.current = true;
		setQuickSaving(true);
		try {
			const ok = await todo.createItem({ ...EMPTY_TODO_FIELDS, title, deadline: group === "today" ? today : "", category: todo.query.category ?? "" });
			if (ok) {
				setQuickTitles((current) => ({ ...current, [group]: "" }));
				setQuickGroup(null);
			}
		} finally {
			savingRef.current = false;
			setQuickSaving(false);
		}
	};
	return { today, groups, mode, setMode, order, setOrder, creating, fields, setFields, quickGroup, setQuickGroup, quickTitles, setQuickTitles, quickSaving, submitQuick, openItem, openCreate, closePanel, openerRef, createSaving, submitCreate, toggleStatus, openGroups, setOpenGroups };
}

export type PersonalTodoWorkspace = ReturnType<typeof usePersonalTodoWorkspace>;
