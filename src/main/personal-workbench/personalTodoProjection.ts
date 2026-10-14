/**
 * 待办投影（P02 纯函数）：把「云端确认记录 + 本地未确认操作」合成渲染视图。
 *
 * 为什么独立：草稿叠加、冲突判定、队列摘要与筛选排序都是产品规则，必须能脱离 fs/HTTP 单测；
 * 组件与服务只消费结果，不各自再算一遍。
 *
 * 边界：
 * - 只有 `confirmed` 记录来自云端；本地草稿永不写回缓存（缓存只存已确认记录）；
 * - 同一个 itemId 的操作按入队顺序叠加（服务层保证串行），后加入的子项用它自己的本地 id，
 *   确认后由服务层把后续操作的 subtodoId 重映射到服务端 id；
 * - 输出视图永远同时给出 confirmed 与 draft，冲突时界面可以并列比较，不做静默覆盖。
 */

import { randomBytes } from "node:crypto";
import type { PersonalTodo, PersonalTodoLinkedTask, PersonalTodoQuery, PersonalTodoSubtask, PersonalTodoSyncState, PersonalTodoSyncSummary, PersonalTodoView } from "../../shared/types/personalTodo";
import type { PersonalTodoLedgerEntry, PersonalTodoQueuedOperation } from "./personalTodoStore";

export function createLocalTodoId(): string {
	return `todo_local_${randomBytes(8).toString("hex")}`;
}

export function createLocalSubtodoId(): string {
	return `sub_local_${randomBytes(8).toString("hex")}`;
}

/** 请求 id：`[A-Za-z0-9_-]{8,80}`，一次入队生成后不再变。 */
export function createRequestId(): string {
	return `pt_${randomBytes(12).toString("hex")}`;
}

/** 创建专用稳定业务键（wire client_ref）：重发时复用，服务端据此避免第二条记录。 */
export function createClientRef(requestId: string): string {
	return `tpa-${requestId}`;
}

/** 未确认 create 的本地占位记录（无云端字段）。 */
export function blankTodoForCreate(itemId: string, operation: Extract<PersonalTodoQueuedOperation["operation"], { kind: "create" }>): PersonalTodo {
	return {
		id: itemId,
		title: operation.title,
		note: operation.note ?? "",
		category: operation.category ?? null,
		deadline: operation.deadline ?? null,
		urgency: operation.urgency ?? null,
		status: "open",
		revision: "",
		createdAt: null,
		updatedAt: null,
		linkedTaskIds: [],
		subtodos: [],
		subtodoProgress: { total: 0, done: 0, open: 0, cancelled: 0 },
		source: { kind: "canonical", namespace: null, sourceId: null, fingerprint: null, rawAvailable: null },
		isRoot: true,
		parentId: null,
		parentSubtaskId: null,
		historyCount: null,
	};
}

function subtodoProgress(subtodos: PersonalTodoSubtask[]): PersonalTodo["subtodoProgress"] {
	return {
		total: subtodos.length,
		done: subtodos.filter((item) => item.status === "done").length,
		open: subtodos.filter((item) => item.status === "open").length,
		cancelled: subtodos.filter((item) => item.status === "cancelled").length,
	};
}

/** 把一条未确认操作叠加到记录上（create 用 blankTodoForCreate 作为基准）。 */
export function applyOperation(record: PersonalTodo, queued: PersonalTodoQueuedOperation): PersonalTodo {
	const operation = queued.operation;
	if (operation.kind === "create") return blankTodoForCreate(queued.itemId, operation);
	if (operation.kind === "patch") {
		const patch = operation.patch;
		return {
			...record,
			...(patch.title === undefined ? {} : { title: patch.title }),
			...(patch.note === undefined ? {} : { note: patch.note }),
			...(patch.category === undefined ? {} : { category: patch.category }),
			...(patch.deadline === undefined ? {} : { deadline: patch.deadline }),
			...(patch.urgency === undefined ? {} : { urgency: patch.urgency }),
		};
	}
	if (operation.kind === "status") return { ...record, status: operation.status };
	if (operation.kind === "subtodoAdd") {
		const id = queued.localSubtodoId ?? createLocalSubtodoId();
		const subtodos = [...record.subtodos, { id, text: operation.text, note: operation.note ?? "", status: "open" as const, assignee: operation.assignee ?? null, linkedTaskIds: [], sourceId: null }];
		return { ...record, subtodos, subtodoProgress: subtodoProgress(subtodos) };
	}
	if (operation.kind === "subtodoPatch") {
		const subtodos = record.subtodos.map((subtodo) =>
			subtodo.id === operation.subtodoId
				? {
						...subtodo,
						...(operation.text === undefined ? {} : { text: operation.text }),
						...(operation.note === undefined ? {} : { note: operation.note }),
					}
				: subtodo,
		);
		return { ...record, subtodos };
	}
	const subtodos = record.subtodos.map((subtodo) => (subtodo.id === operation.subtodoId ? { ...subtodo, status: operation.status } : subtodo));
	return { ...record, subtodos, subtodoProgress: subtodoProgress(subtodos) };
}

/** 在基准记录（可为 null，仅当首条操作是 create）上按序叠加操作；无法叠加时返回 null。 */
/**
 * 叠加入队操作：`seed` 为空时只能从 create 起步（离线未确认的新建）。
 * 导出给服务层做「提交前规则预检」（如父项完成需先看叠加后的子项状态），
 * 避免服务层与视图各自实现一份叠加。
 */
export function projectOperations(seed: PersonalTodo | null, operations: PersonalTodoQueuedOperation[]): PersonalTodo | null {
	let record = seed;
	for (const operation of operations) {
		if (operation.operation.kind === "create") {
			record = blankTodoForCreate(operation.itemId, operation.operation);
			continue;
		}
		if (!record) return null;
		record = applyOperation(record, operation);
	}
	return record;
}

/** 队列相位汇总：冲突 > 未知 > 发送中 > 失败 > 待传 > 已同步（严重优先，避免用绿色盖住未确认）。 */
export function syncStateOf(operations: PersonalTodoQueuedOperation[]): PersonalTodoSyncState {
	const pending = operations.filter((operation) => operation.phase !== "confirmed");
	if (pending.length === 0) return { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null };
	const lastAttemptAt = pending.reduce<string | null>((latest, operation) => (operation.lastAttemptAt && (!latest || operation.lastAttemptAt > latest) ? operation.lastAttemptAt : latest), null);
	const lastError = pending.reduce<PersonalTodoSyncState["lastError"]>((found, operation) => operation.lastError ?? found, null);
	const conflict = pending.find((operation) => operation.phase === "conflict");
	if (conflict) return { phase: "conflict", pendingCount: pending.length, lastError, cloudRevision: conflict.conflictRevision, lastAttemptAt };
	if (pending.some((operation) => operation.phase === "unknown")) return { phase: "unknown", pendingCount: pending.length, lastError, cloudRevision: null, lastAttemptAt };
	if (pending.some((operation) => operation.phase === "sending")) return { phase: "sending", pendingCount: pending.length, lastError, cloudRevision: null, lastAttemptAt };
	if (pending.some((operation) => operation.phase === "error")) return { phase: "error", pendingCount: pending.length, lastError, cloudRevision: null, lastAttemptAt };
	return { phase: "pending", pendingCount: pending.length, lastError, cloudRevision: null, lastAttemptAt };
}

export function summarize(operations: PersonalTodoQueuedOperation[], ledgerEntries: PersonalTodoLedgerEntry[]): PersonalTodoSyncSummary {
	const count = (phase: PersonalTodoQueuedOperation["phase"]): number => operations.filter((operation) => operation.phase === phase).length;
	return {
		pending: count("pending"),
		sending: count("sending"),
		conflict: count("conflict"),
		unknown: count("unknown"),
		error: count("error"),
		confirmedRecent: ledgerEntries.length,
	};
}

export function buildLinkedTasks(ids: string[], availability?: Map<string, boolean> | null): PersonalTodoLinkedTask[] {
	return ids.map((id) => ({ id, available: availability?.get(id) ?? null }));
}

export type BuildViewsInput = {
	/** 云端确认记录（缓存顺序即展示顺序）。 */
	items: PersonalTodo[];
	operations: PersonalTodoQueuedOperation[];
	linkedTaskAvailability?: Map<string, boolean> | null;
};

/**
 * 合成视图：每个 confirmed 记录叠加它的未确认操作；只有本地操作、云端尚无 id 的 create
 * 记录也参与展示（放在最前，符合 created_desc 的「新记录在前」）。
 */
export function buildViews(input: BuildViewsInput): PersonalTodoView[] {
	const confirmedById = new Map(input.items.map((item) => [item.id, item]));
	const operationsByItem = new Map<string, PersonalTodoQueuedOperation[]>();
	for (const operation of input.operations) {
		if (operation.phase === "confirmed") continue;
		const list = operationsByItem.get(operation.itemId);
		if (list) list.push(operation);
		else operationsByItem.set(operation.itemId, [operation]);
	}
	const localCreates: PersonalTodoView[] = [];
	const views: PersonalTodoView[] = [];
	for (const item of input.items) {
		const operations = operationsByItem.get(item.id);
		// 只有 create 能凭空造记录；其它操作必须有已确认基准（服务层保证）
		const draft = operations ? projectOperations(item, operations) : null;
		views.push({
			item: draft ?? item,
			confirmed: item,
			draft,
			sync: syncStateOf(operations ?? []),
			linkedTasks: buildLinkedTasks((draft ?? item).linkedTaskIds, input.linkedTaskAvailability),
		});
	}
	for (const [itemId, operations] of operationsByItem) {
		if (confirmedById.has(itemId)) continue;
		const draft = projectOperations(null, operations);
		if (!draft) continue;
		localCreates.push({ item: draft, confirmed: null, draft, sync: syncStateOf(operations), linkedTasks: buildLinkedTasks(draft.linkedTaskIds, input.linkedTaskAvailability) });
	}
	return [...localCreates.reverse(), ...views];
}

function matchesSearch(item: PersonalTodo, search: string): boolean {
	const needle = search.toLowerCase();
	if (item.title.toLowerCase().includes(needle)) return true;
	if (item.note.toLowerCase().includes(needle)) return true;
	return (item.category ?? "").toLowerCase().includes(needle);
}

/** 本地筛选：字段原文比较，不解析时区；deadline 或 updatedAt 缺失时，带该条件即视为不匹配。 */
export function filterViews(views: PersonalTodoView[], query: PersonalTodoQuery): PersonalTodoView[] {
	const category = query.category ?? null;
	const statuses = query.status ?? null;
	const from = query.deadlineFrom ?? null;
	const to = query.deadlineTo ?? null;
	const updatedSince = query.updatedSince ?? null;
	const search = query.search ?? null;
	return views.filter((view) => {
		const item = view.item;
		if (category && item.category !== category) return false;
		if (statuses && statuses.length > 0 && !statuses.includes(item.status)) return false;
		if (from || to) {
			if (!item.deadline) return false;
			if (from && item.deadline < from) return false;
			if (to && item.deadline > to) return false;
		}
		if (updatedSince && (!item.updatedAt || item.updatedAt < updatedSince)) return false;
		if (search && !matchesSearch(item, search)) return false;
		return true;
	});
}
