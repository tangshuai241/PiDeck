/**
 * 待办编辑草稿（纯函数）：表单缓冲的建立、脏值判断、patch 构造与校验。
 *
 * 为什么需要这一层：主进程队列里的 draft 是「已提交待确认」的事实，界面还必须有一份
 * 「用户正在打字」的缓冲。两者不能混：提交失败、冲突时缓冲必须原样保留（任务规则：
 * 保存失败输入保留、冲突不自动覆盖），只有受理成功后才把缓冲交给主进程的 draft。
 *
 * 边界：`revision` 原样携带（不解析、不重算）；`deadline` 保留原字符串，空串表示清空为 null；
 * `urgency` 在表单里是字符串，落成操作前必须通过 0..3 整数校验。
 */
import type { PersonalTodo, PersonalTodoErrorInfo, PersonalTodoOperation, PersonalTodoView } from "../../../shared/types/personalTodo";
import { PERSONAL_TODO_URGENCY_MAX } from "../../../shared/types/personalTodo";
import type { TranslationKey } from "../i18n";
import { personalTodoDraftKey } from "./personalTodoQuery";

/** patch 操作的字段集，直接取自共享契约，避免在这里另立一套同义字段。 */
export type PersonalTodoPatchFields = Extract<PersonalTodoOperation, { kind: "patch" }>["patch"];

/** 表单字段：全部用字符串承载（输入框就是字符串；数字字段在提交前校验）。 */
export type PersonalTodoDraftFields = {
	title: string;
	note: string;
	category: string;
	deadline: string;
	urgency: string;
};

/**
 * 界面编辑缓冲。
 * - `base`/`baseRevision` 是「用户开始编辑时看到的版本」：patch 只带相对基线的变化，
 *   CAS 也以它为准。用提交时的列表快照当基线会让一次后台刷新把用户的修改吞成空 patch。
 * - `requestId` 在首次提交时生成；同一份缓冲重试必须复用它（主进程按 requestId 幂等）。
 * - `lastError` 只记录本次提交的结构化错误，不覆盖用户输入。
 */
export type PersonalTodoDraftForm = {
	scopeKey: string;
	itemId: string;
	baseRevision: string;
	base: PersonalTodoDraftFields;
	fields: PersonalTodoDraftFields;
	dirty: boolean;
	requestId: string | null;
	lastError: PersonalTodoErrorInfo | null;
};

function asText(value: string | null | undefined): string {
	return value ?? "";
}

/** 从记录取表单字段：优先用主进程给出的 draft（未确认修改），否则用确认版本。 */
export function personalTodoDraftFieldsFromItem(item: PersonalTodo): PersonalTodoDraftFields {
	return {
		title: asText(item.title),
		note: asText(item.note),
		category: asText(item.category),
		deadline: asText(item.deadline),
		urgency: item.urgency === null || item.urgency === undefined ? "" : String(item.urgency),
	};
}

/**
 * 提交基准：优先云端已确认版本；没有 confirmed 时用 item 自身的 revision。
 * 纯本地新建（无云端身份）的 revision 为空串，此时按契约也不该出现 patch 操作。
 */
export function personalTodoDraftBaseRevision(view: PersonalTodoView): string {
	return view.confirmed?.revision ?? view.item.revision;
}

/** 建立编辑缓冲：以「用户当前看到的记录」为初值，不自动标记脏值。 */
export function createPersonalTodoDraftForm(input: { scopeKey: string; view: PersonalTodoView }): PersonalTodoDraftForm {
	const base = personalTodoDraftFieldsFromItem(input.view.draft ?? input.view.item);
	return {
		scopeKey: input.scopeKey,
		itemId: input.view.item.id,
		baseRevision: personalTodoDraftBaseRevision(input.view),
		base,
		fields: { ...base },
		dirty: false,
		requestId: null,
		lastError: null,
	};
}

/** 字段与基线不同即脏；只比用户可编辑字段，不把 requestId/lastError 当用户输入。 */
export function personalTodoDraftIsDirty(base: PersonalTodoDraftFields, fields: PersonalTodoDraftFields): boolean {
	return base.title !== fields.title || base.note !== fields.note || base.category !== fields.category || base.deadline !== fields.deadline || base.urgency !== fields.urgency;
}

/** 表单校验：返回需要展示的文案 key，null = 可以提交。 */
export function personalTodoDraftValidationKey(fields: PersonalTodoDraftFields): TranslationKey | null {
	if (fields.title.trim().length === 0) return "personalTodo.titleRequired";
	const urgency = fields.urgency.trim();
	if (urgency.length > 0) {
		const parsed = Number(urgency);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > PERSONAL_TODO_URGENCY_MAX) return "personalTodo.urgencyInvalid";
	}
	return null;
}

/** 空串 → null（清空该字段）；非空 → 去首尾空白后的原值。 */
function patchValue(value: string): string | null {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** 由当前缓冲与基线构造 patch：只带真正变化的字段，没有变化返回 null。 */
export function personalTodoDraftPatch(base: PersonalTodoDraftFields, fields: PersonalTodoDraftFields): PersonalTodoPatchFields | null {
	const patch: PersonalTodoPatchFields = {};
	if (fields.title !== base.title) patch.title = fields.title;
	if (fields.note !== base.note) patch.note = fields.note;
	if (fields.category !== base.category) patch.category = patchValue(fields.category);
	if (fields.deadline !== base.deadline) patch.deadline = patchValue(fields.deadline);
	if (fields.urgency !== base.urgency) {
		const urgency = fields.urgency.trim();
		patch.urgency = urgency.length > 0 ? Number(urgency) : null;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

/** 列表里替换/追加一条视图（提交、冲突处理、推送共用的最小合并规则）。 */
export function upsertPersonalTodoView(items: readonly PersonalTodoView[], view: PersonalTodoView): PersonalTodoView[] {
	const index = items.findIndex((candidate) => candidate.item.id === view.item.id);
	if (index < 0) return [...items, view];
	const next = [...items];
	next[index] = view;
	return next;
}

/**
 * 本地 id 被云端身份替换后，把该事项的未提交草稿从一个身份键迁到另一个（切账号/换代同样适用）。
 * 已有新键的占位则不覆盖（以更新的输入为准），旧键总是删掉，避免两份草稿并存。
 */
export function remapPersonalTodoDrafts(drafts: Record<string, PersonalTodoDraftForm>, scopeKey: string, remaps: readonly { from: string; to: string }[]): Record<string, PersonalTodoDraftForm> {
	let next = drafts;
	for (const remap of remaps) {
		const fromKey = personalTodoDraftKey(scopeKey, remap.from);
		const toKey = personalTodoDraftKey(scopeKey, remap.to);
		const form = next[fromKey];
		if (!form) continue;
		if (next === drafts) next = { ...drafts };
		delete next[fromKey];
		if (!next[toKey]) next[toKey] = { ...form, itemId: remap.to };
	}
	return next;
}
/**
 * 请求 id：`[A-Za-z0-9_-]{8,80}`。用随机源生成，不依赖时间戳（同毫秒内两次创建不能撞）。
 * 生成失败（极端环境无 crypto）时回落到随机串，仍是合法字符集。
 */
export function createPersonalTodoRequestId(prefix = "todo"): string {
	const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2).padEnd(16, "0");
	return `${prefix}-${random}`.slice(0, 80);
}
