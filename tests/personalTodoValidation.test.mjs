/**
 * 待办 IPC 边界校验窄测（P02）：非法/越界输入一律结构化拒绝，
 * `null`（清空）与「缺省」（不改）语义必须区分。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parsePersonalTodoQuery, parsePersonalTodoResolveConflictInput, parsePersonalTodoRetryInput, parsePersonalTodoSubmitInput } = loadTsCommonJs("src/main/personal-workbench/personalTodoValidation.ts");

/** vm 沙箱里的对象原型与宿主不同；结构比较前先转成宿主普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("create：必填标题、枚举与长度边界", () => {
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "  " } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "x".repeat(501) } }).error.detail.field, "title");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", urgency: 4 } }).error.detail.field, "urgency");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", urgency: 1.5 } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", note: "x".repeat(4001) } }).error.detail.field, "note");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", note: "x".repeat(4000) } }).ok, true, "4000 字是 wire 新写预算上界");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", category: "工作\u0000" } }).ok, false);
	const ok = parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "  保留内部空格  ", note: "第一行\n第二行", deadline: "2026-10-20", urgency: 3 } });
	assert.equal(ok.ok, true);
	assert.equal(ok.input.operation.title, "保留内部空格");
	assert.equal(ok.input.operation.note, "第一行\n第二行", "正文不做 trim、允许换行");
	assert.equal(ok.input.operation.deadline, "2026-10-20", "日期原文不改写");
});

test("patch：null 表示清空、缺省表示不改，空 patch 拒绝", () => {
	const cleared = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { deadline: null } } });
	assert.equal(cleared.ok, true);
	assert.deepEqual(plain(cleared.input.operation.patch), { deadline: null });
	const untouched = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { title: "改" } } });
	assert.equal(Object.hasOwn(untouched.input.operation.patch, "deadline"), false, "缺省字段不进 wire body");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: {} } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", patch: { title: "改" } } }).error.detail.field, "expectedRevision");
});

test("status/subtodo：状态枚举、子项 id 与未知操作类型", () => {
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "status", id: "todo_a", expectedRevision: "r1", status: "archived" } }).error.detail.field, "status");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "subtodoAdd", id: "todo_a", expectedRevision: "r1", text: "" } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "subtodoStatus", id: "todo_a", expectedRevision: "r1", subtodoId: "", status: "done" } }).error.detail.field, "subtodoId");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "delete", id: "todo_a" } }).error.detail.field, "kind", "首版没有删除操作");
	assert.equal(parsePersonalTodoSubmitInput(null).ok, false);
});

test("clientRequestId：格式与长度受限，重试必须复用同一个", () => {
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t" }, clientRequestId: "short" }).error.detail.field, "clientRequestId");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t" }, clientRequestId: "bad id!" }).ok, false);
	const ok = parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t" }, clientRequestId: "req_00000001" });
	assert.equal(ok.input.clientRequestId, "req_00000001");
});

test("查询参数：默认值、越界拒绝与多状态筛选", () => {
	assert.deepEqual(plain(parsePersonalTodoQuery(undefined).query), {});
	const parsed = parsePersonalTodoQuery({ status: "open,done", category: "工作", limit: 50, order: "created_asc", search: "备忘" });
	assert.equal(parsed.ok, true);
	assert.deepEqual(plain(parsed.query.status), ["open", "done"]);
	assert.equal(parsePersonalTodoQuery({ limit: 0 }).ok, false);
	assert.equal(parsePersonalTodoQuery({ limit: 201 }).ok, false);
	assert.equal(parsePersonalTodoQuery({ limit: 10.5 }).ok, false);
	assert.equal(parsePersonalTodoQuery({ status: ["open", "bogus"] }).ok, false);
	assert.equal(parsePersonalTodoQuery({ order: "updated" }).error.detail.field, "order");
	assert.equal(parsePersonalTodoQuery({ deadlineFrom: "2026-10-01", deadlineTo: "2026-10-31" }).query.deadlineTo, "2026-10-31");
});

test("retry 与冲突处理入参", () => {
	assert.deepEqual(plain(parsePersonalTodoRetryInput(undefined).input), {});
	assert.equal(parsePersonalTodoRetryInput({ id: "x".repeat(129) }).ok, false);
	assert.equal(parsePersonalTodoRetryInput({ id: "todo_a" }).input.id, "todo_a");
	assert.equal(parsePersonalTodoResolveConflictInput({ id: "todo_a", choice: "force" }).ok, false);
	assert.deepEqual(plain(parsePersonalTodoResolveConflictInput({ id: "todo_a", choice: "takeCloud" }).input), { id: "todo_a", choice: "takeCloud" });
});

test("note 正文语义：空串可用于清空/新建无备注，前后空白与换行保真，预算与控制字符不变", () => {
	// 空串是合法值（清空/无备注），不能当非法输入拒绝
	const emptyCreate = parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "无备注", note: "" } });
	assert.equal(emptyCreate.ok, true, "新建可以不带备注正文（空串）");
	assert.equal(emptyCreate.input.operation.note, "", "空串按原值保留");
	const emptyPatch = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { note: "" } } });
	assert.equal(emptyPatch.ok, true, "空串可用于清空备注");
	assert.equal(emptyPatch.input.operation.patch.note, "");

	const raw = "  第一行  \n第二行 \n";
	const create = parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", note: raw } });
	assert.equal(create.ok, true);
	assert.equal(create.input.operation.note, raw, "备注必须保留前后空白与换行原字节");
	const patch = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { note: raw } } });
	assert.equal(patch.ok, true);
	assert.equal(patch.input.operation.patch.note, raw, "patch 备注同样保真");
	const subtodoAdd = parsePersonalTodoSubmitInput({ operation: { kind: "subtodoAdd", id: "todo_a", expectedRevision: "r1", text: "子项", note: raw } });
	assert.equal(subtodoAdd.ok, true);
	assert.equal(subtodoAdd.input.operation.note, raw, "子项备注保真");

	// 预算与控制字符仍然守
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", note: "x".repeat(4001) } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "t", note: "合格\u0007正文" } }).ok, false, "控制字符仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1", patch: { note: null } } }).ok, false, "null 不是清空备注的写法（用空串）");
});

test("expectedRevision：空串作为本地链标记可过 IPC 结构层，其它非法形状不放开", () => {
	// 空串：只表示「本账号尚未云端确认的本地 create 链」的本地基准；合法性由 Service 判定
	for (const operation of [
		{ kind: "patch", id: "todo_a", expectedRevision: "", patch: { title: "改名" } },
		{ kind: "status", id: "todo_a", expectedRevision: "", status: "done" },
		{ kind: "subtodoAdd", id: "todo_a", expectedRevision: "", text: "子项" },
		{ kind: "subtodoStatus", id: "todo_a", expectedRevision: "", subtodoId: "sub_1", status: "done" },
	]) {
		const parsed = parsePersonalTodoSubmitInput({ operation });
		assert.equal(parsed.ok, true, `${operation.kind} 的空 expectedRevision 应通过结构校验`);
		assert.equal(parsed.input.operation.expectedRevision, "", "空串按原值传递，不伪造成别的 revision");
	}
	// 其它形状一律不放开
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", patch: { title: "x" } } }).ok, false, "缺字段仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: null, patch: { title: "x" } } }).ok, false, "非 string 仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: 7, patch: { title: "x" } } }).ok, false);
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "   ", patch: { title: "x" } } }).ok, false, "纯空白仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1\u0000", patch: { title: "x" } } }).ok, false, "控制字符仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "x".repeat(257), patch: { title: "x" } } }).error.detail.field, "expectedRevision", "超长仍拒绝");
	assert.equal(parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_a", expectedRevision: "  r1  ", patch: { title: "x" } } }).input.operation.expectedRevision, "r1", "非空值仍按 trim 归一");
});
