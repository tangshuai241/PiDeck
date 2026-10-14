/**
 * 待办 wire 适配（P02 ←→ 云端 `/api/cloud/personal-todos/v1`）。
 *
 * 唯一转换点：cloud wire 用 snake_case，TPA 域用 camelCase（shared/types/personalTodo.ts）。
 * 本模块是纯函数集合，不发起请求；transport 只负责 HTTP，字段语义全部在这里收口，
 * 云端契约调整时只改这一个文件。
 *
 * 关键映射：
 * - `revision` 取 wire `root_revision`（整族 CAS），**不与 item 级 `revision` 混用**；
 * - 子项 wire `title` → 域 `text`；`subtodo_progress` 缺失时由子项状态现算；
 * - `source.kind` 只接受 legacy/canonical，其余归 unknown（不猜成用户已确认）；
 * - 错误只暴露固定分类与安全 detail（field/reason/current/item_id），不回显服务端 message。
 */

import { PERSONAL_TODO_URGENCY_MAX, type PersonalTodo, type PersonalTodoErrorCode, type PersonalTodoOperation, type PersonalTodoSource, type PersonalTodoSubtask, type PersonalTodoSubtaskProgress } from "../../shared/types/personalTodo";

/** wire 字段读取：优先 snake_case，其次 camelCase（契约稳定但留一点容错，转换语义不变）。 */
function pick(record: object, snake: string, camel: string): unknown {
	const value = Reflect.get(record, snake);
	return value === undefined ? Reflect.get(record, camel) : value;
}

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWireString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length <= maxLength ? value : null;
}

function readStringArray(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const text = readWireString(entry, 256);
		if (text && !out.includes(text) && out.length < maxItems) out.push(text);
	}
	return out;
}

function readWireStatus(value: unknown, doneFallback: unknown): PersonalTodo["status"] {
	if (value === "open" || value === "done" || value === "cancelled") return value;
	return doneFallback === true ? "done" : "open";
}

function parseWireSource(raw: unknown, record: object): PersonalTodoSource {
	const sourceRecord = isRecord(raw) ? raw : null;
	const kindRaw = sourceRecord ? Reflect.get(sourceRecord, "kind") : null;
	const kind = kindRaw === "legacy" ? "legacy" : kindRaw === "canonical" ? "canonical" : "unknown";
	if (!sourceRecord) {
		// 兼容旧形状：source_legacy.namespace/source_id 直接挂在条目上
		const legacy = Reflect.get(record, "source_legacy");
		if (isRecord(legacy)) {
			return {
				kind: "legacy",
				namespace: readWireString(Reflect.get(legacy, "namespace"), 64),
				sourceId: readWireString(Reflect.get(legacy, "source_id"), 256),
				fingerprint: readWireString(Reflect.get(legacy, "fingerprint"), 128),
				rawAvailable: Reflect.get(legacy, "raw") != null,
			};
		}
		return { kind: "unknown", namespace: null, sourceId: null, fingerprint: null, rawAvailable: null };
	}
	return {
		kind,
		namespace: readWireString(Reflect.get(sourceRecord, "namespace"), 64),
		sourceId: readWireString(pick(sourceRecord, "source_id", "sourceId"), 256),
		fingerprint: readWireString(Reflect.get(sourceRecord, "fingerprint"), 128),
		rawAvailable: typeof Reflect.get(sourceRecord, "raw_available") === "boolean" ? (Reflect.get(sourceRecord, "raw_available") as boolean) : typeof Reflect.get(sourceRecord, "rawAvailable") === "boolean" ? (Reflect.get(sourceRecord, "rawAvailable") as boolean) : null,
	};
}

function parseWireSubtask(raw: unknown): PersonalTodoSubtask | null {
	if (!isRecord(raw)) return null;
	const id = readWireString(Reflect.get(raw, "id"), 256);
	if (!id) return null;
	const text = readWireString(pick(raw, "title", "text"), 20000);
	const note = readWireString(Reflect.get(raw, "note"), 20000);
	const assigneeRaw = Reflect.get(raw, "assignee");
	const sourceRecord = Reflect.get(raw, "source");
	const sourceId = (isRecord(sourceRecord) ? readWireString(pick(sourceRecord, "source_id", "sourceId"), 256) : null) ?? readWireString(pick(raw, "parent_subtodo_id", "parentSubtodoId"), 256) ?? readWireString(Reflect.get(raw, "sourceId"), 256);
	return {
		id,
		text: text ?? "",
		note: note ?? "",
		status: readWireStatus(Reflect.get(raw, "status"), Reflect.get(raw, "done")),
		assignee: readWireString(assigneeRaw, 128),
		linkedTaskIds: readStringArray(pick(raw, "linked_task_ids", "linkedTaskIds"), 200),
		sourceId,
	};
}

function parseWireProgress(raw: unknown, subtodos: PersonalTodoSubtask[]): PersonalTodoSubtaskProgress {
	if (isRecord(raw)) {
		const read = (key: string): number | null => {
			const value = Reflect.get(raw, key);
			return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
		};
		const total = read("total");
		const done = read("done");
		const open = read("open");
		const cancelled = read("cancelled");
		if (total !== null && done !== null && open !== null && cancelled !== null) return { total, done, open, cancelled };
	}
	return {
		total: subtodos.length,
		done: subtodos.filter((item) => item.status === "done").length,
		open: subtodos.filter((item) => item.status === "open").length,
		cancelled: subtodos.filter((item) => item.status === "cancelled").length,
	};
}

/** 单条 wire 条目 → 域记录；缺必需字段（id/revision）返回 null，不造半条记录。 */
export function parseWireTodo(raw: unknown): PersonalTodo | null {
	if (!isRecord(raw)) return null;
	const id = readWireString(Reflect.get(raw, "id"), 256);
	if (!id) return null;
	const revision = readWireString(pick(raw, "root_revision", "rootRevision"), 256) ?? readWireString(Reflect.get(raw, "revision"), 256);
	if (!revision) return null;
	const subtodosRaw = Reflect.get(raw, "subtodos");
	const subtodos = Array.isArray(subtodosRaw) ? subtodosRaw.map(parseWireSubtask).filter((item): item is PersonalTodoSubtask => item !== null) : [];
	const urgencyRaw = Reflect.get(raw, "urgency");
	const urgency = typeof urgencyRaw === "number" && Number.isInteger(urgencyRaw) && urgencyRaw >= 0 && urgencyRaw <= PERSONAL_TODO_URGENCY_MAX ? urgencyRaw : null;
	const historyRaw = pick(raw, "history_count", "historyCount");
	const isRootRaw = pick(raw, "is_root", "isRoot");
	const parentId = readWireString(pick(raw, "parent_id", "parentId"), 256);
	const clientRef = readWireString(pick(raw, "client_ref", "clientRef"), 128);
	const root = {
		id,
		title: readWireString(Reflect.get(raw, "title"), 20000) ?? "",
		note: readWireString(Reflect.get(raw, "note"), 20000) ?? "",
		category: readWireString(Reflect.get(raw, "category"), 128),
		deadline: readWireString(Reflect.get(raw, "deadline"), 64),
		urgency,
		status: readWireStatus(Reflect.get(raw, "status"), Reflect.get(raw, "done")),
		revision,
		createdAt: readWireString(pick(raw, "created_at", "createdAt"), 64),
		updatedAt: readWireString(pick(raw, "updated_at", "updatedAt"), 64),
		linkedTaskIds: readStringArray(pick(raw, "linked_task_ids", "linkedTaskIds"), 200),
		subtodos,
		subtodoProgress: parseWireProgress(pick(raw, "subtodo_progress", "subtodoProgress"), subtodos),
		source: parseWireSource(Reflect.get(raw, "source"), raw),
		isRoot: typeof isRootRaw === "boolean" ? isRootRaw : parentId === null,
		parentId,
		parentSubtaskId: readWireString(pick(raw, "parent_subtodo_id", "parentSubtodoId"), 256),
		historyCount: typeof historyRaw === "number" && Number.isInteger(historyRaw) && historyRaw >= 0 ? historyRaw : null,
	};
	// client_ref 只用于创建身份重建，不进入域记录；保留在 transport 结果里由服务层消费
	void clientRef;
	return root;
}

/** 列表/单条/写入响应解析。 */

export type WireListPage = {
	items: PersonalTodo[];
	nextCursor: string | null;
	hasMore: boolean;
	writeAvailable: boolean | null;
	writeReason: string | null;
};

/** `GET /items` 响应 → 域分页；不可解析返回 null（调用方按云端异常处理）。 */
export function parseWireListPage(payload: unknown): WireListPage | null {
	if (!isRecord(payload)) return null;
	const itemsRaw = Reflect.get(payload, "items");
	if (!Array.isArray(itemsRaw)) return null;
	const items: PersonalTodo[] = [];
	for (const entry of itemsRaw) {
		const parsed = parseWireTodo(entry);
		if (parsed) items.push(parsed);
	}
	const page = Reflect.get(payload, "page");
	const pageRecord = isRecord(page) ? page : null;
	const nextCursor = pageRecord ? readWireString(pick(pageRecord, "next_cursor", "nextCursor"), 512) : null;
	const hasMoreRaw = pageRecord ? Reflect.get(pageRecord, "has_more") : null;
	const writeAvailableRaw = Reflect.get(payload, "write_available");
	const writeReason = readWireString(pick(payload, "write_reason", "writeReason"), 256) ?? readWireString(pick(payload, "write_unavailable_reason", "writeUnavailableReason"), 256);
	return {
		items,
		nextCursor,
		hasMore: typeof hasMoreRaw === "boolean" ? hasMoreRaw : nextCursor !== null,
		writeAvailable: typeof writeAvailableRaw === "boolean" ? writeAvailableRaw : null,
		writeReason,
	};
}

/**
 * `GET /items/:id`（或 mutate 的单条响应）→ 整族根项记录。
 *
 * 优先 `root`：子项接口同时返回 `item`（该子项）与 `root`（整族），而缓存的顶层只放根项。
 * 旧响应没有 `root` 时才退到 `item`，且只接受 `is_root` 的记录或 `items` 里的根项，
 * 避免把子项当根项写进缓存（写进去会把真实父项挤掉）。
 */
export function parseWireItemPayload(payload: unknown): PersonalTodo | null {
	if (!isRecord(payload)) return null;
	const root = parseWireTodo(Reflect.get(payload, "root"));
	if (root) return root;
	const item = parseWireTodo(Reflect.get(payload, "item"));
	if (item?.isRoot) return item;
	const itemsRaw = Reflect.get(payload, "items");
	if (Array.isArray(itemsRaw)) {
		for (const entry of itemsRaw) {
			const parsed = parseWireTodo(entry);
			if (parsed?.isRoot) return parsed;
		}
	}
	return null;
}

export type WireMutateSuccess = {
	item: PersonalTodo;
	root: PersonalTodo | null;
	replayed: boolean;
	/** 变更对象（契约 `changed:{kind,id,parent_id,parent_subtodo_id}`）：id 是发生变更那条的身份。 */
	changedId: string | null;
	changedKind: string | null;
	/** 子项操作时的根项 id（重映射/定位用；旧响应缺该字段时由调用方从已证实字段推导）。 */
	changedParentId: string | null;
	/** 子项在原旧数据里的源 sN（wire parent_subtodo_id）；无则 null。 */
	changedParentSubtodoId: string | null;
};

export function parseWireMutateSuccess(payload: unknown): WireMutateSuccess | null {
	if (!isRecord(payload)) return null;
	if (Reflect.get(payload, "ok") !== true) return null;
	const item = parseWireTodo(Reflect.get(payload, "item"));
	if (!item) return null;
	const changedRaw = Reflect.get(payload, "changed");
	const changed = isRecord(changedRaw) ? changedRaw : null;
	return {
		item,
		root: parseWireTodo(Reflect.get(payload, "root")),
		replayed: Reflect.get(payload, "replayed") === true,
		changedId: changed ? readWireString(Reflect.get(changed, "id"), 256) : null,
		changedKind: changed ? readWireString(Reflect.get(changed, "kind"), 64) : null,
		changedParentId: changed ? readWireString(pick(changed, "parent_id", "parentId"), 256) : null,
		changedParentSubtodoId: changed ? readWireString(pick(changed, "parent_subtodo_id", "parentSubtodoId"), 256) : null,
	};
}

export type WireErrorMapping = {
	code: PersonalTodoErrorCode;
	/** 云端稳定错误码（如 REVISION_CONFLICT）；界面 detail 用，不做文案直出。 */
	wireCode: string | null;
	message: string;
	detail?: Record<string, string | number | boolean | null>;
	/** REVISION_CONFLICT 时云端当前整族 revision。 */
	conflictCurrent: string | null;
	/** CLIENT_REF_CONFLICT 时已存在的条目 id（create 其实已生效）。 */
	clientRefItemId: string | null;
};

function safeDetail(payload: object | null): Record<string, string | number | boolean | null> | undefined {
	if (!payload) return undefined;
	const detailRaw = Reflect.get(payload, "detail");
	if (!isRecord(detailRaw)) return undefined;
	const out: Record<string, string | number | boolean | null> = {};
	for (const key of ["field", "reason", "current", "item_id", "sub_id"]) {
		const value = Reflect.get(detailRaw, key);
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * wire 错误 → 域错误。`status` 与 `code` 一起判定：
 * - 501 NOT_ENABLED（读门未开）/ 503 WRITE_NOT_SWITCHED（写门未切换）/ 503 TASK_DOMAIN_BARRIER
 *   → writeUnavailable（客户端只留稿）；
 * - 409 REVISION_CONFLICT → conflict（保留草稿与云端版本）；
 * - 409 CLIENT_REF_CONFLICT → cloudRejected + clientRefItemId（创建其实已生效）；
 * - 带结构化 body 的其余 4xx/5xx → cloudRejected（服务端已判定，不重发）；
 * - 无 body 的 5xx → unknownOutcome（可能已生效，先查回执）。
 */
/**
 * 冲突的「云端当前整族 revision」：真云端把 `detail.current` 给成对象
 * `{root_revision, item_revision, updated_at, subtodo_progress}`（旧形状是字符串），两种都认；
 * 都没有时返回 null——调用方按「缺少证据」保守处理，不猜。
 */
function readConflictCurrent(errorRecord: object | null): string | null {
	const detailRaw = errorRecord ? Reflect.get(errorRecord, "detail") : null;
	const detail = isRecord(detailRaw) ? detailRaw : null;
	const current = detail ? Reflect.get(detail, "current") : null;
	if (typeof current === "string" && current.length > 0) return current;
	if (isRecord(current)) {
		const revision = readWireString(pick(current, "root_revision", "rootRevision"), 256);
		if (revision) return revision;
	}
	return null;
}

export function mapWireError(status: number, payload: unknown): WireErrorMapping {
	const body = isRecord(payload) ? payload : null;
	const errorRaw = body ? Reflect.get(body, "error") : null;
	const errorRecord = isRecord(errorRaw) ? errorRaw : null;
	const wireCode = errorRecord ? readWireString(Reflect.get(errorRecord, "code"), 64) : null;
	const detail = safeDetail(errorRecord);
	const conflictCurrent = readConflictCurrent(errorRecord);
	const clientRefItemId = detail && typeof detail.item_id === "string" ? detail.item_id : null;
	const withWire = (code: PersonalTodoErrorCode, message: string): WireErrorMapping => ({ code, wireCode, message, detail, conflictCurrent, clientRefItemId });

	if (wireCode === "NOT_ENABLED" || wireCode === "TASK_DOMAIN_BARRIER" || wireCode === "WRITE_NOT_SWITCHED") return withWire("writeUnavailable", "云端写入尚未启用");
	if (wireCode === "REVISION_CONFLICT") return withWire("conflict", "云端内容已更新，请比较后再保存");
	if (wireCode === "CLIENT_REF_CONFLICT") return withWire("cloudRejected", "该创建请求已生效，正在恢复原记录");
	if (wireCode === "SUBTODO_INCOMPLETE") return withWire("cloudRejected", "存在未完成子待办，不能完成父项");
	if (wireCode === "SUBTODO_LIMIT") return withWire("cloudRejected", "子待办数量已达上限");
	if (wireCode === "SUBTODO_REQUIRED") return withWire("cloudRejected", "该父项已有子待办，不能再改整族关联");
	if (wireCode === "REQUEST_CONFLICT") return withWire("cloudRejected", "同一请求 id 的重复请求内容不一致");
	if (wireCode === "REQUEST_NOT_FOUND") return withWire("cloudRejected", "云端没有该请求的回执");
	if (wireCode === "ITEM_NOT_FOUND" || wireCode === "SUBTODO_NOT_FOUND" || wireCode === "PARENT_NOT_FOUND") return withWire("cloudRejected", "云端找不到对应记录");
	if (wireCode === "BAD_REQUEST" || wireCode === "REQUEST_ID_REQUIRED" || wireCode === "BAD_CURSOR") return withWire("invalidInput", "云端拒绝了请求参数");
	if (errorRecord) return withWire("cloudRejected", `云端返回 ${status}`);
	if (status >= 500) return { code: "unknownOutcome", wireCode: null, message: "云端响应异常，结果待确认", detail, conflictCurrent: null, clientRefItemId: null };
	return { code: "internalError", wireCode: null, message: `云端返回 ${status}`, detail, conflictCurrent: null, clientRefItemId: null };
}

export type WireRequestStatus = {
	state: "applied" | "pending" | "other";
	itemId: string | null;
	subId: string | null;
	result: WireMutateSuccess | null;
	/**
	 * 耐久回执记录的「当次提交后的整族 revision」（wire `root_revision_after`）。
	 * 只作为「是否有人在本机这次写之后再写」的证据用于自动重基线，绝不当作当前云端版本；
	 * 旧回执没有该字段时为 null → 调用方必须保守留稿，不猜。
	 */
	rootRevisionAfter: string | null;
};

/**
 * 扁平 applied 回执（云端 `GET /requests/:id` 的真实形状：身份在顶层、无 `result`）→ WireMutateSuccess。
 *
 * 为什么需要：回执腿只拿到 `{state:'applied', item_id, sub_id, root_id, changed, item, root, …}`，
 * 若不合成，runner 会把「已确认的子项操作」当成无身份，导致后续指向本地 sub id 的操作不被重映射。
 * 这里只用回执已证实的字段：`item`/`root` 是当前快照（供刷新缓存），`changed` 给身份；
 * 缺 `changed` 也不猜 id，由 runner 按 `item.parentId` 或回执 `sub_id` 等已证实字段回退。
 */
function parseFlatAppliedReceipt(payload: object): WireMutateSuccess | null {
	const item = parseWireTodo(Reflect.get(payload, "item"));
	if (!item) return null;
	const changedRaw = Reflect.get(payload, "changed");
	const changed = isRecord(changedRaw) ? changedRaw : null;
	return {
		item,
		root: parseWireTodo(Reflect.get(payload, "root")),
		// 回执腿是「复核既有结果」，不是新的提交
		replayed: true,
		changedId: changed ? readWireString(Reflect.get(changed, "id"), 256) : null,
		changedKind: changed ? readWireString(Reflect.get(changed, "kind"), 64) : null,
		changedParentId: changed ? readWireString(pick(changed, "parent_id", "parentId"), 256) : null,
		changedParentSubtodoId: changed ? readWireString(pick(changed, "parent_subtodo_id", "parentSubtodoId"), 256) : null,
	};
}

/** `GET /requests/:requestId` → 回执状态（applied 时尽量带回原结果）。 */
export function parseWireRequestStatus(payload: unknown): WireRequestStatus | null {
	if (!isRecord(payload)) return null;
	const state = Reflect.get(payload, "state");
	if (state !== "applied" && state !== "pending") return { state: "other", itemId: null, subId: null, result: null, rootRevisionAfter: null };
	const itemId = readWireString(pick(payload, "item_id", "itemId"), 256);
	const subId = readWireString(pick(payload, "sub_id", "subId"), 256);
	// 优先内嵌 result（旧路径）；云端实际是扁平回执 → 用顶层 item/root/changed 合成同形结果
	const result = state === "applied" ? (parseWireMutateSuccess(Reflect.get(payload, "result")) ?? parseFlatAppliedReceipt(payload)) : null;
	const rootRevisionAfter = state === "applied" ? readWireString(pick(payload, "root_revision_after", "rootRevisionAfter"), 256) : null;
	return { state, itemId, subId, result, rootRevisionAfter };
}

/** `POST /mutate` 请求体：唯一写入口，op 区分动作；未声明字段一律不带。 */
export function buildMutateBody(operation: PersonalTodoOperation, requestId: string, clientRef: string | null): Record<string, unknown> {
	if (operation.kind === "create") {
		return {
			op: "create",
			request_id: requestId,
			title: operation.title,
			...(operation.note === undefined ? {} : { note: operation.note }),
			...(operation.category === undefined ? {} : { category: operation.category }),
			...(operation.deadline === undefined ? {} : { deadline: operation.deadline }),
			...(operation.urgency === undefined ? {} : { urgency: operation.urgency }),
			...(clientRef ? { client_ref: clientRef } : {}),
		};
	}
	if (operation.kind === "patch") {
		const fields: Record<string, unknown> = {};
		if (operation.patch.title !== undefined) fields.title = operation.patch.title;
		if (operation.patch.note !== undefined) fields.note = operation.patch.note;
		if (operation.patch.category !== undefined) fields.category = operation.patch.category;
		if (operation.patch.deadline !== undefined) fields.deadline = operation.patch.deadline;
		if (operation.patch.urgency !== undefined) fields.urgency = operation.patch.urgency;
		return { op: "patch", request_id: requestId, expected_revision: operation.expectedRevision, id: operation.id, fields };
	}
	if (operation.kind === "status") {
		return { op: "status", request_id: requestId, expected_revision: operation.expectedRevision, id: operation.id, status: operation.status };
	}
	if (operation.kind === "subtodoAdd") {
		return {
			op: "subtodo_add",
			request_id: requestId,
			expected_revision: operation.expectedRevision,
			id: operation.id,
			text: operation.text,
			...(operation.note === undefined ? {} : { note: operation.note }),
			...(operation.assignee === undefined ? {} : { assignee: operation.assignee }),
		};
	}
	if (operation.kind === "subtodoPatch") {
		const fields: Record<string, unknown> = {};
		if (operation.text !== undefined) fields.title = operation.text;
		if (operation.note !== undefined) fields.note = operation.note;
		return { op: "subtodo_patch", request_id: requestId, expected_revision: operation.expectedRevision, id: operation.id, sub_id: operation.subtodoId, fields };
	}
	return { op: "subtodo_status", request_id: requestId, expected_revision: operation.expectedRevision, id: operation.id, sub_id: operation.subtodoId, status: operation.status };
}
