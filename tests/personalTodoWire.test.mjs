/**
 * 待办 wire 适配窄测（P02）：旧数据保真转换、root_revision CAS 映射、受限来源元数据、
 * 错误分类与 mutate 请求体。纯函数测试，不发网络。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildMutateBody, mapWireError, parseWireItemPayload, parseWireListPage, parseWireMutateSuccess, parseWireRequestStatus, parseWireTodo } = loadTsCommonJs("src/main/personal-workbench/personalTodoWire.ts");

/** vm 沙箱里的对象原型与宿主不同；结构比较前先转成宿主普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("旧导入条目按 camelCase 规范化并保留身份、来源与日期原文", () => {
	const legacy = {
		id: "todo-20260905-1000-p0yr",
		title: "旧事项",
		note: "长备注".repeat(300),
		category: "工作",
		deadline: "2026-09-05",
		urgency: 2,
		status: "done",
		revision: "r1-item",
		root_revision: "r1-root",
		is_root: true,
		parent_id: null,
		created_at: "2026-09-05T10:00:00.000Z",
		updated_at: "2026-09-06T00:00:00.000Z",
		linked_task_ids: ["20260905-1011-cx15", "20261002-1903-tlpd"],
		subtodos: [{ id: "legacy_sub_abc", title: "子项一", note: "", status: "open", assignee: "me", linked_task_ids: ["t1"], parent_subtodo_id: "s1", revision: "r-sub" }],
		subtodo_progress: { total: 1, done: 0, open: 1, cancelled: 0 },
		source: { kind: "legacy", namespace: "workbench", source_id: "s1", fingerprint: "fp", raw_available: true },
		history_count: 3,
	};
	const item = parseWireTodo(legacy);
	assert.equal(item.revision, "r1-root", "CAS 取整族 root_revision，不与 item 级 revision 混用");
	assert.equal(item.note.length, "长备注".repeat(300).length, "长备注不截断");
	assert.equal(item.deadline, "2026-09-05", "日期保留原文");
	assert.equal(item.createdAt, "2026-09-05T10:00:00.000Z");
	assert.deepEqual(plain(item.linkedTaskIds), ["20260905-1011-cx15", "20261002-1903-tlpd"], "悬挂关联保留");
	assert.equal(item.subtodos[0].text, "子项一", "子项 wire title 映射到 text");
	assert.equal("parentSubtaskId" in item.subtodos[0], false, "域子项不携带 parent_subtodo_id");
	assert.equal(item.subtodos[0].sourceId, "s1", "旧子项 sN 保留在 sourceId（只在父项内唯一）");
	assert.equal(item.parentSubtaskId, null, "根项没有父作用域，sN 不混入根字段");
	assert.equal(item.subtodos[0].assignee, "me");
	assert.deepEqual(plain(item.subtodos[0].linkedTaskIds), ["t1"]);
	assert.deepEqual(plain(item.source), { kind: "legacy", namespace: "workbench", sourceId: "s1", fingerprint: "fp", rawAvailable: true });
	assert.equal(item.historyCount, 3);
	assert.deepEqual(plain(item.subtodoProgress), { total: 1, done: 0, open: 1, cancelled: 0 });
});

test("缺 root_revision 回退 item revision；两者皆缺不造半条记录", () => {
	const item = parseWireTodo({ id: "todo_a", title: "t", revision: "r1-item", status: "open", linked_task_ids: [], subtodos: [] });
	assert.equal(item.revision, "r1-item");
	assert.equal(parseWireTodo({ id: "todo_a", title: "t", status: "open" }), null);
	assert.equal(parseWireTodo({ title: "t", revision: "r1" }), null);
});

test("subtodo_progress 缺失时按子项状态现算，source 未识别归 unknown", () => {
	const item = parseWireTodo({
		id: "todo_a",
		title: "t",
		root_revision: "r1",
		subtodos: [
			{ id: "s1", title: "a", status: "done" },
			{ id: "s2", title: "b", status: "cancelled" },
			{ id: "s3", title: "c", done: true },
		],
	});
	assert.deepEqual(plain(item.subtodoProgress), { total: 3, done: 2, open: 0, cancelled: 1 });
	assert.equal(item.subtodos[2].status, "done", "旧 done 布尔值兜底");
	assert.equal(item.source.kind, "unknown");
});

test("列表分页与写可用性字段解析", () => {
	const page = parseWireListPage({
		ok: true,
		items: [{ id: "todo_a", title: "t", root_revision: "r1", linked_task_ids: [], subtodos: [] }],
		page: { limit: 50, order: "created_desc", view: "roots", has_more: true, next_cursor: "cur_1", count: 1 },
		write_available: false,
		write_reason: "WRITE_GATE_CLOSED",
	});
	assert.equal(page.nextCursor, "cur_1");
	assert.equal(page.hasMore, true);
	assert.equal(page.writeAvailable, false);
	assert.equal(page.writeReason, "WRITE_GATE_CLOSED");
	assert.equal(parseWireListPage({ ok: true }), null);
});

test("mutate 成功与回执解析", () => {
	const success = parseWireMutateSuccess({
		ok: true,
		replayed: true,
		request_id: "req_1",
		item: { id: "sub_1", title: "子项", root_revision: "r2", parent_id: "todo_a", subtodos: [] },
		root: { id: "todo_a", title: "根项", root_revision: "r2", linked_task_ids: [], subtodos: [] },
		changed: { kind: "subtodo_add", id: "sub_1", parent_id: "todo_a", parent_subtodo_id: "s1" },
	});
	assert.equal(success.replayed, true);
	assert.equal(success.item.id, "sub_1");
	assert.equal(success.root.id, "todo_a");
	assert.equal(success.changedId, "sub_1");
	assert.equal(success.changedKind, "subtodo_add");
	assert.equal(parseWireMutateSuccess({ ok: false }), null);
	const applied = parseWireRequestStatus({ ok: true, state: "applied", item_id: "todo_a", sub_id: null, result: { ok: true, request_id: "req_1", item: { id: "todo_a", title: "t", root_revision: "r3", subtodos: [] }, root: { id: "todo_a", title: "t", root_revision: "r3", subtodos: [] } } });
	assert.equal(applied.state, "applied");
	assert.equal(applied.itemId, "todo_a");
	assert.equal(applied.result.root.revision, "r3");
	assert.equal(parseWireRequestStatus({ ok: true, state: "pending" }).state, "pending");
	assert.equal(parseWireRequestStatus({ ok: true, state: "weird" }).state, "other");
});

test("wire 错误分类：冲突带云端 revision，未启用写入降级，未回显服务端 message", () => {
	const conflict = mapWireError(409, { error: { code: "REVISION_CONFLICT", message: "internal secret text", detail: { current: "r9", draft: "r3" } } });
	assert.equal(conflict.code, "conflict");
	assert.equal(conflict.conflictCurrent, "r9");
	assert.equal(conflict.detail.current, "r9");
	assert.equal(conflict.message.includes("secret"), false, "不回显服务端原文");
	const notEnabled = mapWireError(501, { error: { code: "NOT_ENABLED", message: "off" } });
	assert.equal(notEnabled.code, "writeUnavailable");
	const clientRef = mapWireError(409, { error: { code: "CLIENT_REF_CONFLICT", detail: { item_id: "todo_srv_1" } } });
	assert.equal(clientRef.code, "cloudRejected");
	assert.equal(clientRef.clientRefItemId, "todo_srv_1");
	const incomplete = mapWireError(409, { error: { code: "SUBTODO_INCOMPLETE" } });
	assert.equal(incomplete.code, "cloudRejected");
	assert.equal(incomplete.detail, undefined, "无 detail 时不编造字段");
	const barrier = mapWireError(503, { error: { code: "TASK_DOMAIN_BARRIER" } });
	assert.equal(barrier.code, "writeUnavailable");
	const notSwitched = mapWireError(503, { error: { code: "WRITE_NOT_SWITCHED", detail: { write_available: false } } });
	assert.equal(notSwitched.code, "writeUnavailable", "写门未切换时只留稿");
	assert.equal(notSwitched.wireCode, "WRITE_NOT_SWITCHED");
	assert.equal(mapWireError(500, null).code, "unknownOutcome", "无结构化 body 的 5xx 结果未知");
	assert.equal(mapWireError(500, { error: { code: "INTERNAL" } }).code, "cloudRejected", "服务端明确拒绝不重发");
	assert.equal(mapWireError(400, { error: { code: "BAD_REQUEST", detail: { field: "title" } } }).code, "invalidInput");
});

test("mutate 请求体只带已声明字段，子项文本映射到 title", () => {
	const create = buildMutateBody({ kind: "create", title: "新事项", note: "n", category: "工作", deadline: "2026-10-20", urgency: 1 }, "req_1", "tpa-req_1");
	assert.deepEqual(plain(create), { op: "create", request_id: "req_1", title: "新事项", note: "n", category: "工作", deadline: "2026-10-20", urgency: 1, client_ref: "tpa-req_1" });
	assert.equal("expected_revision" in create, false, "create 不带 CAS 基准");
	const patch = buildMutateBody({ kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { title: "改", deadline: null } }, "req_2", null);
	assert.deepEqual(plain(patch), { op: "patch", request_id: "req_2", expected_revision: "r1", id: "todo_a", fields: { title: "改", deadline: null } });
	const status = buildMutateBody({ kind: "status", id: "todo_a", expectedRevision: "r1", status: "done" }, "req_3", null);
	assert.deepEqual(plain(status), { op: "status", request_id: "req_3", expected_revision: "r1", id: "todo_a", status: "done" });
	const subtodoAdd = buildMutateBody({ kind: "subtodoAdd", id: "todo_a", expectedRevision: "r1", text: "子项", assignee: "me" }, "req_4", null);
	assert.deepEqual(plain(subtodoAdd), { op: "subtodo_add", request_id: "req_4", expected_revision: "r1", id: "todo_a", text: "子项", assignee: "me" });
	const subtodoPatch = buildMutateBody({ kind: "subtodoPatch", id: "todo_a", expectedRevision: "r1", subtodoId: "s1", text: "改名" }, "req_5", null);
	assert.deepEqual(plain(subtodoPatch), { op: "subtodo_patch", request_id: "req_5", expected_revision: "r1", id: "todo_a", sub_id: "s1", fields: { title: "改名" } });
	const subtodoStatus = buildMutateBody({ kind: "subtodoStatus", id: "todo_a", expectedRevision: "r1", subtodoId: "s1", status: "done" }, "req_6", null);
	assert.deepEqual(plain(subtodoStatus), { op: "subtodo_status", request_id: "req_6", expected_revision: "r1", id: "todo_a", sub_id: "s1", status: "done" });
});

test("单条响应兼容 item/root/items 三种外形", () => {
	assert.equal(parseWireItemPayload({ item: { id: "todo_a", title: "t", root_revision: "r1", subtodos: [] } }).id, "todo_a");
	assert.equal(
		parseWireItemPayload({
			items: [
				{ id: "sub", title: "s", root_revision: "r1", parent_id: "root", subtodos: [] },
				{ id: "root", title: "r", root_revision: "r1", is_root: true, subtodos: [] },
			],
		}).id,
		"root",
		"子项视图优先取整族根项",
	);
	assert.equal(parseWireItemPayload({}), null);
});

test("单条响应优先整族 root：子项不得冒充顶层；changed 对象与回执 post-op revision 解析", () => {
	const family = { id: "todo_a", title: "父项", root_revision: "r2", subtodos: [{ id: "sub_1", title: "子", status: "open" }] };
	const sub = { id: "sub_1", title: "子", parent_id: "todo_a", root_revision: "r2", subtodos: [] };
	const parsed = parseWireItemPayload({ item: sub, root: family });
	assert.equal(parsed.id, "todo_a", "整族优先，子项不混顶层");
	assert.equal(parsed.isRoot, true);
	// 旧响应没有 root：只有本身就是根项的 item 才接受（子项不得写进顶层缓存）
	assert.equal(parseWireItemPayload({ item: sub }), null);
	assert.equal(parseWireItemPayload({ item: { ...family, is_root: true } }).id, "todo_a");

	const success = parseWireMutateSuccess({ ok: true, item: sub, root: family, changed: { kind: "subtodo_add", id: "sub_1", parent_id: "todo_a", parent_subtodo_id: "s1" } });
	assert.equal(success.changedId, "sub_1");
	assert.equal(success.changedKind, "subtodo_add");
	assert.equal(success.changedParentId, "todo_a");
	assert.equal(success.changedParentSubtodoId, "s1");
	// 旧响应缺 changed：不猜身份（由调用方按已证实字段回退）
	const legacy = parseWireMutateSuccess({ ok: true, item: sub, root: family });
	assert.equal(legacy.changedId, null);

	const receipt = parseWireRequestStatus({ ok: true, state: "applied", item_id: "todo_a", changed: { kind: "patch", id: "todo_a", parent_id: null, parent_subtodo_id: null }, root_revision_after: "r1" });
	assert.equal(receipt.rootRevisionAfter, "r1", "回执 post-op revision 解析");
	// R1：云端回执是扁平形状（无 result）→ 必须用顶层 item/root/changed 合成同形结果
	const flat = parseWireRequestStatus({
		ok: true,
		state: "applied",
		item_id: "sub_1",
		sub_id: "sub_1",
		root_id: "todo_a",
		changed: { kind: "subtodo_add", id: "sub_1", parent_id: "todo_a", parent_subtodo_id: null },
		item: { id: "sub_1", title: "子", parent_id: "todo_a", root_revision: "r2", subtodos: [] },
		root: { id: "todo_a", title: "父项", root_revision: "r2", subtodos: [{ id: "sub_1", title: "子", status: "open" }] },
		root_revision_after: "r2",
	});
	assert.equal(flat.result?.changedId, "sub_1", "扁平回执合成结果：changed 身份可用");
	assert.equal(flat.result?.root?.id, "todo_a", "root 优先保留");
	assert.equal(flat.result?.item.id, "sub_1");
	assert.equal(flat.rootRevisionAfter, "r2");
	// 连 item 都没有时不合成、不猜身份（由 runner 按回执 sub_id 回退）
	assert.equal(parseWireRequestStatus({ ok: true, state: "applied", item_id: "sub_1", sub_id: "sub_1" }).result, null);
	assert.equal(parseWireRequestStatus({ ok: true, state: "applied", item_id: "todo_a" }).rootRevisionAfter, null, "旧回执缺证据时为 null，不猜");
});

test("真实 transport 单条取回：子项回执的 item 不覆盖顶层，返回整族根项", async () => {
	const { createHttpPersonalTodoTransport } = loadTsCommonJs("src/main/personal-workbench/personalTodoTransport.ts");
	const payload = JSON.stringify({
		ok: true,
		item: { id: "sub_1", title: "子", parent_id: "todo_a", root_revision: "r2", subtodos: [] },
		root: { id: "todo_a", title: "父项", root_revision: "r2", subtodos: [{ id: "sub_1", title: "子", status: "open" }] },
	});
	const transport = createHttpPersonalTodoTransport({
		fetchImpl: async () => ({ status: 200, text: async () => payload }),
	});
	const result = await transport.get({ lease: { origin: "https://cloud.example", token: "t" }, id: "todo_a" });
	assert.equal(result.ok, true);
	assert.equal(result.value.id, "todo_a", "顶层缓存拿到整族根项");
	assert.equal(result.value.isRoot, true);
	assert.equal(result.value.subtodos.length, 1);
});

test("冲突体解析：云端 detail.current 是对象时取 root_revision（keepMine 需要它才能重放）", () => {
	const nested = mapWireError(409, { error: { code: "REVISION_CONFLICT", message: "记录已变化", detail: { current: { root_revision: "r9", item_revision: "i9", updated_at: "2026-10-14T00:00:00.000Z", subtodo_progress: { total: 1, done: 0, open: 1, cancelled: 0 } }, draft: { title: "我的标题" } } } });
	assert.equal(nested.code, "conflict");
	assert.equal(nested.conflictCurrent, "r9", "对象形状 current.root_revision");
	const stringy = mapWireError(409, { error: { code: "REVISION_CONFLICT", detail: { current: "r8" } } });
	assert.equal(stringy.conflictCurrent, "r8", "字符串形状仍兼容");
	const missing = mapWireError(409, { error: { code: "REVISION_CONFLICT", detail: { draft: {} } } });
	assert.equal(missing.conflictCurrent, null, "没有 current 时不猜");
});
