/**
 * P04 阅读会话绑定 Service 行为测试。
 *
 * 口径：加载真实 ReadingService，替换 HTTP 客户端 / 连接存储 / 会话存在性探针。
 * 断言落在：绑定读写是纯本地操作（不触网）、绑定键与版本对齐、会话不存在时显式报错、
 * 绑定持久化跨实例可解析、stale 判定与解绑结果。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ReadingService } = loadTsCommonJs("src/main/personal-workbench/reading/ReadingService.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function pathsFor(dir) {
	return {
		dataDir: dir,
		connectionFile: join(dir, "connection.json"),
		positionsDir: join(dir, "positions"),
		notesIndexDir: join(dir, "notes-index"),
		noteDraftsFile: join(dir, "note-drafts.json"),
		sessionsDir: join(dir, "sessions"),
	};
}

/** 除书库目录外的所有 HTTP 请求都算「不该发生」：用来证明绑定读写不触网。 */
function createClient(overrides = {}) {
	const unexpected = async () => {
		throw new Error("boundary: binding operations must not touch the network");
	};
	return {
		setBaseUrl() {},
		dispose() {},
		catalog: unexpected,
		listBooks: unexpected,
		getEdition: unexpected,
		getChapter: unexpected,
		resolveQuote: unexpected,
		listNotes: unexpected,
		readNote: unexpected,
		writeNote: unexpected,
		historySources: unexpected,
		listHistory: unexpected,
		readHistorySession: unexpected,
		...overrides,
	};
}

function createConnection() {
	return {
		read: async () => ({ version: 1, baseUrl: "http://127.0.0.1:18965", rememberPassword: false, lastConnectedAt: null }),
		readPassword: () => null,
		write: async () => ({ ok: true }),
		protectPassword: () => null,
	};
}

function libraryPayload() {
	return {
		works: [{ work_id: "w1", title: "测试作品", editions: [{ edition_id: "e1", rel: "book.epub", size: 1, mtime: 0 }] }],
	};
}

function makeService(dir, options = {}) {
	const sessions = new Set(options.sessions ?? ["sess-a"]);
	let calls = 0;
	const service = new ReadingService({
		paths: pathsFor(dir),
		client: createClient(options.clientOverrides),
		connection: createConnection(),
		sessionExists: (sessionId) => {
			calls += 1;
			return sessions.has(sessionId);
		},
		now: () => new Date("2026-10-15T02:00:00.000Z"),
	});
	return {
		service,
		sessions,
		probeCalls: () => calls,
	};
}

test("未绑定时解析：reason=missing，且不触网、不算 stale", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-binding-service-"));
	const { service } = makeService(dir);
	const result = await service.resolveBinding({ workId: "w1", editionId: "e1" });
	assert.deepEqual(plain(result), { ok: true, binding: null, sessionExists: false, stale: false, reason: "missing" });
});

test("绑定未知版本：invalidInput(notRegistered)，不写任何绑定", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-binding-service-"));
	// 书库接口返回不可用 → 版本登记表为空 → requireEdition 拒绝
	const { service } = makeService(dir, { clientOverrides: { catalog: async () => ({ ok: false, error: { code: "unavailable", message: "down" } }) } });
	const result = await service.bindSession({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalidInput");
	assert.equal(result.error.detail?.reason, "notRegistered");
	assert.equal((await service.resolveBinding({ workId: "w1", editionId: "e1" })).reason, "missing");
});

test("绑定目标会话不存在：invalidInput(sessionMissing)，不落绑定", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-binding-service-"));
	const { service } = makeService(dir, { clientOverrides: { catalog: async () => ({ ok: true, json: libraryPayload() }), listBooks: async () => ({ ok: true, json: libraryPayload() }) }, sessions: ["sess-a"] });
	const result = await service.bindSession({ workId: "w1", editionId: "e1", sessionId: "sess-gone", projectId: "proj-1" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalidInput");
	assert.equal(result.error.detail?.reason, "sessionMissing");
	assert.equal((await service.listBindings()).bindings.length, 0);
});

test("绑定成功并跨实例解析；会话删除后 stale=sessionMissing，解绑回到 missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-binding-service-"));
	const clientOverrides = { catalog: async () => ({ ok: true, json: libraryPayload() }), listBooks: async () => ({ ok: true, json: libraryPayload() }) };
	const first = makeService(dir, { clientOverrides });
	const bound = await first.service.bindSession({ workId: "w1", editionId: "e1", sessionId: "sess-a", projectId: "proj-1" });
	assert.equal(bound.ok, true);
	assert.equal(bound.binding.sessionId, "sess-a");

	// 重启主进程：同一目录的新实例仍解析到同一会话
	const reopened = makeService(dir, { clientOverrides });
	const resolved = await reopened.service.resolveBinding({ workId: "w1", editionId: "e1" });
	assert.equal(resolved.ok, true);
	assert.equal(resolved.binding?.sessionId, "sess-a");
	assert.equal(resolved.sessionExists, true);
	assert.equal(resolved.stale, false);
	assert.equal(resolved.reason, "none");

	// 会话被删：绑定保留、明确报 stale，不静默重建
	reopened.sessions.delete("sess-a");
	const stale = await reopened.service.resolveBinding({ workId: "w1", editionId: "e1" });
	assert.equal(stale.binding?.sessionId, "sess-a", "stale 也要把原绑定交还界面供用户确认");
	assert.equal(stale.sessionExists, false);
	assert.equal(stale.stale, true);
	assert.equal(stale.reason, "sessionMissing");

	const listed = await reopened.service.listBindings();
	assert.deepEqual(plain(listed.staleSessionIds), ["sess-a"], "列表必须标出指向已消失会话的绑定");

	const removed = await reopened.service.unbindSession({ workId: "w1", editionId: "e1" });
	assert.deepEqual(plain(removed), { ok: true, removed: true });
	const afterUnbind = await reopened.service.resolveBinding({ workId: "w1", editionId: "e1" });
	assert.equal(afterUnbind.reason, "missing");
});

test("解绑不存在的绑定：成功但 removed=false（不报错打扰用户）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tpa-binding-service-"));
	const { service } = makeService(dir);
	const result = await service.unbindSession({ workId: "w1", editionId: "e9" });
	assert.deepEqual(plain(result), { ok: true, removed: false });
});
