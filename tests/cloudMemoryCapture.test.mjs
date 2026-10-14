// pi-deck-cloud-memory 采集（-capture / -capture-plan / -capture-store）的针对性测试。
// 内存 fs 端口 + 假注册端口：不碰真实文件系统与网络（真实端口另有单项测试）；视图用固定原生条目工厂构造。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const capture = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-capture.ts");

const SCOPE = { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_11111111-2222-3333-4444-555555555555", stateDir: resolve("C:/fake-home/.pi/agent/cloud-memory") };
const SESSION = "session-1";
const CURSOR_PATH = capture.captureCursorPath(SCOPE.stateDir, SCOPE, SESSION);

/** vm 沙箱对象原型与测试 realm 不同：比较前转成纯 JSON。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function assertPlain(actual, expected, message) {
	assert.deepEqual(plain(actual), expected, message);
}

function createMemoryFsPort() {
	const files = new Map();
	const key = (path) => resolve(String(path));
	return {
		files,
		port: {
			async readText(path, maxBytes) {
				const value = files.get(key(path));
				if (value === undefined) return { kind: "missing" };
				if (Buffer.byteLength(value, "utf8") > maxBytes) return { kind: "invalid", reason: "too_large" };
				return { kind: "ok", text: value };
			},
			async writeAtomic(_dir, finalPath, data) {
				if (Buffer.byteLength(data, "utf8") > capture.RECORD_WRITE_BYTES) throw new Error("write_too_large:test");
				files.set(key(finalPath), data);
			},
			async createExclusive(_dir, finalPath, data) {
				if (files.has(key(finalPath))) return "exists";
				files.set(key(finalPath), data);
				return "created";
			},
			async removeFile(path) {
				files.delete(key(path));
			},
			async listFiles(dir) {
				const prefix = `${key(dir)}${sep}`;
				return [...files.keys()].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
			},
		},
		read: (path) => files.get(key(path)) ?? null,
		write: (path, value) => files.set(key(path), value),
		cursor: () => files.get(key(CURSOR_PATH)) ?? null,
	};
}

/** 固定原生条目工厂：模拟 Pi 的 message 条目视图（入口只取可见 text 块）。 */
function view(input = {}) {
	const blocks = (input.blocks ?? ["hello"]).map((text) => ({ type: "text", text }));
	return capture.buildCaptureView({
		entryId: input.id,
		parentEntryId: input.parent ?? null,
		role: input.role ?? "user",
		textBlocks: blocks,
		occurredAt: input.occurredAt ?? "2026-10-13T00:00:00.000Z",
		changedAt: input.changedAt,
		completion: input.completion ?? "completed",
		visible: input.visible ?? true,
		project: input.project ?? "TPA",
	});
}

/** 假注册端口：sourceId 由「身份字段」派生，便于断言重放同一身份（生产里 D 的 buildSourceId 同理）。 */
function makeRegister(attempts, options = {}) {
	let clock = 0;
	return async (action) => {
		clock += 1;
		const identity = `${action.entryId}|${action.revision}|${action.occurredAt}`;
		attempts.push({ identity, kind: action.kind, visibility: action.visibility, occurredAt: action.occurredAt, revision: action.revision });
		const fail = options.fail?.(action, attempts) ?? false;
		if (fail) return { ok: false, reason: fail === true ? "outbox_unavailable" : fail };
		return { ok: true, sourceId: `src_${identity}`, revision: action.revision, record: { sourceId: `src_${identity}`, revision: action.revision, role: action.role, textBlocks: [...action.textBlocks], visibility: action.visibility } };
	};
}

function controller(fs, attempts, options = {}) {
	let now = 1_700_000_000_000;
	return capture.createCaptureController({
		scope: { accountId: SCOPE.accountId, cloudInstanceId: SCOPE.cloudInstanceId, deviceId: SCOPE.deviceId, stateDir: SCOPE.stateDir },
		sessionId: SESSION,
		register: makeRegister(attempts, options),
		fsPort: fs.port,
		nowIso: () => new Date((now += 1000)).toISOString(),
		...options.controllerOptions,
	});
}

test("基线：session_start 已有历史不回补；只采基线之后的新增可见条目，首 revision 固定 1", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts);
	const begun = await instance.beginSession({ leafId: "e-old", hasHistoryBeforeBaseline: true });
	assert.equal(begun.status, "baseline_created");
	assert.equal(begun.state.lineagePartial, true, "存在未上传的更早历史必须标 lineage_partial");

	const result = await instance.reconcile({ views: [view({ id: "e-old", blocks: ["历史用户消息"] }), view({ id: "e-new", parent: "e-old", blocks: ["新用户消息"] })], leafId: "e-new" });
	assert.equal(result.registered, 1);
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0].identity, "e-new|1|2026-10-13T00:00:00.000Z", "历史不回补，首 revision 固定 1");
	assert.ok(fs.cursor(), "对账后立即落盘（小游标）");
	const cursor = JSON.parse(fs.cursor());
	assert.equal(cursor.version, 2);
	assertPlain(cursor.scope, { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: SCOPE.deviceId });
	assert.equal(cursor.sessionId, SESSION);
	assert.ok(!fs.cursor().includes("新用户消息"), "游标只是 metadata，不含正文");
});

test("逐字保留：多文本块 / 中文换行 / 代码原样，空块丢弃；同名条目在两个新条目上都是 revision 1", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts);
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	await instance.reconcile({
		views: [view({ id: "e-1", blocks: ["第一段：中文换行\n第二行", "```js\nconst a = 1;\n```", ""], role: "assistant", completion: "incomplete" }), view({ id: "e-2", blocks: ["第二条"] })],
		leafId: "e-2",
	});
	assertPlain(
		attempts.map((item) => item.identity),
		["e-1|1|2026-10-13T00:00:00.000Z", "e-2|1|2026-10-13T00:00:00.000Z"],
		"按条目编号：不是全局 floor",
	);
	const recordsDir = join(capture.captureScopeDir(SCOPE.stateDir, SCOPE), "records");
	const stored = (await fs.port.listFiles(recordsDir)).map((file) => JSON.parse(fs.read(join(recordsDir, file))).textBlocks.map((block) => block.text));
	assert.equal(stored.length, 2, `stored=${JSON.stringify(stored)} files=${JSON.stringify(await fs.port.listFiles(recordsDir))}`);
	assert.deepEqual(
		stored.find((blocks) => blocks.length === 2),
		["第一段：中文换行\n第二行", "```js\nconst a = 1;\n```"],
		"空文本块不进原话、正文逐字保留",
	);
});

test("幂等与重启：同一条目不重复登记、不重复生 revision，游标跨控制器复用", async () => {
	const fs = createMemoryFsPort();
	const first = [];
	const instance = controller(fs, first);
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	const views = [view({ id: "e-1", blocks: ["甲"] })];
	await instance.reconcile({ views, leafId: "e-1" });
	await instance.reconcile({ views, leafId: "e-1" });
	assert.equal(first.length, 1, "未变化不得重复登记");

	const restarted = [];
	const revived = controller(fs, restarted);
	const begun = await revived.beginSession({ leafId: "e-1", hasHistoryBeforeBaseline: true });
	assert.equal(begun.status, "restored");
	const run = await revived.reconcile({ views, leafId: "e-1" });
	assert.equal(run.planned, 0);
	assert.equal(restarted.length, 0, "重启后不得重复生成 revision");
});

test("失败重放同一身份：第一条失败、第二条成功，重试仍用同一 revision/occurredAt（同 sourceId 与 hash）", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts, { fail: (action, list) => action.entryId === "e-a" && list.filter((item) => item.identity.startsWith("e-a|")).length === 1 });
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	const views = [view({ id: "e-a", blocks: ["会失败的第一条"] }), view({ id: "e-b", blocks: ["第二条"] })];
	const firstRun = await instance.reconcile({ views, leafId: "e-b" });
	assert.equal(firstRun.failed, 1);
	assert.equal(firstRun.registered, 1, "失败不阻塞同批其它条目");
	const failedAttempt = attempts.find((item) => item.identity.startsWith("e-a|"));

	// 时钟前进（nowIso 每调用 +1s）：重试不得因此换 occurredAt/hash。
	const retryRun = await instance.reconcile({ views, leafId: "e-b" });
	assert.equal(retryRun.registered, 1);
	const retryAttempt = attempts.filter((item) => item.identity.startsWith("e-a|"))[1];
	assert.equal(retryAttempt.identity, failedAttempt.identity, "重试必须同一身份（同 sourceId/hash）");
	assert.equal(retryAttempt.occurredAt, failedAttempt.occurredAt);
});

test("可见性事件重试同 hash：hidden 失败后用同一原生发生时间重放，不生成第二个事件", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts, { fail: (action, list) => action.visibility === "hidden" && list.filter((item) => item.visibility === "hidden").length === 1 });
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["原始文本"] })], leafId: "e-1" });

	const hiddenView = view({ id: "e-1", blocks: ["原始文本"], visible: false, changedAt: "2026-10-13T05:00:00.000Z" });
	const failedRun = await instance.reconcile({ views: [hiddenView], leafId: "e-1" });
	assert.equal(failedRun.failed, 1);
	const firstHidden = attempts.find((item) => item.visibility === "hidden");
	assert.equal(firstHidden.occurredAt, "2026-10-13T05:00:00.000Z", "事件时间取原生 context_edit 时间");

	const retryRun = await instance.reconcile({ views: [hiddenView], leafId: "e-1" });
	assert.equal(retryRun.registered, 1);
	const hiddenAttempts = attempts.filter((item) => item.visibility === "hidden");
	assert.equal(hiddenAttempts.length, 2);
	assert.equal(hiddenAttempts[1].occurredAt, hiddenAttempts[0].occurredAt, "重试必须同一 occurredAt（同 hash）");
});

test("编辑与恢复：revision = 上一条 + 1，targetSourceId 指向上一条；稳定状态下不反复生事件", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts);
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["原始文本"] })], leafId: "e-1" });

	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["编辑后的文本"], changedAt: "2026-10-13T06:00:00.000Z" })], leafId: "e-1" });
	assertPlain(
		attempts.map((item) => item.identity),
		["e-1|1|2026-10-13T00:00:00.000Z", "e-1|2|2026-10-13T06:00:00.000Z"],
		"编辑是上一条 + 1",
	);

	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["编辑后的文本"] })], leafId: "e-1" });
	assert.equal(attempts.length, 2, "稳定状态不得反复生成事件");
});

test("坏游标 fail-closed：解析失败显式阻塞，绝不当成「无历史」重建基线", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	fs.write(CURSOR_PATH, "{ this is not json");
	const instance = controller(fs, attempts);
	const begun = await instance.beginSession({ leafId: "e-old", hasHistoryBeforeBaseline: true });
	assert.equal(begun.status, "blocked");
	assert.equal(begun.reason, "cursor_not_json");
	const run = await instance.reconcile({ views: [view({ id: "e-old" }), view({ id: "e-new", parent: "e-old" })], leafId: "e-new" });
	assert.equal(run.blocked, "cursor_not_json");
	assert.equal(run.registered, 0);
	assert.equal(attempts.length, 0, "游标损坏时不得登记，也不得覆盖成新基线");
	assert.equal(fs.cursor(), "{ this is not json", "坏文件原地保留（恢复证据）");
});

test("初版（未发布）游标保守迁移：条目/基线保留，内嵌 record 写成独立记录文件", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const legacy = {
		version: 1,
		sessionId: SESSION,
		baselineEntryId: "e-old",
		revisionFloor: 3,
		lineagePartial: true,
		trackedTruncated: false,
		updatedAt: "2026-10-13T00:00:00.000Z",
		entries: {
			"e-1": { revision: 2, sourceId: "src_legacy_1", textSha256: capture.sha256Hex("旧文本"), visible: true, updatedAt: "2026-10-13T00:00:00.000Z", record: { sourceId: "src_legacy_1", revision: 2, role: "user", textBlocks: [{ type: "text", text: "旧文本" }], visibility: "visible" } },
		},
	};
	fs.write(CURSOR_PATH, JSON.stringify(legacy));
	const instance = controller(fs, attempts);
	const begun = await instance.beginSession({ leafId: "e-old", hasHistoryBeforeBaseline: true });
	assert.equal(begun.status, "migrated", "初版格式做保守迁移而不是当无历史");
	const cursor = JSON.parse(fs.cursor());
	assert.equal(cursor.version, 2);
	assert.equal(cursor.migratedFrom, 1);
	assert.equal(Object.keys(cursor.entries).length, 1);
	const recordPath = join(capture.captureScopeDir(SCOPE.stateDir, SCOPE), "records", "src_legacy_1.json");
	assert.ok(fs.read(recordPath), "内嵌 record 迁移到独立记录文件");

	// 迁移后编辑仍可用：revision = 上一条 + 1，且能读到迁移过来的原记录。
	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["迁移后编辑"], changedAt: "2026-10-13T07:00:00.000Z" })], leafId: "e-1" });
	assert.equal(attempts[attempts.length - 1].identity, "e-1|3|2026-10-13T07:00:00.000Z");
});

test("scope 绑定：路径含 account+instance+device；游标 scope 不符即阻塞（不跨账号混）", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts);
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	await instance.reconcile({ views: [view({ id: "e-1", blocks: ["甲"] })], leafId: "e-1" });
	assert.ok(CURSOR_PATH.includes("acct_1--inst_1--dev_11111111-2222-3333-4444-555555555555"), `路径必须含 scope 三段: ${CURSOR_PATH}`);

	// 同一游标文件被另一个 scope 打开（设备文件被重建等异常）：显式阻塞，不复用别人的 previousRecord。
	const otherScope = { accountId: "acct_2", cloudInstanceId: "inst_1", deviceId: SCOPE.deviceId, stateDir: SCOPE.stateDir };
	fs.write(capture.captureCursorPath(SCOPE.stateDir, otherScope, SESSION), fs.cursor().replace('"accountId":"acct_1"', '"accountId":"acct_2"'));
	const otherAttempts = [];
	const other = capture.createCaptureController({
		scope: otherScope,
		sessionId: SESSION,
		register: makeRegister(otherAttempts),
		fsPort: fs.port,
		nowIso: () => "2026-10-14T00:00:00.000Z",
	});
	const begun = await other.beginSession({ leafId: "e-1", hasHistoryBeforeBaseline: true });
	assert.equal(begun.status, "restored", "同账号实例换了段目录，互不影响");
	const sameAccountOtherDevice = capture.createCaptureController({
		scope: { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_other", stateDir: SCOPE.stateDir },
		sessionId: SESSION,
		register: makeRegister(otherAttempts),
		fsPort: fs.port,
		nowIso: () => "2026-10-14T00:00:00.000Z",
	});
	// 把 acct_1/inst_1/dev_other 的游标文件写成 dev_1111… 的内容：scope 复核必须拒绝。
	fs.write(capture.captureCursorPath(SCOPE.stateDir, { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_other" }, SESSION), fs.cursor());
	const mismatch = await sameAccountOtherDevice.beginSession({ leafId: "e-1", hasHistoryBeforeBaseline: true });
	assert.equal(mismatch.status, "blocked");
	assert.equal(mismatch.reason, "scope_mismatch");
});

test("写端字节上限：超限记录不落盘并标 recordOmitted，之后 revision 显式阻塞而不是拿错内容", async () => {
	const fs = createMemoryFsPort();
	const attempts = [];
	const instance = controller(fs, attempts);
	await instance.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
	const huge = "x".repeat(capture.RECORD_WRITE_BYTES);
	const run = await instance.reconcile({ views: [view({ id: "e-1", blocks: [huge] })], leafId: "e-1" });
	assert.equal(run.registered, 1);
	assert.equal(run.blocked, "record_unavailable", "超限记录显式上报");
	const cursor = JSON.parse(fs.cursor());
	assert.equal(cursor.entries["e-1"].recordOmitted, true);
	assert.equal(fs.read(join(capture.captureScopeDir(SCOPE.stateDir, SCOPE), "records", "src_e-1|1|2026-10-13T00:00:00.000Z.json")), null, "超限记录不落盘");

	const blocked = await instance.reconcile({ views: [view({ id: "e-1", blocks: ["改后"] })], leafId: "e-1" });
	assert.equal(blocked.blocked, "record_unavailable");
	assert.equal(attempts.length, 1, "记录不可用时禁止生成 revision 事件");
});

test("真实 fs 端口：有界读（stat 只做快速拒绝、超限不整读）、fsync 后落盘、设备 id 复读", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-capture-"));
	try {
		const fsPort = capture.createDefaultCaptureFsPort();
		const devicePath = join(dir, "_local", "device.json");
		const first = await capture.ensureDeviceId({ file: devicePath, fsPort, makeId: () => "11111111-2222-3333-4444-555555555555" });
		assert.equal(first.kind, "ok");
		const reread = await fsPort.readText(devicePath, 1024);
		assert.equal(reread.kind, "ok");
		assert.match(reread.text, /11111111-2222-3333-4444-555555555555/);

		const huge = join(dir, "huge.json");
		await writeFile(huge, "x".repeat(capture.CURSOR_READ_BYTES + 1), "utf8");
		assertPlain(await fsPort.readText(huge, capture.CURSOR_READ_BYTES), { kind: "invalid", reason: "too_large" });
		assertPlain(await fsPort.readText(join(dir, "missing.json"), 1024), { kind: "missing" });

		// 写端上限：超限直接失败，不产生读不回来的文件。
		const over = "y".repeat(capture.RECORD_WRITE_BYTES + 1);
		await assert.rejects(fsPort.writeAtomic(dir, join(dir, "over.json"), over), /write_too_large/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("300KiB 长原话全生命周期（真实 tempfile + 真实 outbox）：采集 → hidden 修订 → 重启回读一致", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-long-"));
	try {
		const bridge = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-bridge.ts");
		const fsPort = capture.createDefaultCaptureFsPort();
		const registrar = bridge.createCaptureRegistrar();
		const scope = { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_11111111-2222-3333-4444-555555555555", stateDir: dir };
		const sessionId = "session-long";
		const longText = ("长原话" + "x".repeat(50) + "\n").repeat(5000); // ≈ 300KiB，远小于队列 16MiB，但大于旧的 256KiB 记录上限
		assert.ok(Buffer.byteLength(longText, "utf8") > 256 * 1024, "用例必须真的超过旧上限");

		const attempts = [];
		function makeController() {
			return capture.createCaptureController({
				scope,
				sessionId,
				register: async (action) => {
					attempts.push({ kind: action.kind, revision: action.revision, occurredAt: action.occurredAt, textSha256: capture.sha256Hex(action.visibleText) });
					return await registrar.register({ ...scope, sessionId }, action);
				},
				fsPort,
				nowIso: () => "2026-10-14T00:00:00.000Z",
			});
		}

		// 1) 采集长原话：记录必须真的写下去（不能 recordOmitted）。
		const first = makeController();
		await first.beginSession({ leafId: null, hasHistoryBeforeBaseline: false });
		const run = await first.reconcile({ views: [view({ id: "e-long", blocks: [longText], changedAt: "2026-10-14T01:00:00.000Z" })], leafId: "e-long" });
		assert.equal(run.registered, 1);
		assert.equal(run.blocked, null, "长原话不得因记录上限被阻塞");
		const cursor = JSON.parse(await readFile(capture.captureCursorPath(dir, scope, sessionId), "utf8"));
		const entry = cursor.entries["e-long"];
		assert.equal(entry.recordOmitted, false);
		const store = capture.createCaptureStore({ stateDir: dir, scope, sessionId, fsPort });
		const stored = await store.readRecord(entry.sourceId);
		assert.equal(stored.textBlocks[0].text.length, longText.length, "300KiB 正文逐字回读");
		assert.equal(capture.sha256Hex(stored.textBlocks.map((block) => block.text).join("\n")), entry.textSha256, "回读哈希与游标一致");

		// 2) 同一会话 hidden 修订：必须能读到长记录并生成同时间戳的可见性事件。
		const second = makeController();
		await second.beginSession({ leafId: "e-long", hasHistoryBeforeBaseline: true });
		const hidden = await second.reconcile({ views: [view({ id: "e-long", blocks: [longText], visible: false, changedAt: "2026-10-14T02:00:00.000Z" })], leafId: "e-long" });
		assert.equal(hidden.registered, 1, "长记录必须支持后续 hidden 修订");
		assert.equal(hidden.blocked, null);
		assert.equal(attempts[1].kind, "revision");
		assert.equal(attempts[1].occurredAt, "2026-10-14T02:00:00.000Z");

		// 3) 再次重启：不重复生成 revision，且游标/记录仍一致。
		const third = makeController();
		await third.beginSession({ leafId: "e-long", hasHistoryBeforeBaseline: true });
		const again = await third.reconcile({ views: [view({ id: "e-long", blocks: [longText], visible: false, changedAt: "2026-10-14T02:00:00.000Z" })], leafId: "e-long" });
		assert.equal(again.planned, 0, "重启后不得重复生成可见性事件");
		assert.equal(attempts.length, 2);

		// 真实 outbox：两条记录（message + hidden revision）都在队列里。
		const queue = await registrar.queue({ ...scope, sessionId });
		const pending = await queue.listPending();
		assert.equal(pending.entries.length, 2, "长原话与其可见性修订都进了真实队列");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
