/** 子待办表单缓冲：接口受理失败保留输入，成功只清理当次提交的缓冲。 */
import { useEffect, useRef, useState } from "react";
import type { PersonalTodoSubtask, PersonalTodoView } from "../../../shared/types/personalTodo";
import type { PersonalTodoController } from "./usePersonalTodo";

export function usePersonalTodoSubtodoComposer(todo: PersonalTodoController, view: PersonalTodoView) {
	const [text, setText] = useState("");
	const [saving, setSaving] = useState(false);
	const lock = useRef(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const submit = async () => {
		const submitted = text;
		if (!submitted.trim() || lock.current) return;
		lock.current = true;
		setSaving(true);
		try {
			const ok = await todo.addSubtodo(view, submitted);
			if (alive.current && ok) setText((current) => (current === submitted ? "" : current));
		} finally {
			lock.current = false;
			if (alive.current) setSaving(false);
		}
	};
	return { text, setText, saving, submit };
}

/** 文本和备注是一次子项编辑；旧提交不会关闭后来打开的子项。 */
export function usePersonalTodoSubtodoEditor(todo: PersonalTodoController, view: PersonalTodoView) {
	const [draft, setDraft] = useState<{ id: string; text: string; note: string } | null>(null);
	const [saving, setSaving] = useState(false);
	const lock = useRef(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const start = (subtodo: PersonalTodoSubtask) => {
		if (!lock.current) setDraft({ id: subtodo.id, text: subtodo.text, note: subtodo.note });
	};
	const change = (field: "text" | "note", value: string) => setDraft((current) => current && { ...current, [field]: value });
	const cancel = () => {
		if (!lock.current) setDraft(null);
	};
	const save = async () => {
		const submitted = draft;
		if (!submitted?.text.trim() || lock.current) return;
		lock.current = true;
		setSaving(true);
		try {
			const ok = await todo.updateSubtodo(view, submitted.id, { text: submitted.text.trim(), note: submitted.note });
			if (alive.current && ok) setDraft((current) => (current === submitted ? null : current));
		} finally {
			lock.current = false;
			if (alive.current) setSaving(false);
		}
	};
	return { draft, saving, start, change, cancel, save };
}
