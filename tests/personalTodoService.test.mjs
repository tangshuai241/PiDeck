/**
 * 待办 Service 行为窄测（P02）：入队/确认/重启查回执、冲突留稿、同事项串行、
 * 账号切换迟到归属、父子规则与写入不可用留稿。
 *
 * 用假 transport 与临时目录，不触真实网络/pi/微信；时间与 id 注入确定性实现。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PersonalTodoService } = loadTsCommonJs("src/main/personal-workbench/PersonalTodoService.ts");
const { personalTodoAccountKey } = loadTsCommonJs("src/main/personal-workbench/personalTodoAccount.ts");
const { parseWireTodo } = loadTsCommonJs("src/main/personal-workbench/personalTodoWire.ts");
const { createHttpPersonalTodoTransport } = loadTsCommonJs("src/main/personal-workbench/personalTodoTransport.ts");
const { parsePersonalTodoSubmitInput } = loadTsCommonJs("src/main/personal-workbench/personalTodoValidation.ts");

function wireItem(overrides = {}) {
	return {
		id: "todo_a",
		title: "云端事项",
		note: "",
		category: "工作",
		deadline: "2026-10-20",
		urgency: 0,
		status: "open",
		revision: "r1-item",
		root_revision: "r1-root",
		is_root: true,
		parent_id: null,
		linked_task_ids: [],
		subtodos: [],
		subtodo_progress: { total: 0, done: 0, open: 0, cancelled: 0 },
		source: { kind: "canonical", namespace: null, source_id: null, fingerprint: null, raw_available: null },
		...overrides,
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function offlineFailure(message = "云端不可达") {
	return { ok: false, failure: { code: "offline", message, wireCode: null, httpStatus: null, conflictCurrent: null, clientRefItemId: null } };
}

function failure(code, extra = {}) {
	return { ok: false, failure: { code, message: code, wireCode: extra.wireCode ?? null, httpStatus: extra.httpStatus ?? null, detail: extra.detail, conflictCurrent: extra.conflictCurrent ?? null, clientRefItemId: extra.clientRefItemId ?? null } };
}

function okList(items, extra = {}) {
	// 真实 transport 已把 wire 形状转成域记录；假 transport 保持同一契约（wire→域 在 wire 测试里单独验）
	return { ok: true, value: { items: items.map((item) => parseWireTodo(item)), nextCursor: null, hasMore: false, writeAvailable: null, writeReason: null, ...extra } };
}

function okItem(item) {
	return { ok: true, value: parseWireTodo(item) };
}

function okMutate(item, root = null, changedOrId = null, changedKind = null) {
	// 契约形状：changed:{kind,id,parent_id,parent_subtodo_id}；也兼容旧的 changedId/changedKind 传法
	const changed =
		changedOrId && typeof changedOrId === "object"
			? { changedId: changedOrId.id ?? null, changedKind: changedOrId.kind ?? null, changedParentId: changedOrId.parentId ?? null, changedParentSubtodoId: changedOrId.parentSubtodoId ?? null }
			: { changedId: changedOrId, changedKind, changedParentId: null, changedParentSubtodoId: null };
	return { ok: true, value: { item: parseWireTodo(item), root: root ? parseWireTodo(root) : null, replayed: false, ...changed } };
}

/** 回执（applied）：rootRevisionAfter 是耐久回执里的 post-op 整族 revision（旧回执为 null）。 */
function okReceipt(itemId, result = null, rootRevisionAfter = null, subId = null) {
	return { ok: true, value: { state: "applied", itemId, subId, result, rootRevisionAfter, notFound: false } };
}

async function waitFor(predicate, timeoutMs = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

async function waitForAsync(predicate, timeoutMs = 3000) {
	const start = Date.now();
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() - start > timeoutMs) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function createHarness(script, options = {}) {
	const dir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "pideck-personal-todo-"));
	const calls = { list: [], get: [], mutate: [], receipt: [] };
	const scriptedTransport = {
		async list(request) {
			calls.list.push(request);
			return script.list ? await script.list(request, calls) : okList([]);
		},
		async get(request) {
			calls.get.push(request);
			return script.get ? await script.get(request, calls) : failure("cloudRejected", { wireCode: "ITEM_NOT_FOUND", httpStatus: 404 });
		},
		async mutate(request) {
			calls.mutate.push(request);
			return script.mutate ? await script.mutate(request, calls) : offlineFailure();
		},
		async receipt(request) {
			calls.receipt.push(request);
			return script.receipt ? await script.receipt(request, calls) : failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 });
		},
	};
	// 允许注入真实 transport（wire 级回归需要真实解析路径）；默认用脚本化假 transport
	const transport = options.transport ?? scriptedTransport;
	let identity = "identity" in options ? options.identity : { origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 1 };
	let idSeq = 0;
	const events = [];
	const service = new PersonalTodoService({
		userDataDir: dir,
		auth: {
			getSnapshot: () => (identity ? { ...identity } : null),
			acquireLease: async (expected) => {
				if (!identity) return { ok: false, stale: true, error: { code: "notConfigured", message: "未连接" } };
				return { ok: true, lease: { ...expected, token: "token-not-logged" } };
			},
		},
		transport,
		now: () => new Date("2026-10-14T00:00:00.000Z"),
		onChanged: (event) => events.push(event),
		retryBaseDelayMs: 60_000,
		retryMaxDelayMs: 60_000,
		minRefreshIntervalMs: 0,
		ids: {
			requestId: () => `req_${String(++idSeq).padStart(8, "0")}`,
			localTodoId: () => `todo_local_${String(++idSeq).padStart(8, "0")}`,
			localSubtodoId: () => `sub_local_${String(++idSeq).padStart(8, "0")}`,
		},
	});
	const accountDirOf = (target = identity) => join(dir, "personal-todos", personalTodoAccountKey(target));
	const readJsonOr = (path, fallback) => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return fallback;
		}
	};
	const readOutbox = (target = identity) => readJsonOr(join(accountDirOf(target), "outbox.json"), { operations: [] });
	const readLedger = (target = identity) => readJsonOr(join(accountDirOf(target), "ledger.json"), { entries: [] });
	const readCache = (target = identity) => readJsonOr(join(accountDirOf(target), "cache.json"), { items: [] });
	return {
		dir,
		service,
		calls,
		events,
		accountDirOf,
		readOutbox,
		readLedger,
		readCache,
		setIdentity: (next) => {
			identity = next;
		},
		dispose: (options = {}) => {
			service.dispose();
			if (!options.keepDir) rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("create 先耐久入队，云端确认后清队列并写入台账", async (t) => {
	const harness = createHarness({
		list: () => okList([]),
		mutate: () => okMutate(wireItem({ id: "todo_srv_1", title: "新事项", revision: "r1-item", root_revision: "r1-root" }), wireItem({ id: "todo_srv_1", title: "新事项", root_revision: "r1-root" }), "todo_srv_1", "create"),
	});
	t.after(() => harness.dispose());
	const submitted = await harness.service.submit({ operation: { kind: "create", title: "新事项" } });
	assert.equal(submitted.ok, true);
	assert.equal(submitted.accepted, true);
	assert.equal(harness.readOutbox().operations.length, 1, "受理即已耐久入队");
	const confirmed = await waitFor(() => harness.readOutbox().operations.length === 0 && harness.readLedger().entries.length === 1);
	assert.equal(confirmed, true, "确认后队列清空并写入台账");
	const ledger = harness.readLedger();
	assert.equal(ledger.entries.length, 1);
	assert.equal(ledger.entries[0].itemId, "todo_srv_1");
	assert.equal(ledger.entries[0].kind, "create");
	const cache = harness.readCache();
	assert.deepEqual(
		cache.items.map((item) => item.id),
		["todo_srv_1"],
	);
	const views = harness.service ? await harness.service.list({}) : null;
	assert.equal(views.ok, true);
	assert.equal(views.items[0].sync.phase, "synced");
});

test("离线 create 结果未知：重启后先查同 requestId 回执，不重复创建", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => first.dispose());
	const submitted = await first.service.submit({ operation: { kind: "create", title: "离线事项" } });
	assert.equal(submitted.ok, true);
	const requestId = submitted.requestId;
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true, "离线发送后保留 unknown");
	const localItemId = first.readOutbox().operations[0].itemId;
	first.service.dispose();

	let mutateCalls = 0;
	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => ({ ok: true, value: { state: "applied", itemId: "todo_srv_9", subId: null, result: okMutate(wireItem({ id: "todo_srv_9", title: "离线事项", root_revision: "r9" }), wireItem({ id: "todo_srv_9", title: "离线事项", root_revision: "r9" }), "todo_srv_9", "create").value, notFound: false } }),
			mutate: () => {
				mutateCalls += 1;
				return offlineFailure();
			},
		},
		{ userDataDir: first.dir },
	);
	t.after(() => second.dispose());
	await second.service.getStatus();
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "回执命中即确认");
	assert.equal(mutateCalls, 0, "绝不盲重新 create");
	const ledger = second.readLedger();
	assert.equal(ledger.entries[0].requestId, requestId);
	assert.equal(ledger.entries[0].itemId, "todo_srv_9");
	assert.equal(localItemId.startsWith("todo_local_"), true);
	assert.equal(second.readCache().items[0].id, "todo_srv_9");
});

test("回执 404 时用同一 requestId 与 client_ref 安全重发", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => first.dispose());
	const submitted = await first.service.submit({ operation: { kind: "create", title: "重发事项" } });
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true);
	const firstBody = first.calls.mutate[0];
	first.service.dispose();

	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
			mutate: () => okMutate(wireItem({ id: "todo_srv_10", title: "重发事项", root_revision: "r10" }), wireItem({ id: "todo_srv_10", title: "重发事项", root_revision: "r10" }), "todo_srv_10", "create"),
		},
		{ userDataDir: first.dir },
	);
	t.after(() => second.dispose());
	await second.service.getStatus();
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "安全重发后确认");
	const resendBody = second.calls.mutate[0];
	assert.equal(resendBody.body.request_id, submitted.requestId, "复用同一 requestId");
	assert.equal(resendBody.body.client_ref, firstBody.body.client_ref, "复用同一 client_ref");
	assert.equal(firstBody.body.request_id, submitted.requestId);
});

test("回执 applied 但无原结果时按 item_id 拉当前云端快照确认", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => first.dispose());
	await first.service.submit({ operation: { kind: "create", title: "无结果回执" } });
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true);
	first.service.dispose();
	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => ({ ok: true, value: { state: "applied", itemId: "todo_srv_11", subId: null, result: null, notFound: false } }),
			get: () => okItem(wireItem({ id: "todo_srv_11", title: "无结果回执", root_revision: "r11" })),
			mutate: () => offlineFailure(),
		},
		{ userDataDir: first.dir },
	);
	t.after(() => second.dispose());
	await second.service.getStatus();
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "回执身份 + 当前快照即确认");
	assert.equal(second.readLedger().entries[0].itemId, "todo_srv_11");
	assert.equal(second.readCache().items[0].revision, "r11");
});

test("CAS 冲突保留草稿与云端版本，keepMine 用云端最新 revision 重放", async (t) => {
	// 假服务端：list/get/mutate 始终反映同一份当前状态（真云端不会让两个只读入口互相矛盾）
	let serverItem = wireItem({ title: "云端事项", revision: "r1-item", root_revision: "r1-root" });
	const harness = createHarness({
		list: () => okList([serverItem]),
		mutate: (request) => {
			if (request.body.expected_revision === "r1-root") {
				// 其它写入（另一端）已把云端推到 r2：本次 CAS 必然失败
				serverItem = wireItem({ title: "云端标题", revision: "r2-item", root_revision: "r2-root" });
				return failure("conflict", { wireCode: "REVISION_CONFLICT", httpStatus: 409, detail: { current: "r2-root" }, conflictCurrent: "r2-root" });
			}
			serverItem = wireItem({ title: request.body.fields.title, revision: "r3-item", root_revision: "r3-root" });
			return okMutate(serverItem, serverItem, serverItem.id, "patch");
		},
		get: () => okItem(serverItem),
	});
	t.after(() => harness.dispose());
	assert.equal((await harness.service.list({})).ok, true);
	const submitted = await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "我的标题" } } });
	assert.equal(submitted.ok, true);
	const conflicted = await waitFor(() => harness.events.some((event) => event.reason === "conflict"));
	assert.equal(conflicted, true);
	const view = await harness.service.get("todo_a");
	assert.equal(view.ok, true);
	assert.equal(view.item.sync.phase, "conflict");
	const refreshed = await waitForAsync(async () => {
		const current = await harness.service.get("todo_a");
		return current.ok && current.item.confirmed?.title === "云端标题";
	});
	assert.equal(refreshed, true, "云端版本可见");
	const conflictedView = await harness.service.get("todo_a");
	assert.equal(conflictedView.item.draft.title, "我的标题", "草稿保留");
	assert.equal(conflictedView.item.confirmed.title, "云端标题");
	assert.equal(conflictedView.item.sync.cloudRevision, "r2-root");
	const resolved = await harness.service.resolveConflict({ id: "todo_a", choice: "keepMine" });
	assert.equal(resolved.ok, true);
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 1), true, "重放后确认");
	const replayBody = harness.calls.mutate[1];
	assert.equal(replayBody.body.expected_revision, "r2-root", "以云端最新 revision 重基线");
	assert.equal(replayBody.body.fields.title, "我的标题");
});

test("同一事项串行执行，并在前一条确认后重基线后续 revision", async (t) => {
	const gate = deferred();
	const harness = createHarness({
		list: () => okList([wireItem({ revision: "r1-item", root_revision: "r1-root" })]),
		mutate: async (request) => {
			if (request.body.request_id.endsWith("0001")) {
				await gate.promise;
				return okMutate(wireItem({ title: "第一版", root_revision: "r2-root" }), wireItem({ title: "第一版", root_revision: "r2-root" }), "todo_a", "patch");
			}
			return okMutate(wireItem({ title: "第二版", root_revision: "r3-root" }), wireItem({ title: "第二版", root_revision: "r3-root" }), "todo_a", "patch");
		},
	});
	t.after(() => harness.dispose());
	await harness.service.list({});
	await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "第一版" } } });
	await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "第二版" } } });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(harness.calls.mutate.length, 1, "第一条在飞时第二条不发");
	const { operations } = harness.readOutbox();
	assert.equal(operations.length, 2);
	assert.equal(operations[0].opId, "req_00000001");
	assert.equal(operations[0].phase, "sending");
	assert.equal(operations[1].phase, "pending");
	gate.resolve();
	assert.equal(await waitFor(() => harness.calls.mutate.length === 2), true, "第一条完成后发第二条");
	assert.equal(harness.calls.mutate[1].body.expected_revision, "r2-root", "后续操作重基线到最新已确认 revision");
	assert.equal(await waitFor(() => harness.readOutbox().operations.length === 0), true);
});

test("切换账号后旧账号迟到响应不写进新账号，旧队列留在旧账号目录", async (t) => {
	const gate = deferred();
	const harness = createHarness({
		list: () => okList([]),
		mutate: async () => {
			await gate.promise;
			return okMutate(wireItem({ id: "todo_srv_late", title: "迟到事项", root_revision: "r-late" }), wireItem({ id: "todo_srv_late", title: "迟到事项", root_revision: "r-late" }), "todo_srv_late", "create");
		},
	});
	t.after(() => harness.dispose());
	const first = await harness.service.submit({ operation: { kind: "create", title: "迟到事项" } });
	assert.equal(first.ok, true);
	const oldIdentity = { origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 1 };
	await waitFor(() => harness.calls.mutate.length === 1);
	harness.setIdentity({ origin: "https://cloud.example", account: "other", cloudInstanceId: "inst2", configEpoch: 2 });
	harness.service.handleIdentityMayHaveChanged();
	await new Promise((resolve) => setTimeout(resolve, 20));
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 40));
	const status = await harness.service.getStatus();
	assert.equal(status.ok, true);
	assert.equal(status.status.scope.account, "other");
	assert.equal(status.status.summary.confirmedRecent, 0, "迟到确认不写进新账号");
	assert.equal(await waitFor(() => readdirSync(join(harness.dir, "personal-todos")).length === 2), true, "两个账号各自一个目录");
	const otherIdentity = { origin: "https://cloud.example", account: "other", cloudInstanceId: "inst2" };
	const newCachePath = join(harness.accountDirOf(otherIdentity), "cache.json");
	const newOutboxPath = join(harness.accountDirOf(otherIdentity), "outbox.json");
	assert.throws(() => readFileSync(newCachePath, "utf8"), /ENOENT/, "新账号没有旧账号缓存");
	assert.throws(() => readFileSync(newOutboxPath, "utf8"), /ENOENT/, "新账号没有旧账号队列");
	const oldOutbox = harness.readOutbox(oldIdentity);
	assert.equal(oldOutbox.operations.length, 1, "旧账号操作仍在自己的队列里（不丢）");
	assert.equal(oldOutbox.operations[0].itemId.startsWith("todo_local_"), true);
});

test("父项存在未完成子待办时拒绝完成，不入队", async (t) => {
	const root = wireItem({
		subtodos: [{ id: "legacy_sub_1", title: "子项", note: "", status: "open", assignee: null, linked_task_ids: [] }],
		subtodo_progress: { total: 1, done: 0, open: 1, cancelled: 0 },
	});
	const harness = createHarness({ list: () => okList([root]), mutate: () => offlineFailure() });
	t.after(() => harness.dispose());
	await harness.service.list({});
	const result = await harness.service.submit({ operation: { kind: "status", id: "todo_a", expectedRevision: "r1-root", status: "done" } });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "cloudRejected");
	assert.equal(result.error.detail.reason, "SUBTODO_INCOMPLETE");
	assert.equal(existsSync(join(harness.accountDirOf(), "outbox.json")), false, "拒绝时不落任何队列");
});

test("云端写入未启用时保留草稿并显示未切换，不谎称已保存", async (t) => {
	const harness = createHarness({
		list: () => okList([]),
		mutate: () => failure("writeUnavailable", { wireCode: "WRITE_NOT_SWITCHED", httpStatus: 503 }),
	});
	t.after(() => harness.dispose());
	const submitted = await harness.service.submit({ operation: { kind: "create", title: "只留稿" } });
	assert.equal(submitted.ok, true);
	assert.equal(await waitFor(() => harness.readOutbox().operations[0]?.lastError?.code === "writeUnavailable"), true);
	const status = await harness.service.getStatus();
	assert.equal(status.status.write.available, false);
	assert.equal(status.status.write.reason, "WRITE_NOT_SWITCHED");
	assert.equal(status.status.write.verified, true);
	const views = await harness.service.list({});
	assert.equal(views.items[0].sync.phase, "pending", "草稿保留为待传，不显示已保存");
	assert.equal(views.items[0].item.title, "只留稿");
	const retried = await harness.service.retry({});
	assert.equal(retried.ok, true);
	assert.equal(harness.readOutbox().operations.length, 1);
});

test("装载发现队列损坏：如实展示告警与隔离路径，隔离后可继续提交", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-personal-todo-corrupt-"));
	const identity = { origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1" };
	const accountDir = join(dir, "personal-todos", personalTodoAccountKey(identity));
	mkdirSync(accountDir, { recursive: true });
	const raw = "{ broken queue";
	writeFileSync(join(accountDir, "outbox.json"), raw, "utf8");
	const harness = createHarness({ list: () => okList([]), mutate: () => offlineFailure() }, { userDataDir: dir });
	t.after(() => harness.dispose());
	const status = await harness.service.getStatus();
	assert.equal(status.ok, true);
	assert.equal(status.status.lastError.code, "internalError", "损坏必须如实报出，不伪装成空队列");
	assert.equal(status.status.lastError.detail.file, "outbox");
	const quarantined = readdirSync(accountDir).filter((name) => name.startsWith("outbox.json.corrupt-"));
	assert.equal(quarantined.length, 1, "损坏原件已隔离保留");
	assert.equal(readFileSync(join(accountDir, quarantined[0]), "utf8"), raw, "隔离文件保留原 bytes");
	const submitted = await harness.service.submit({ operation: { kind: "create", title: "损坏后仍可写" } });
	assert.equal(submitted.ok, true, "隔离成功后可以重新入队");
	const after = await harness.service.getStatus();
	assert.notEqual(after.status.lastError?.detail?.file, "outbox", "成功写回后清除队列告警");
});

test("离线 create 链：确认前可继续编辑与加子项；确认后按服务端 id 与 post-op revision 发出，且从不发出本地身份", async (t) => {
	const bodies = [];
	let writable = false;
	const harness = createHarness({
		list: () => okList([]),
		mutate: (request) => {
			bodies.push(request.body);
			if (!writable) return failure("writeUnavailable", { wireCode: "WRITE_NOT_SWITCHED", httpStatus: 503 });
			const body = request.body;
			if (body.op === "create") {
				const item = wireItem({ id: "todo_srv_c1", title: body.title, revision: "r-c1-item", root_revision: "r-c1" });
				return okMutate(item, item, { kind: "create", id: "todo_srv_c1" });
			}
			if (body.op === "patch") {
				const item = wireItem({ id: "todo_srv_c1", title: body.fields.title, revision: "r-c2-item", root_revision: "r-c2" });
				return okMutate(item, item, { kind: "patch", id: "todo_srv_c1" });
			}
			if (body.op === "subtodo_add") {
				const root = wireItem({ id: "todo_srv_c1", title: "离线新事项（改名后）", revision: "r-c3-item", root_revision: "r-c3", subtodos: [{ id: "sub_srv_1", title: body.text, status: "open", parent_id: "todo_srv_c1" }] });
				return okMutate(wireItem({ id: "sub_srv_1", title: body.text, parent_id: "todo_srv_c1", is_root: false, root_revision: "r-c3" }), root, { kind: "subtodo_add", id: "sub_srv_1", parentId: "todo_srv_c1" });
			}
			return failure("cloudRejected", { wireCode: "ITEM_NOT_FOUND", httpStatus: 404 });
		},
	});
	t.after(() => harness.dispose());
	const created = await harness.service.submit({ operation: { kind: "create", title: "离线新事项" } });
	assert.equal(created.ok, true);
	const localId = harness.readOutbox().operations[0].itemId;
	assert.equal(localId.startsWith("todo_local_"), true);

	// 写门关闭期间：编辑与加子项都必须受理（修复前是 invalidInput「找不到该事项」）
	const edited = await harness.service.submit({ operation: { kind: "patch", id: localId, expectedRevision: "", patch: { title: "离线新事项（改名后）" } } });
	assert.equal(edited.ok, true, JSON.stringify(edited));
	const added = await harness.service.submit({ operation: { kind: "subtodoAdd", id: localId, expectedRevision: "", text: "离线子项" } });
	assert.equal(added.ok, true, JSON.stringify(added));
	const outbox = harness.readOutbox().operations;
	assert.equal(outbox.length, 3);
	assert.deepEqual(
		outbox.map((op) => op.baseRevision),
		[null, "", ""],
	);

	// 本地链同样按父子规则：有未完成子项不能完成父项
	const blocked = await harness.service.submit({ operation: { kind: "status", id: localId, expectedRevision: "", status: "done" } });
	assert.equal(blocked.ok, false, "离线链的父项完成仍受父子规则约束");
	assert.equal(harness.readOutbox().operations.length, 3, "被规则挡下不入队");

	// 云端恢复写入：确认 create 后按服务端 id 与 post-op revision 依次发出 patch / subtodo_add
	writable = true;
	await harness.service.retry({});
	assert.equal(await waitFor(() => harness.readOutbox().operations.length === 0), true, JSON.stringify(harness.readOutbox()));
	const mine = bodies.filter((body) => body.op !== "create");
	assert.deepEqual(
		mine.map((body) => body.op),
		["patch", "subtodo_add"],
	);
	assert.equal(mine[0].id, "todo_srv_c1", "确认后改用服务端 id");
	assert.equal(mine[0].expected_revision, "r-c1", "用 post-op revision 重基线");
	assert.equal(mine[1].id, "todo_srv_c1");
	assert.equal(mine[1].expected_revision, "r-c2");
	assert.equal(
		bodies.every((body) => body.op === "create" || (typeof body.expected_revision === "string" && body.expected_revision.length > 0)),
		true,
		"绝不把本地空/假 revision 发出",
	);
	assert.equal(
		bodies.some((body) => JSON.stringify(body).includes("todo_local_") || JSON.stringify(body).includes("sub_local_")),
		false,
		"绝不把本地身份发出",
	);
});

test("子项新增确认后把后续操作重映射到服务端 sub id；changed 缺失时按已证实字段回退", async (t) => {
	for (const useChangedObject of [true, false]) {
		let addCalls = 0;
		const harness = createHarness({
			list: () => okList([wireItem({ id: "todo_a", title: "父项", revision: "r1-item", root_revision: "r1-root" })]),
			mutate: (request) => {
				const body = request.body;
				if (body.op === "subtodo_add") {
					addCalls += 1;
					if (addCalls === 1) return offlineFailure();
					const root = wireItem({ id: "todo_a", title: "父项", root_revision: "r2-root", subtodos: [{ id: "sub_srv_9", title: body.text, status: "open", parent_id: "todo_a" }] });
					const sub = wireItem({ id: "sub_srv_9", title: body.text, parent_id: "todo_a", is_root: false, root_revision: "r2-root" });
					return okMutate(sub, root, useChangedObject ? { kind: "subtodo_add", id: "sub_srv_9", parentId: "todo_a" } : null);
				}
				if (body.op === "subtodo_patch") {
					const root = wireItem({ id: "todo_a", title: "父项", root_revision: "r3-root", subtodos: [{ id: "sub_srv_9", title: "改过的子项", status: "open", parent_id: "todo_a" }] });
					return okMutate(root, root, { kind: "subtodo_patch", id: "sub_srv_9", parentId: "todo_a" });
				}
				return offlineFailure();
			},
			receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
		});
		t.after(() => harness.dispose());
		await harness.service.list({});
		const added = await harness.service.submit({ operation: { kind: "subtodoAdd", id: "todo_a", expectedRevision: "r1-root", text: "子项" } });
		assert.equal(added.ok, true);
		assert.equal(await waitFor(() => harness.calls.mutate.length === 1), true);
		const localSubId = harness.readOutbox().operations[0].localSubtodoId;
		assert.equal(localSubId.startsWith("sub_local_"), true);
		// 确认前用本地子项 id 排队编辑
		const patched = await harness.service.submit({ operation: { kind: "subtodoPatch", id: "todo_a", expectedRevision: "r1-root", subtodoId: localSubId, text: "改过的子项" } });
		assert.equal(patched.ok, true);
		await harness.service.retry({});
		assert.equal(await waitFor(() => harness.readOutbox().operations.length === 0), true, JSON.stringify(harness.readOutbox()));
		const patchBody = harness.calls.mutate.map((call) => call.body).find((body) => body.op === "subtodo_patch");
		assert.equal(patchBody.sub_id, "sub_srv_9", `子项确认后必须改用服务端 sub id（changed 对象=${useChangedObject}）`);
		assert.equal(patchBody.expected_revision, "r2-root", "确认后重基线到 post-op revision");
		assert.equal(
			harness.calls.mutate.some((call) => JSON.stringify(call.body).includes("sub_local_")),
			false,
			"本地子项 id 不外发",
		);
	}
});

test("回执恢复拿不到 post-op 证据时不自动重基线：保留冲突，绝不跳到当前 revision", async (t) => {
	// 别端并发：op1（title）云端已 applied 但本机未知；期间别端改了 note → 当前 r2，回执 post-op 是 r1
	let serverNote = "别端的备注";
	let serverTitle = "别端之前";
	const harness = createHarness({
		list: () => okList([wireItem({ id: "todo_a", title: serverTitle, note: "别端之前的备注", revision: "r1-item", root_revision: "r1-root" })]),
		mutate: (request) => {
			const body = request.body;
			// op1（改标题）第一次发出就丢结果：本机只能按未知处理（云端其实已生效，产生 r1）
			if (body.fields && body.fields.title !== undefined) return offlineFailure();
			if (body.expected_revision !== "r2-root") {
				return failure("conflict", { wireCode: "REVISION_CONFLICT", httpStatus: 409, detail: { current: "r2-root" }, conflictCurrent: "r2-root" });
			}
			if (body.fields && body.fields.title !== undefined) serverTitle = body.fields.title;
			if (body.fields && body.fields.note !== undefined) serverNote = body.fields.note;
			const item = wireItem({ id: "todo_a", title: serverTitle, note: serverNote, root_revision: "r3-root" });
			return okMutate(item, item, { kind: "patch", id: "todo_a" });
		},
		receipt: () => okReceipt("todo_a", null, "r1-root"),
		get: () => okItem(wireItem({ id: "todo_a", title: "我的标题", note: serverNote, revision: "r2-item", root_revision: "r2-root" })),
	});
	t.after(() => harness.dispose());
	await harness.service.list({});
	harness.calls.mutate.length = 0;
	const op1 = await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "我的标题" } } });
	assert.equal(op1.ok, true);
	assert.equal(await waitFor(() => harness.readOutbox().operations[0]?.phase === "unknown"), true);
	const op2 = await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { note: "我的备注" } } });
	assert.equal(op2.ok, true);
	await harness.service.retry({});
	assert.equal(await waitFor(() => harness.readOutbox().operations[0]?.phase === "conflict"), true, JSON.stringify(harness.readOutbox()));
	const op2Body = harness.calls.mutate.map((call) => call.body).find((body) => body.fields && body.fields.note !== undefined);
	assert.equal(op2Body.expected_revision, "r1-root", "只能用有证据的基准；不得跳到当前 r2");
	assert.equal(serverNote, "别端的备注", "别端的修改不被静默覆盖");
	const view = await harness.service.get("todo_a");
	assert.equal(view.item.sync.phase, "conflict");
	assert.equal(view.item.draft.note, "我的备注", "草稿保留");
	assert.equal(view.item.confirmed.note, "别端的备注", "云端版本可见");
});

test("回执恢复有 post-op 证据（与当前 revision 相等）时才重基线", async (t) => {
	const harness = createHarness({
		list: () => okList([wireItem({ id: "todo_a", title: "旧标题", revision: "r1-item", root_revision: "r1-root" })]),
		mutate: (request) => {
			const body = request.body;
			if (body.op === "patch" && body.fields.title !== undefined) return offlineFailure();
			if (body.fields && body.fields.note !== undefined) {
				const item = wireItem({ id: "todo_a", title: "我的标题", note: body.fields.note, root_revision: "r3-root" });
				return okMutate(item, item, { kind: "patch", id: "todo_a" });
			}
			return offlineFailure();
		},
		receipt: () => okReceipt("todo_a", null, "r2-root"),
		get: () => okItem(wireItem({ id: "todo_a", title: "我的标题", revision: "r2-item", root_revision: "r2-root" })),
	});
	t.after(() => harness.dispose());
	await harness.service.list({});
	harness.calls.mutate.length = 0;
	await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { title: "我的标题" } } });
	assert.equal(await waitFor(() => harness.readOutbox().operations[0]?.phase === "unknown"), true);
	await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r1-root", patch: { note: "我的备注" } } });
	await harness.service.retry({});
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 2), true, JSON.stringify(harness.readOutbox()));
	assert.equal(harness.readOutbox().operations.length, 0);
	const noteBody = harness.calls.mutate.map((call) => call.body).find((body) => body.fields && body.fields.note !== undefined);
	assert.equal(noteBody.expected_revision, "r2-root", "post-op 证据等值 → 可重基线");
});

/**
 * 假云端（wire 级，形状照 workbench-cloud/src/personal-todos.js）：
 * 只实现本回归用到的 list / mutate / requests / items 四个入口。
 * `subtodo_add` 先把变更落进服务端状态，再抛连接错——模拟「请求已生效但响应丢失」。
 */
function createFakeCloud() {
	const hits = { mutateOps: [], subtodoPatchSubIds: [], patchExpectedRevisions: [], receiptReads: 0, itemReads: 0, notFound: 0 };
	const subs = new Map();
	let rootRevision = "r-before";
	let receipt = null;
	const source = { kind: "canonical", namespace: null, source_id: null, fingerprint: null, raw_available: null };
	const subView = (sub) => ({ id: sub.id, title: sub.title, note: null, status: sub.status, assignee: null, linked_task_ids: [], revision: `r-item-${sub.id}`, parent_id: "todo_a", parent_subtodo_id: null, created_at: null, updated_at: null, source });
	const rootView = () => ({
		id: "todo_a",
		title: "父项",
		note: null,
		category: null,
		deadline: null,
		urgency: null,
		status: "open",
		revision: "r-item-root",
		root_revision: rootRevision,
		is_root: true,
		parent_id: null,
		parent_subtodo_id: null,
		linked_task_ids: [],
		subtodos: [...subs.values()].map(subView),
		subtodo_progress: { total: subs.size, done: 0, open: subs.size, cancelled: 0 },
		source,
		created_at: null,
		updated_at: null,
		history_count: 0,
	});
	const json = (status, payload) => ({ status, text: async () => JSON.stringify(payload) });
	const fetchImpl = async (input, init) => {
		const path = input.replace("https://cloud.example", "");
		if (init.method === "GET" && path.startsWith("/api/cloud/personal-todos/v1/items?")) {
			return json(200, { ok: true, items: [rootView()], page: { has_more: false, next_cursor: null }, write_available: true, write_reason: null });
		}
		if (init.method === "GET" && path.startsWith("/api/cloud/personal-todos/v1/requests/")) {
			hits.receiptReads += 1;
			if (!receipt) return json(404, { error: { code: "REQUEST_NOT_FOUND", message: "没有该 request_id 的服务端事实" } });
			return json(200, receipt);
		}
		if (init.method === "GET" && path.startsWith("/api/cloud/personal-todos/v1/items/")) {
			hits.itemReads += 1;
			const id = decodeURIComponent(path.split("/items/")[1]);
			const sub = subs.get(id);
			if (!sub) return json(404, { error: { code: "ITEM_NOT_FOUND", message: "待办不存在" } });
			return json(200, { ok: true, item: subView(sub), root: rootView() });
		}
		if (init.method === "POST" && path === "/api/cloud/personal-todos/v1/mutate") {
			const body = JSON.parse(init.body);
			hits.mutateOps.push(body.op);
			if (body.op === "subtodo_add") {
				const id = "sub_srv_1";
				subs.set(id, { id, title: body.text, status: "open" });
				rootRevision = "r-after";
				receipt = {
					ok: true,
					state: "applied",
					op: "subtodo_add",
					request_id: body.request_id,
					item_id: id,
					sub_id: id,
					root_id: "todo_a",
					changed: { kind: "subtodo_add", id, parent_id: "todo_a", parent_subtodo_id: null },
					item: subView(subs.get(id)),
					root: rootView(),
					at: "2026-10-14T00:00:00.000Z",
					root_revision_after: "r-after",
				};
				// 请求已生效、响应丢失 → 客户端只能按未知处理
				throw new Error("connection reset by peer");
			}
			if (body.op === "subtodo_patch") {
				hits.subtodoPatchSubIds.push(body.sub_id);
				hits.patchExpectedRevisions.push(body.expected_revision);
				if (String(body.sub_id).startsWith("sub_local_")) {
					hits.notFound += 1;
					return json(404, { error: { code: "SUBTODO_NOT_FOUND", message: "子项不存在或不是子项" } });
				}
				const sub = subs.get(body.sub_id);
				sub.title = body.fields.text;
				rootRevision = "r-after-2";
				return json(200, {
					ok: true,
					replayed: false,
					request_id: body.request_id,
					op: "subtodo_patch",
					item: subView(sub),
					root: rootView(),
					item_revision: `r-item-${sub.id}`,
					root_revision: rootRevision,
					changed: { kind: "subtodo_patch", id: sub.id, parent_id: "todo_a", parent_subtodo_id: null },
				});
			}
			return json(400, { error: { code: "BAD_REQUEST", message: `op 不支持：${body.op}` } });
		}
		return json(404, { error: { code: "ITEM_NOT_FOUND", message: `未知路径 ${path}` } });
	};
	return { fetchImpl, hits };
}

test("回执腿身份映射（R1）：扁平 applied 回执无 result 也能重映射子项 id、不把本地 sub id 外发", async (t) => {
	const cloud = createFakeCloud();
	const transport = createHttpPersonalTodoTransport({ fetchImpl: cloud.fetchImpl });
	const first = createHarness({}, { transport });
	t.after(() => first.dispose());
	await first.service.list({});
	const added = await first.service.submit({ operation: { kind: "subtodoAdd", id: "todo_a", expectedRevision: "r-before", text: "子项" } });
	assert.equal(added.ok, true, JSON.stringify(added));
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true);
	const localSubId = first.readOutbox().operations[0].localSubtodoId;
	assert.equal(localSubId.startsWith("sub_local_"), true);
	const patched = await first.service.submit({ operation: { kind: "subtodoPatch", id: "todo_a", expectedRevision: "r-before", subtodoId: localSubId, text: "改过的子项" } });
	assert.equal(patched.ok, true, JSON.stringify(patched));
	first.service.dispose();

	// 重启：先查回执（扁平 applied、无 result）→ 已证实服务端 sub id 重映射后续 patch
	const second = createHarness({}, { transport, userDataDir: first.dir });
	t.after(() => second.dispose());
	await second.service.getStatus();
	await second.service.retry({});
	// 以台账条数为完成判据：确认里先清队列后写台账，存在极短窗口
	assert.equal(await waitFor(() => second.readLedger().entries.length === 2), true, JSON.stringify(second.readOutbox()));
	assert.equal(second.readOutbox().operations.length, 0);
	assert.equal(cloud.hits.receiptReads >= 1, true);
	assert.deepEqual(cloud.hits.subtodoPatchSubIds, ["sub_srv_1"], "patch 必须用回执已证实的服务端 sub id");
	assert.equal(cloud.hits.notFound, 0, "不得出现 SUBTODO_NOT_FOUND");
	assert.equal(cloud.hits.patchExpectedRevisions[0], "r-after", "CAS 用原提交后的证据版本，不跳到当前 revision");
	assert.deepEqual(
		second.readCache().items.map((item) => item.id),
		["todo_a"],
		"根缓存仍是父项，子项不混顶层",
	);
	assert.deepEqual(
		second.readCache().items[0].subtodos.map((sub) => sub.id),
		["sub_srv_1"],
	);
	assert.equal(second.readLedger().entries.length, 2, "add 与 patch 各一条确认");
});

test("create 确认事件带回 local→server 身份映射，渲染层据此迁移占位", async (t) => {
	const harness = createHarness({
		list: () => okList([]),
		mutate: () => okMutate(wireItem({ id: "todo_srv_1", title: "新建", root_revision: "r1" }), wireItem({ id: "todo_srv_1", title: "新建", root_revision: "r1" }), { kind: "create", id: "todo_srv_1" }),
	});
	t.after(() => harness.dispose());
	const submitted = await harness.service.submit({ operation: { kind: "create", title: "新建" } });
	assert.equal(submitted.ok, true);
	const localId = harness.readOutbox().operations[0].itemId;
	assert.equal(localId.startsWith("todo_local_"), true);
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 1), true);
	const mapped = harness.events.find((event) => Array.isArray(event.identityRemap) && event.identityRemap.length > 0);
	assert.ok(mapped, "确认事件必须带上身份映射（否则渲染层会留下本地占位幽灵行）");
	assert.deepEqual(JSON.parse(JSON.stringify(mapped.identityRemap)), [{ from: localId, to: "todo_srv_1" }], "映射是明确的 old→new，不靠标题猜");
	assert.equal(
		mapped.items.some((view) => view.item.id === "todo_srv_1"),
		true,
	);
});

test("冲突 keepMine：用 409 回执里的最新家族版本重放原稿（不再二次 409）", async (t) => {
	// 真实 transport + 假 HTTP：409 体照云端真形状（detail.current 是对象）——契约/线形状都要过解析
	const json = (status, payload) => ({ status, text: async () => JSON.stringify(payload) });
	let serverTitle = "别端改过的标题";
	let serverRevision = "r2-root";
	const bodies = [];
	const fetchImpl = async (input, init) => {
		const path = input.replace("https://cloud.example", "");
		if (init.method === "GET" && path.startsWith("/api/cloud/personal-todos/v1/items?")) {
			return json(200, {
				ok: true,
				items: [
					{
						id: "todo_a",
						title: serverTitle,
						note: null,
						category: null,
						deadline: null,
						urgency: null,
						status: "open",
						revision: "r-item",
						root_revision: serverRevision,
						is_root: true,
						parent_id: null,
						linked_task_ids: [],
						subtodos: [],
						subtodo_progress: { total: 0, done: 0, open: 0, cancelled: 0 },
						source: { kind: "canonical", namespace: null, source_id: null, fingerprint: null, raw_available: null },
						created_at: null,
						updated_at: null,
					},
				],
				page: { has_more: false, next_cursor: null },
				write_available: true,
				write_reason: null,
			});
		}
		if (init.method === "GET" && path.startsWith("/api/cloud/personal-todos/v1/items/")) {
			return json(200, {
				ok: true,
				item: { id: "todo_a", title: serverTitle, note: null, status: "open", revision: "r-item", root_revision: serverRevision, subtodos: [] },
				root: { id: "todo_a", title: serverTitle, note: null, status: "open", revision: "r-item", root_revision: serverRevision, is_root: true, subtodos: [] },
			});
		}
		if (init.method === "POST" && path === "/api/cloud/personal-todos/v1/mutate") {
			const body = JSON.parse(init.body);
			bodies.push(body);
			if (body.expected_revision !== serverRevision) {
				return json(409, { error: { code: "REVISION_CONFLICT", message: "记录已变化，请刷新后重试", detail: { current: { root_revision: serverRevision, item_revision: "r-item", updated_at: null, subtodo_progress: { total: 0, done: 0, open: 0, cancelled: 0 } }, draft: body.fields } } });
			}
			serverTitle = body.fields.title;
			serverRevision = "r3-root";
			return json(200, {
				ok: true,
				replayed: false,
				request_id: body.request_id,
				op: "patch",
				item: { id: "todo_a", title: serverTitle, revision: "r-item3", root_revision: serverRevision, subtodos: [] },
				root: { id: "todo_a", title: serverTitle, revision: "r-item3", root_revision: serverRevision, is_root: true, subtodos: [] },
				changed: { kind: "patch", id: "todo_a", parent_id: null, parent_subtodo_id: null },
			});
		}
		return json(404, { error: { code: "ITEM_NOT_FOUND", message: `未知路径 ${path}` } });
	};
	const transport = createHttpPersonalTodoTransport({ fetchImpl });
	const harness = createHarness({}, { transport });
	t.after(() => harness.dispose());
	await harness.service.list({}); // 缓存先看到 r2-root
	serverRevision = "r2b-root"; // 别端再改一次（缓存落后）
	const submitted = await harness.service.submit({ operation: { kind: "patch", id: "todo_a", expectedRevision: "r2-root", patch: { title: "我的标题" } } });
	assert.equal(submitted.ok, true, JSON.stringify(submitted));
	assert.equal(await waitFor(() => harness.events.some((event) => event.reason === "conflict")), true);
	const conflicted = harness.readOutbox().operations[0];
	assert.equal(conflicted.phase, "conflict");
	assert.equal(conflicted.conflictRevision, "r2b-root", "必须从 detail.current.root_revision 解出最新家族版本");
	// 冲突面板要能并列云端真版本（缓存被刷新）
	const view = await harness.service.get("todo_a");
	assert.equal(view.item.sync.phase, "conflict");
	assert.equal(view.item.confirmed.revision, "r2b-root", "confirmed 应是刷新后的云端版本（DTO 的 revision 即整族 revision）");
	assert.equal(view.item.draft.title, "我的标题", "草稿保留");
	await harness.service.resolveConflict({ id: "todo_a", choice: "keepMine" });
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 1), true, "keepMine 后必须写入成功（不再 409）");
	const replay = bodies[bodies.length - 1];
	assert.equal(replay.expected_revision, "r2b-root", "重放用云端最新家族版本");
	assert.equal(replay.fields.title, "我的标题", "重放的是同一份原稿");
});

test("离线 create 链走真实 IPC 校验：空 expectedRevision 受理，但只对本账号待传的真实 create 生效", async (t) => {
	let writable = false;
	const bodies = [];
	const harness = createHarness({
		list: () => okList([wireItem({ id: "todo_confirmed", title: "已确认事项", revision: "r1-item", root_revision: "r1-root" })]),
		mutate: (request) => {
			bodies.push(request.body);
			if (!writable) return failure("writeUnavailable", { wireCode: "WRITE_NOT_SWITCHED", httpStatus: 503 });
			const body = request.body;
			if (body.op === "create") {
				const item = wireItem({ id: "todo_srv_c9", title: body.title, root_revision: "r-c9" });
				return okMutate(item, item, { kind: "create", id: "todo_srv_c9" });
			}
			if (body.op === "patch") {
				const item = wireItem({ id: "todo_srv_c9", title: body.fields.title, root_revision: "r-c10" });
				return okMutate(item, item, { kind: "patch", id: "todo_srv_c9" });
			}
			return failure("cloudRejected", { wireCode: "ITEM_NOT_FOUND", httpStatus: 404 });
		},
	});
	t.after(() => harness.dispose());
	await harness.service.list({});

	// 1) 真实 IPC 解析 → 真实 submit：离线 create 受理并留下待传链
	const createParsed = parsePersonalTodoSubmitInput({ operation: { kind: "create", title: "离线新事项" } });
	assert.equal(createParsed.ok, true);
	assert.equal((await harness.service.submit(createParsed.input)).ok, true);
	const localId = harness.readOutbox().operations[0].itemId;
	assert.equal(localId.startsWith("todo_local_"), true);

	// 2) 关键边界：未确认期间带空 revision 的编辑，经 IPC 解析后必须受理
	const patchParsed = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: localId, expectedRevision: "", patch: { title: "离线改名" } } });
	assert.equal(patchParsed.ok, true, "IPC 结构层必须放行本地链的空 revision");
	assert.equal((await harness.service.submit(patchParsed.input)).ok, true, "Service 认可本账号待传 create 链");
	assert.equal(harness.readOutbox().operations.length, 2);

	// 3) 空 revision 不能靠前缀/伪造 id 通行：任意本地形状 id 仍被 Service 拒
	const fakeParsed = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_local_forged", expectedRevision: "", patch: { title: "伪造" } } });
	assert.equal(fakeParsed.ok, true, "结构层不看前缀");
	const fakeSubmit = await harness.service.submit(fakeParsed.input);
	assert.equal(fakeSubmit.ok, false, "伪造本地 id 不得通行");
	assert.equal(harness.readOutbox().operations.length, 2, "拒绝时不入队");

	// 4) 已确认事项带空 revision 仍拒绝（不能用空 revision 冒充 CAS 基准）
	const confirmedParsed = parsePersonalTodoSubmitInput({ operation: { kind: "patch", id: "todo_confirmed", expectedRevision: "", patch: { title: "改已确认事项" } } });
	assert.equal(confirmedParsed.ok, true);
	const confirmedSubmit = await harness.service.submit(confirmedParsed.input);
	assert.equal(confirmedSubmit.ok, false, "已确认事项必须带真实 revision");
	assert.equal(harness.readOutbox().operations.length, 2);

	// 5) 恢复写入后：真实 id 映射与 post-op revision/CAS 语义不变
	writable = true;
	await harness.service.retry({});
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 2), true, JSON.stringify(harness.readOutbox()));
	const patchBody = bodies.find((body) => body.op === "patch");
	assert.equal(patchBody.id, "todo_srv_c9", "确认后改用服务端 id");
	assert.equal(patchBody.expected_revision, "r-c9", "重基线到 post-op revision");
	assert.equal(
		bodies.some((body) => JSON.stringify(body).includes("todo_local_")),
		false,
		"本地 id 不外发",
	);
});

test("启动恢复：resumePending 装载当前身份并补发离线队列，复用同一 request_id 与 client_ref", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => rmSync(first.dir, { recursive: true, force: true }));
	const submitted = await first.service.submit({ operation: { kind: "create", title: "启动待补发" } });
	assert.equal(submitted.ok, true);
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true, "离线发送后保留 unknown");
	const queued = first.readOutbox().operations[0];
	assert.equal(queued.requestId, submitted.requestId);
	first.service.dispose();

	const sent = [];
	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
			mutate: (request) => {
				sent.push(request.body);
				const item = wireItem({ id: "todo_resumed", title: "启动待补发", root_revision: "r-resume" });
				return okMutate(item, item, { kind: "create", id: "todo_resumed" });
			},
		},
		{ userDataDir: first.dir },
	);
	t.after(() => second.dispose());
	await second.service.resumePending();
	assert.equal(await waitFor(() => sent.length === 1), true, "启动恢复必须补发");
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "确认后写入台账");
	assert.equal(second.readOutbox().operations.length, 0, "确认后队列清空");
	assert.equal(sent[0].request_id, queued.requestId, "补发必须复用原 request_id");
	assert.equal(sent[0].client_ref, queued.clientRef, "补发必须复用原 client_ref");
	assert.equal(second.readLedger().entries.length, 1);
	assert.equal(second.readCache().items[0].id, "todo_resumed");
});

test("启动竞态：身份未就绪时 resumePending 不发送也不报错，身份就绪后只发当前账号队列", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => rmSync(first.dir, { recursive: true, force: true }));
	await first.service.submit({ operation: { kind: "create", title: "等身份" } });
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true);
	first.service.dispose();

	const sent = [];
	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
			mutate: (request) => {
				sent.push(request.body);
				const item = wireItem({ id: "todo_after_identity", title: "等身份", root_revision: "r-id" });
				return okMutate(item, item, { kind: "create", id: "todo_after_identity" });
			},
		},
		{ userDataDir: first.dir, identity: null },
	);
	t.after(() => second.dispose());
	await second.service.resumePending();
	assert.equal(sent.length, 0, "身份未就绪不得发送");
	assert.equal((await second.service.getStatus()).ok, false, "未连接时状态如实返回 notConnected");
	second.setIdentity({ origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 2 });
	await second.service.resumePending();
	assert.equal(await waitFor(() => sent.length === 1), true, "身份就绪后补发当前账号队列");
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "确认后写入台账");
});

test("身份隔离：resumePending 不会把旧账号队列发到新账号，旧队列原样留在旧目录", async (t) => {
	const accountA = { origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 1 };
	const accountB = { origin: "https://cloud.example", account: "other", cloudInstanceId: "inst1", configEpoch: 2 };
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() }, { identity: accountA });
	t.after(() => rmSync(first.dir, { recursive: true, force: true }));
	await first.service.submit({ operation: { kind: "create", title: "A 的离线事项" } });
	assert.equal(await waitFor(() => first.readOutbox(accountA).operations[0]?.phase === "unknown"), true);
	first.service.dispose();

	const sent = [];
	const second = createHarness(
		{
			list: () => okList([]),
			mutate: (request) => {
				sent.push(request.body);
				return offlineFailure();
			},
		},
		{ userDataDir: first.dir, identity: accountB },
	);
	t.after(() => second.dispose());
	await second.service.resumePending();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(sent.length, 0, "B 身份不得触发 A 的队列");
	assert.equal(second.readOutbox(accountA).operations.length, 1, "A 的队列必须原样保留");
	assert.equal(second.readOutbox(accountB).operations.length, 0);
});

test("重复触发：并发 resumePending 只发一次，队列清空后不再发", async (t) => {
	const first = createHarness({ list: () => okList([]), mutate: () => offlineFailure() });
	t.after(() => rmSync(first.dir, { recursive: true, force: true }));
	const submitted = await first.service.submit({ operation: { kind: "create", title: "只发一次" } });
	assert.equal(await waitFor(() => first.readOutbox().operations[0]?.phase === "unknown"), true);
	const queued = first.readOutbox().operations[0];
	assert.equal(queued.requestId, submitted.requestId);
	first.service.dispose();

	const gate = deferred();
	let sent = 0;
	const second = createHarness(
		{
			list: () => okList([]),
			receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
			mutate: async () => {
				sent += 1;
				await gate.promise;
				const item = wireItem({ id: "todo_once", title: "只发一次", root_revision: "r-once" });
				return okMutate(item, item, { kind: "create", id: "todo_once" });
			},
		},
		{ userDataDir: first.dir },
	);
	t.after(() => second.dispose());
	await Promise.all([second.service.resumePending(), second.service.resumePending()]);
	assert.equal(await waitFor(() => sent === 1), true, "并发恢复只允许一个在飞发送");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent, 1, "重复触发不得产生第二次发送");
	gate.resolve();
	assert.equal(await waitFor(() => second.readLedger().entries.length === 1), true, "确认后写入台账");
	assert.equal(second.readOutbox().operations.length, 0);
	await second.service.resumePending();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent, 1, "队列清空后恢复不得再发");
});

test("页面读取唤起待传队列：list 让 unknown 操作立即重试，不新造 request_id", async (t) => {
	let online = false;
	const harness = createHarness({
		list: () => okList([]),
		receipt: () => failure("cloudRejected", { wireCode: "REQUEST_NOT_FOUND", httpStatus: 404 }),
		mutate: (request) => {
			if (!online) return offlineFailure();
			const item = wireItem({ id: "todo_wake", title: "网络恢复", root_revision: "r-wake" });
			return okMutate(item, item, { kind: "create", id: "todo_wake" });
		},
	});
	t.after(() => harness.dispose());
	const submitted = await harness.service.submit({ operation: { kind: "create", title: "网络恢复" } });
	assert.equal(await waitFor(() => harness.readOutbox().operations[0]?.phase === "unknown"), true);
	const attemptsBefore = harness.calls.mutate.length;
	online = true;
	await harness.service.list({});
	assert.equal(await waitFor(() => harness.calls.mutate.length === attemptsBefore + 1), true, "页面读取应唤起待传队列");
	assert.equal(await waitFor(() => harness.readLedger().entries.length === 1), true, "确认后写入台账");
	assert.equal(harness.calls.mutate.at(-1).body.request_id, submitted.requestId, "唤起不得新造 request_id");
});
