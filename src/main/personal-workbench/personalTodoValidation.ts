/**
 * 待办 IPC 边界纯校验层（P02）：渲染层数据一律不可信，逐字段校验并归一。
 *
 * 为什么独立：这些判定决定「什么算合法写操作」，必须能脱离 Electron/fs/fetch 单测；
 * 校验失败一律返回结构化 `invalidInput`（带字段名），不抛裸异常，也不把上层拖进 try/catch。
 *
 * 边界：
 * - 不可变字段（id / revision / linkedTaskIds / source / 时间戳）不出现在任何写操作入参；
 * - `null` 与「缺省」语义不同：patch 里显式 `null` 表示清空该字段，缺省表示不改；
 * - 备注正文不做 trim（用户输入的前后空白属于内容），只拒绝控制字符；
 * - note 入参上限 4000 字（wire 新写预算）；旧记录里更长的备注在读取侧原样保留，不回写截断值。
 */

import {
	PERSONAL_TODO_ORDERS,
	PERSONAL_TODO_STATUSES,
	PERSONAL_TODO_URGENCY_MAX,
	type PersonalTodoErrorInfo,
	type PersonalTodoOperation,
	type PersonalTodoQuery,
	type PersonalTodoResolveConflictInput,
	type PersonalTodoRetryInput,
	type PersonalTodoStatus,
	type PersonalTodoSubmitInput,
} from "../../shared/types/personalTodo";

const MAX_ID_CHARS = 128;
const MAX_REVISION_CHARS = 256;
const MAX_TITLE_CHARS = 500;
const MAX_NOTE_CHARS = 4_000;
const MAX_CATEGORY_CHARS = 128;
const MAX_DATE_CHARS = 64;
const MAX_ASSIGNEE_CHARS = 128;
const MAX_SEARCH_CHARS = 200;
const MAX_CURSOR_CHARS = 512;
const MAX_REQUEST_ID_CHARS = 80;

/** 控制字符：正文允许换行/制表；其余 C0 与 DEL 一律拒绝（防日志注入与字段走私）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function fail(message: string, field?: string): { ok: false; error: PersonalTodoErrorInfo } {
	return { ok: false, error: { code: "invalidInput", message, ...(field ? { detail: { field } } : {}) } };
}

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || CONTROL_CHARS.test(trimmed)) return null;
	return trimmed;
}

/** 正文读取：允许换行与制表，不做 trim。 */
function readBody(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string" || value.length > maxLength) return null;
	if (CONTROL_CHARS.test(value)) return null;
	return value;
}

type OptionalField<T> = { present: true; value: T } | { present: false };

/** 可选文本字段：缺省 = 不改；显式 null（仅当 allowNull）= 清空。 */
function readOptionalText(record: object, key: string, maxLength: number, allowNull: boolean): OptionalField<string | null> | { invalid: true } {
	if (!Object.hasOwn(record, key)) return { present: false };
	const raw = Reflect.get(record, key);
	if (raw === null) return allowNull ? { present: true, value: null } : { invalid: true };
	const text = readString(raw, maxLength);
	return text === null ? { invalid: true } : { present: true, value: text };
}

/**
 * 可选正文字段（备注/背景）：走 `readBody` 而不是 `readString`。
 *
 * 为什么单列：备注是用户原文，空串必须能表达「无备注/清空」，前后空白与换行不能丢；
 * 而标题与子项文本是展示字段，仍按 `readOptionalText`（trim + 非空）。
 * 预算与非法控制字符的拒收与其它字段一致。
 */
function readOptionalBody(record: object, key: string, maxLength: number, allowNull: boolean): OptionalField<string | null> | { invalid: true } {
	if (!Object.hasOwn(record, key)) return { present: false };
	const raw = Reflect.get(record, key);
	if (raw === null) return allowNull ? { present: true, value: null } : { invalid: true };
	const text = readBody(raw, maxLength);
	return text === null ? { invalid: true } : { present: true, value: text };
}

/** 可选整数（紧急度）：缺省 = 不改；显式 null = 清空。 */
function readOptionalUrgency(record: object, key: string, allowNull: boolean): OptionalField<number | null> | { invalid: true } {
	if (!Object.hasOwn(record, key)) return { present: false };
	const raw = Reflect.get(record, key);
	if (raw === null) return allowNull ? { present: true, value: null } : { invalid: true };
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > PERSONAL_TODO_URGENCY_MAX) return { invalid: true };
	return { present: true, value: raw };
}

export function parsePersonalTodoStatus(value: unknown): PersonalTodoStatus | null {
	return typeof value === "string" && (PERSONAL_TODO_STATUSES as readonly string[]).includes(value) ? (value as PersonalTodoStatus) : null;
}

export function parsePersonalTodoId(value: unknown): string | null {
	return readString(value, MAX_ID_CHARS);
}

/**
 * CAS 版本串。
 *
 * 精确空串是**合法的本地链基准标记**（仅用于「本账号已耐久入队、尚未云端确认的 create」的后续
 * 编辑/完成/加子项）：这里只做结构放行，真正的权限与真实性由 `PersonalTodoService.buildQueuedOperation`
 * 用该账号真实的 outbox 队列判定——不靠 `todo_local_` 前缀、不靠伪造 id、不接受假 revision。
 * 已确认事项、随机 id、非 create 链带空版本仍会被 Service 拒绝。
 * 其它形状（非 string / 纯空白 / 控制字符 / 超长）一律拒绝；非空值仍 trim 后校验。
 */
function parseRevision(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value === "") return "";
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_REVISION_CHARS || CONTROL_CHARS.test(trimmed)) return null;
	return trimmed;
}

/** 客户端请求 id：`^[A-Za-z0-9_-]{8,80}$`（与 wire 的 request_id 约束兼容）。 */
export function parsePersonalTodoRequestId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length < 8 || trimmed.length > MAX_REQUEST_ID_CHARS) return null;
	return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

type CreateFields = { title: string; note?: string; category?: string | null; deadline?: string | null; urgency?: number | null };

/** create/patch 共享的字段解析；`patchMode` 时 title 可缺省。 */
function parseTodoFields(record: object, patchMode: boolean): { ok: true; fields: CreateFields & { hasAny: boolean } } | { ok: false; error: PersonalTodoErrorInfo } {
	const fields: CreateFields & { hasAny: boolean } = { title: "", hasAny: false };
	if (!patchMode) {
		const title = readString(Reflect.get(record, "title"), MAX_TITLE_CHARS);
		if (!title) return fail("标题不能为空或过长", "title");
		fields.title = title;
		fields.hasAny = true;
	} else if (Object.hasOwn(record, "title")) {
		const title = readString(Reflect.get(record, "title"), MAX_TITLE_CHARS);
		if (!title) return fail("标题不能为空或过长", "title");
		fields.title = title;
		fields.hasAny = true;
	}
	const note = readOptionalBody(record, "note", MAX_NOTE_CHARS, false);
	if ("invalid" in note) return fail("备注格式不合法", "note");
	if (note.present) {
		fields.note = note.value ?? "";
		fields.hasAny = true;
	}
	const category = readOptionalText(record, "category", MAX_CATEGORY_CHARS, true);
	if ("invalid" in category) return fail("分类格式不合法", "category");
	if (category.present) {
		fields.category = category.value;
		fields.hasAny = true;
	}
	const deadline = readOptionalText(record, "deadline", MAX_DATE_CHARS, true);
	if ("invalid" in deadline) return fail("日期格式不合法", "deadline");
	if (deadline.present) {
		fields.deadline = deadline.value;
		fields.hasAny = true;
	}
	const urgency = readOptionalUrgency(record, "urgency", true);
	if ("invalid" in urgency) return fail(`紧急度必须是 0..${PERSONAL_TODO_URGENCY_MAX} 的整数`, "urgency");
	if (urgency.present) {
		fields.urgency = urgency.value;
		fields.hasAny = true;
	}
	return { ok: true, fields };
}

function parseOperation(raw: unknown): { ok: true; operation: PersonalTodoOperation } | { ok: false; error: PersonalTodoErrorInfo } {
	if (!isRecord(raw)) return fail("缺少操作内容", "operation");
	const kind = Reflect.get(raw, "kind");
	const id = parsePersonalTodoId(Reflect.get(raw, "id"));
	const expectedRevision = parseRevision(Reflect.get(raw, "expectedRevision"));
	if (kind === "create") {
		const parsed = parseTodoFields(raw, false);
		if (!parsed.ok) return parsed;
		return {
			ok: true,
			operation: {
				kind: "create",
				title: parsed.fields.title,
				...(parsed.fields.note === undefined ? {} : { note: parsed.fields.note }),
				...(parsed.fields.category === undefined ? {} : { category: parsed.fields.category }),
				...(parsed.fields.deadline === undefined ? {} : { deadline: parsed.fields.deadline }),
				...(parsed.fields.urgency === undefined ? {} : { urgency: parsed.fields.urgency }),
			},
		};
	}
	if (kind !== "patch" && kind !== "status" && kind !== "subtodoAdd" && kind !== "subtodoPatch" && kind !== "subtodoStatus") return fail("未知的操作类型", "kind");
	if (!id) return fail("事项 id 不合法", "id");
	// null = 缺字段/非法形状；空串放行（本地链标记），是否合法由 Service 用真实待传队列判定
	if (expectedRevision === null) return fail("缺少版本（revision）", "expectedRevision");
	if (kind === "patch") {
		const patchRaw = Reflect.get(raw, "patch");
		if (!isRecord(patchRaw)) return fail("缺少修改字段", "patch");
		const parsed = parseTodoFields(patchRaw, true);
		if (!parsed.ok) return parsed;
		if (!parsed.fields.hasAny) return fail("修改字段不能为空", "patch");
		return {
			ok: true,
			operation: {
				kind: "patch",
				id,
				expectedRevision,
				patch: {
					...(parsed.fields.title ? { title: parsed.fields.title } : {}),
					...(parsed.fields.note === undefined ? {} : { note: parsed.fields.note }),
					...(parsed.fields.category === undefined ? {} : { category: parsed.fields.category }),
					...(parsed.fields.deadline === undefined ? {} : { deadline: parsed.fields.deadline }),
					...(parsed.fields.urgency === undefined ? {} : { urgency: parsed.fields.urgency }),
				},
			},
		};
	}
	if (kind === "status") {
		const status = parsePersonalTodoStatus(Reflect.get(raw, "status"));
		if (!status) return fail("状态取值不合法", "status");
		return { ok: true, operation: { kind: "status", id, expectedRevision, status } };
	}
	const subtodoId = parsePersonalTodoId(Reflect.get(raw, "subtodoId"));
	if (kind === "subtodoAdd") {
		const text = readString(Reflect.get(raw, "text"), MAX_TITLE_CHARS);
		if (!text) return fail("子待办文本不能为空或过长", "text");
		const note = readOptionalBody(raw, "note", MAX_NOTE_CHARS, false);
		if ("invalid" in note) return fail("子待办备注格式不合法", "note");
		const assignee = readOptionalText(raw, "assignee", MAX_ASSIGNEE_CHARS, true);
		if ("invalid" in assignee) return fail("负责人格式不合法", "assignee");
		return {
			ok: true,
			operation: {
				kind: "subtodoAdd",
				id,
				expectedRevision,
				text,
				...(note.present ? { note: note.value ?? "" } : {}),
				...(assignee.present ? { assignee: assignee.value } : {}),
			},
		};
	}
	if (!subtodoId) return fail("子待办 id 不合法", "subtodoId");
	if (kind === "subtodoPatch") {
		const text = readOptionalText(raw, "text", MAX_TITLE_CHARS, false);
		if ("invalid" in text) return fail("子待办文本格式不合法", "text");
		const note = readOptionalBody(raw, "note", MAX_NOTE_CHARS, false);
		if ("invalid" in note) return fail("子待办备注格式不合法", "note");
		if (!text.present && !note.present) return fail("子待办修改字段不能为空", "patch");
		return {
			ok: true,
			operation: {
				kind: "subtodoPatch",
				id,
				expectedRevision,
				subtodoId,
				...(text.present ? { text: text.value ?? "" } : {}),
				...(note.present ? { note: note.value ?? "" } : {}),
			},
		};
	}
	if (kind === "subtodoStatus") {
		const status = parsePersonalTodoStatus(Reflect.get(raw, "status"));
		if (!status) return fail("子待办状态取值不合法", "status");
		return { ok: true, operation: { kind: "subtodoStatus", id, expectedRevision, subtodoId, status } };
	}
	return fail("未知的操作类型", "kind");
}

/** desktopApi.personalTodo.submit 入参边界。 */
export function parsePersonalTodoSubmitInput(raw: unknown): { ok: true; input: PersonalTodoSubmitInput } | { ok: false; error: PersonalTodoErrorInfo } {
	if (!isRecord(raw)) return fail("提交参数不完整");
	const operation = parseOperation(Reflect.get(raw, "operation"));
	if (!operation.ok) return operation;
	const clientRequestIdRaw = Reflect.get(raw, "clientRequestId");
	const clientRequestId = clientRequestIdRaw === undefined ? undefined : parsePersonalTodoRequestId(clientRequestIdRaw);
	if (clientRequestIdRaw !== undefined && !clientRequestId) return fail("请求 id 不合法", "clientRequestId");
	return { ok: true, input: clientRequestId ? { operation: operation.operation, clientRequestId } : { operation: operation.operation } };
}

function readOptionalQueryText(value: unknown, maxLength: number): string | null | "invalid" {
	if (value === undefined || value === null) return null;
	return readString(value, maxLength) ?? "invalid";
}

/** desktopApi.personalTodo.list 入参边界：坏值直接拒绝，不静默改成默认值。 */
export function parsePersonalTodoQuery(raw: unknown): { ok: true; query: PersonalTodoQuery } | { ok: false; error: PersonalTodoErrorInfo } {
	if (raw === undefined || raw === null) return { ok: true, query: {} };
	if (!isRecord(raw)) return fail("查询参数不完整");
	const category = readOptionalQueryText(Reflect.get(raw, "category"), MAX_CATEGORY_CHARS);
	if (category === "invalid") return fail("分类筛选不合法", "category");
	const statusRaw = Reflect.get(raw, "status");
	let status: PersonalTodoStatus[] | null = null;
	if (statusRaw !== undefined && statusRaw !== null) {
		const list = Array.isArray(statusRaw) ? statusRaw : typeof statusRaw === "string" ? statusRaw.split(",") : null;
		if (!list) return fail("状态筛选不合法", "status");
		const parsed: PersonalTodoStatus[] = [];
		for (const entry of list) {
			const value = parsePersonalTodoStatus(typeof entry === "string" ? entry.trim() : entry);
			if (!value) return fail("状态筛选不合法", "status");
			if (!parsed.includes(value)) parsed.push(value);
		}
		status = parsed.length ? parsed : null;
	}
	const deadlineFrom = readOptionalQueryText(Reflect.get(raw, "deadlineFrom"), MAX_DATE_CHARS);
	if (deadlineFrom === "invalid") return fail("起始日期不合法", "deadlineFrom");
	const deadlineTo = readOptionalQueryText(Reflect.get(raw, "deadlineTo"), MAX_DATE_CHARS);
	if (deadlineTo === "invalid") return fail("结束日期不合法", "deadlineTo");
	const search = readOptionalQueryText(Reflect.get(raw, "search"), MAX_SEARCH_CHARS);
	if (search === "invalid") return fail("搜索词不合法", "search");
	const updatedSince = readOptionalQueryText(Reflect.get(raw, "updatedSince"), MAX_DATE_CHARS);
	if (updatedSince === "invalid") return fail("更新时间筛选不合法", "updatedSince");
	const orderRaw = Reflect.get(raw, "order");
	if (orderRaw !== undefined && orderRaw !== null && !(typeof orderRaw === "string" && (PERSONAL_TODO_ORDERS as readonly string[]).includes(orderRaw))) return fail("排序取值不合法", "order");
	const cursor = readOptionalQueryText(Reflect.get(raw, "cursor"), MAX_CURSOR_CHARS);
	if (cursor === "invalid") return fail("分页游标不合法", "cursor");
	const limitRaw = Reflect.get(raw, "limit");
	if (limitRaw !== undefined && limitRaw !== null && (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200)) return fail("每页条数必须在 1..200", "limit");
	return {
		ok: true,
		query: {
			...(category ? { category } : {}),
			...(status ? { status } : {}),
			...(deadlineFrom ? { deadlineFrom } : {}),
			...(deadlineTo ? { deadlineTo } : {}),
			...(search ? { search } : {}),
			...(updatedSince ? { updatedSince } : {}),
			...(typeof orderRaw === "string" ? { order: orderRaw as PersonalTodoQuery["order"] } : {}),
			...(cursor ? { cursor } : {}),
			...(typeof limitRaw === "number" ? { limit: limitRaw } : {}),
		},
	};
}

export function parsePersonalTodoRetryInput(raw: unknown): { ok: true; input: PersonalTodoRetryInput } | { ok: false; error: PersonalTodoErrorInfo } {
	if (raw === undefined || raw === null) return { ok: true, input: {} };
	if (!isRecord(raw)) return fail("重试参数不完整");
	const idRaw = Reflect.get(raw, "id");
	if (idRaw === undefined || idRaw === null) return { ok: true, input: {} };
	const id = parsePersonalTodoId(idRaw);
	if (!id) return fail("事项 id 不合法", "id");
	return { ok: true, input: { id } };
}

export function parsePersonalTodoResolveConflictInput(raw: unknown): { ok: true; input: PersonalTodoResolveConflictInput } | { ok: false; error: PersonalTodoErrorInfo } {
	if (!isRecord(raw)) return fail("冲突处理参数不完整");
	const id = parsePersonalTodoId(Reflect.get(raw, "id"));
	if (!id) return fail("事项 id 不合法", "id");
	const choice = Reflect.get(raw, "choice");
	if (choice !== "keepMine" && choice !== "takeCloud") return fail("冲突处理方式不合法", "choice");
	return { ok: true, input: { id, choice } };
}
