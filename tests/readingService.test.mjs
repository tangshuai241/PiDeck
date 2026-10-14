/**
 * 阅读 Service 行为窄测（P03）：真实 client/wire + 假 HTTP + 临时目录。
 * 覆盖：状态/连接（401→needsConnection、密码存储与 cookie）、书库/目录/正文（chapter 参数）、
 * 引文核验、笔记（unsupported、注册守卫、严格 applied、持久化草稿与恢复对账）、位置（版本边界/串行/幂等）、
 * 旧历史（unsupported 与 source-labelled、session/truncated 来自响应）、dispose。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ReadingService } = loadTsCommonJs("src/main/personal-workbench/reading/ReadingService.ts");
const { createReadingHttpClient } = loadTsCommonJs("src/main/personal-workbench/reading/readingHttpClient.ts");
const { ReadingConnectionStore } = loadTsCommonJs("src/main/personal-workbench/reading/readingConnectionStore.ts");
const { resolveReadingPaths } = loadTsCommonJs("src/main/personal-workbench/reading/readingPaths.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function respond(status, json, options = {}) {
	return { status, text: async () => JSON.stringify(json), headers: { get: (name) => (name === "set-cookie" ? (options.setCookie ?? null) : name === "location" ? (options.location ?? null) : null) } };
}

function createFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url);
		calls.push({ method: init.method, path: parsed.pathname, query: parsed.searchParams, headers: init.headers, body: init.body ?? null });
		const handler = routes[`${init.method} ${parsed.pathname}`];
		if (!handler) return respond(404, { ok: false, error: "not found" });
		return handler({ url: parsed, init, calls });
	};
	return { fetchImpl, calls };
}

function harness(t, routes, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-reading-svc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = resolveReadingPaths(dir);
	const { fetchImpl, calls } = createFetch(routes);
	const connection = new ReadingConnectionStore({
		filePath: paths.connectionFile,
		isEncryptionAvailable: () => true,
		protect: (text) => Buffer.from(`enc:${text}`, "utf8"),
		unprotect: (bytes) => Buffer.from(bytes).toString("utf8").replace(/^enc:/, ""),
	});
	// 同一 userData/连接存储上可再起一个 Service：用于验证「重开应用后草稿仍在」
	const makeService = () => {
		const client = createReadingHttpClient({ fetchImpl, timeoutMs: 2000 });
		return { client, service: new ReadingService({ paths, client, connection, now: () => new Date("2026-10-14T00:00:00.000Z"), log: options.log ?? (() => {}) }) };
	};
	const { service, client } = makeService();
	return { dir, paths, service, client, connection, calls, makeService };
}

const catalogOk = () => ({ ok: true, works: [{ work_id: "wrk_a", title: "书一", author: "作者", edition_count: 1, editions: [{ edition_id: "edn_1", rel: "books/a.epub", size: 10, mtime: 1, title: "第一版" }] }] });
const booksOk = () => ({ ok: true, books_dir: "E:/books", books: [{ name: "a.epub", path: "E:/books/a.epub", rel: "books/a.epub", size: 10, mtime: 1, work_id: "wrk_a", edition_id: "edn_1", title: "第一版" }] });
const metaOk = () => ({
	ok: true,
	identity: { filename: "a.epub", size: 10, sha256: "abc", edition_id: "edn_1", content_version: "cv1" },
	toc: [{ pos: 1, href: "ch1.xhtml", title: "第一章", is_chapter: true, chapter_num: 1, map_status: "chapter" }],
	spine: [{ index: 1, href: "ch1.xhtml" }],
	analysis: { found: false },
});
const contentOk = () => ({ ok: true, identity: { content_version: "cv1", edition_id: "edn_1" }, chapter: { chapter_num: 1, title: "第一章", href: "ch1.xhtml", text: "正文", word_count: 2, text_digest: "d1", offset_unit: "unicode_code_point" } });
const baseRoutes = () => ({ "GET /api/catalog": () => respond(200, catalogOk()), "GET /api/books": () => respond(200, booksOk()), "GET /api/books/reader-meta": () => respond(200, metaOk()), "GET /api/books/content": () => respond(200, contentOk()) });

test("初始状态：不探测、不扫书库；能力标志未知，地址为默认回环", async (t) => {
	const h = harness(t, {});
	const status = await h.service.getStatus();
	assert.equal(status.ok, true);
	assert.equal(status.status.availability, "unknown");
	assert.equal(status.status.notesApi, null);
	assert.equal(status.status.historyApi, null);
	assert.equal(status.status.connection.baseUrl, "http://127.0.0.1:18965");
	assert.equal(status.status.connection.credentialStored, false);
	assert.equal(h.calls.length, 0, "构造与 getStatus 都不触网");
});

test("书库/目录/正文：book 用 rel、content 用 chapter；identity/contentVersion 原样", async (t) => {
	const h = harness(t, baseRoutes());
	const library = await h.service.listLibrary();
	assert.equal(library.ok, true);
	assert.equal(library.works[0].editions[0].editionId, "edn_1");
	const edition = await h.service.getEdition("wrk_a", "edn_1");
	assert.equal(edition.ok, true);
	assert.equal(edition.edition.identity.contentVersion, "cv1");
	assert.equal(edition.edition.toc[0].chapterNum, 1);
	const chapter = await h.service.getChapter("wrk_a", "edn_1", 1);
	assert.equal(chapter.ok, true);
	assert.equal(chapter.chapter.text, "正文");
	const contentCall = h.calls.find((call) => call.path === "/api/books/content");
	assert.equal(contentCall.query.get("book"), "books/a.epub", "只传服务端返回的 rel");
	assert.equal(contentCall.query.get("chapter"), "1");
	const status = await h.service.getStatus();
	assert.equal(status.status.availability, "ready", "成功调用后标记 ready");
});

test("未登记版本被拒：只由已登记数据定位", async (t) => {
	const h = harness(t, baseRoutes());
	const edition = await h.service.getEdition("wrk_a", "edn_missing");
	assert.equal(edition.ok, false);
	assert.equal(edition.error.code, "invalidInput");
	assert.equal(edition.error.detail.reason, "notRegistered");
	const mismatched = await h.service.getEdition("wrk_other", "edn_1");
	assert.equal(mismatched.error.detail.reason, "workEditionMismatch");
});

test("服务不可达与 401：分别归 unavailable 与 needsConnection", async (t) => {
	const unreachable = harness(t, {
		"GET /api/catalog": () => {
			throw new Error("offline");
		},
	});
	const result = await unreachable.service.listLibrary();
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "unavailable");
	assert.equal((await unreachable.service.getStatus()).status.availability, "unavailable");
	const unauthorized = harness(t, { "GET /api/catalog": () => respond(401, { ok: false, error: "unauthorized" }) });
	const denied = await unauthorized.service.listLibrary();
	assert.equal(denied.ok, false);
	assert.equal(denied.error.code, "needsConnection");
	const status = await unauthorized.service.getStatus();
	assert.equal(status.status.availability, "needsConnection");
	assert.equal(status.status.connection.authRequired, true);
});

test("连接：登录拿 cookie、密码受保护落盘、requests 带 cookie；断开清除", async (t) => {
	const routes = { ...baseRoutes(), "POST /login": () => respond(303, { ok: true }, { setCookie: "deepread_auth=tok123; Path=/; HttpOnly", location: "/" }) };
	const h = harness(t, routes);
	const connected = await h.service.connect({ baseUrl: "http://127.0.0.1:18965", password: "secret-pw", rememberPassword: true });
	assert.equal(connected.ok, true);
	assert.equal(connected.status.connection.authRequired, true);
	assert.equal(connected.status.connection.credentialStored, true);
	const rawFile = readFileSync(h.paths.connectionFile, "utf8");
	assert.equal(rawFile.includes("secret-pw"), false, "明文密码不落盘");
	assert.equal(rawFile.includes("enc:"), false, "base64 后的密文不含明文标记");
	await h.service.listLibrary();
	const catalogCall = h.calls.find((call) => call.path === "/api/catalog" && call.headers.cookie);
	assert.equal(catalogCall.headers.cookie, "deepread_auth=tok123", "后续请求带 cookie，但不进渲染层");
	const disconnected = await h.service.disconnect();
	assert.equal(disconnected.ok, true);
	assert.equal(disconnected.status.connection.credentialStored, false);
	const afterDisconnect = h.calls.length;
	await h.service.listLibrary();
	const callsAfter = h.calls.slice(afterDisconnect);
	assert.equal(
		callsAfter.every((call) => !call.headers.cookie),
		true,
		"断开后不再带 cookie",
	);
});

test("连接失败与未启用密码的服务：error=1 拒收；无 cookie 重定向视为已连接", async (t) => {
	const rejected = harness(t, { "POST /login": () => respond(303, { ok: false }, { location: "/login?error=1" }) });
	const failed = await rejected.service.connect({ password: "bad", rememberPassword: false });
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "needsConnection");
	assert.equal((await rejected.service.getStatus()).status.connection.credentialStored, false);
	const open = harness(t, { "POST /login": () => respond(303, { ok: true }, { location: "/" }) });
	const connected = await open.service.connect({ password: "ignored", rememberPassword: false });
	assert.equal(connected.ok, true);
	assert.equal(connected.status.connection.authRequired, false, "服务未启用密码");
});

test("笔记：新接口未部署 → unsupported + 失败留稿且重试复用 requestId", async (t) => {
	const h = harness(t, baseRoutes());
	const listed = await h.service.listNotes("wrk_a", "edn_1");
	assert.equal(listed.ok, false);
	assert.equal(listed.error.code, "unsupported");
	assert.equal((await h.service.getStatus()).status.notesApi, false);
	const first = await h.service.writeNote({ operation: { op: "create", workId: "wrk_a", editionId: "edn_1", concept: "概念", understanding: "理解一" } });
	assert.equal(first.ok, false);
	assert.equal(first.error.code, "unsupported");
	assert.equal(first.draft.content, "理解一", "失败留稿：草稿带回输入");
	const retry = await h.service.writeNote({ operation: { op: "create", workId: "wrk_a", editionId: "edn_1", concept: "概念", understanding: "理解一" } });
	assert.equal(retry.draft.requestId, first.draft.requestId, "同载荷重试复用同一 requestId");
	const changed = await h.service.writeNote({ operation: { op: "create", workId: "wrk_a", editionId: "edn_1", concept: "概念", understanding: "理解二" } });
	assert.notEqual(changed.draft.requestId, first.draft.requestId, "载荷变化换新 requestId，避免同 id 异内容冲突");
});

test("笔记：注册读/写（严格 applied）、未登记 noteId 被拒、pending 与无 revision 都保留草稿", async (t) => {
	const writeRoutes = (body) => {
		const content = JSON.parse(body).content;
		if (content === "待确认") return respond(200, { ok: false, request_id: "x", state: "pending", error: { code: "unknownOutcome", message: "x", detail: { reason: "INTENT_PENDING" } } });
		if (content === "缺revision") return respond(200, { ok: true, request_id: "x", state: "applied", note: { noteId: "note_1", name: "概念", revision: null } });
		if (content === "被抢改") return respond(409, { ok: false, error: { code: "staleVersion", message: "x", detail: { reason: "NOTE_REVISION_CONFLICT", current_revision: "sha256:ff" } } });
		return respond(200, { ok: true, request_id: "x", state: "applied", note: { noteId: "note_1", name: "概念", revision: "rev2" } });
	};
	const routes = {
		...baseRoutes(),
		"GET /api/notes/by-work": () =>
			respond(200, { ok: true, notes: [{ noteId: "note_1", name: "概念", chapterLabel: null, revision: "rev1", updatedAt: "2026-10-14T00:00:00Z", linkStatus: "linked" }], unattributed: [{ noteId: "note_x", name: "别的书", chapterLabel: null, revision: null, unlocated: true }], truncated: false }),
		"GET /api/notes/read": () => respond(200, { ok: true, note: { noteId: "note_1", name: "概念", revision: "rev1" }, content: "正文", truncated: false }),
		"POST /api/notes/write": ({ init }) => writeRoutes(init.body),
	};
	const h = harness(t, routes);
	const listed = await h.service.listNotes("wrk_a", "edn_1");
	assert.equal(listed.ok, true);
	assert.equal(listed.notes[0].unlocated, true, "服务端未给 unlocated 且无标签 → 不猜锚点");
	assert.equal(listed.notes[0].linkStatus, "linked");
	assert.equal(listed.unattributed[0].noteId, "note_x", "归属未知单独带回，不合并");
	assert.equal((await h.service.getStatus()).status.notesApi, true);
	const unread = await h.service.readNote("wrk_a", "note_missing");
	assert.equal(unread.error.code, "invalidInput");
	const read = await h.service.readNote("wrk_a", "note_1");
	assert.equal(read.ok, true);
	assert.equal(read.content, "正文");
	const written = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "我的理解", content: "补充", expectedRevision: "rev1" } });
	assert.equal(written.ok, true);
	assert.equal(written.note.revision, "rev2");
	const writeCall = h.calls.filter((call) => call.path === "/api/notes/write").pop();
	const body = JSON.parse(writeCall.body);
	assert.equal(body.note_id, "note_1");
	assert.equal(body.expected_revision, "rev1");
	assert.equal(body.section, "understanding", "中文段落名在发送前归一");
	assert.equal((await h.service.listNoteDrafts()).drafts.length, 0, "applied 后草稿清除");
	// HTTP 200 + ok:false + pending：绝不算已保存
	const pending = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "我的理解", content: "待确认", expectedRevision: "rev2" } });
	assert.equal(pending.ok, false);
	assert.equal(pending.error.code, "unknownOutcome");
	assert.equal(pending.error.detail.reason, "INTENT_PENDING");
	assert.equal(pending.draft.content, "待确认", "未确认结果保留草稿");
	// applied 但没有 revision：同样不算已保存
	const incomplete = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "我的理解", content: "缺revision", expectedRevision: "rev2" } });
	assert.equal(incomplete.ok, false, "applied 但无 revision 不能声称已保存");
	assert.equal(incomplete.error.code, "unknownOutcome");
	// CAS 失败：错误码与原稿都保留（不改写）
	const conflicted = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "我的理解", content: "被抢改", expectedRevision: "rev2" } });
	assert.equal(conflicted.ok, false);
	assert.equal(conflicted.error.code, "staleVersion");
	assert.equal(conflicted.error.detail.current_revision, "sha256:ff");
	assert.equal(conflicted.draft.content, "被抢改");
});

test("笔记：未确认草稿持久化；重开后恢复先对账（applied 清稿 / 无记录重发同 requestId）", async (t) => {
	const writeState = { count: 0 };
	const routes = {
		...baseRoutes(),
		"POST /api/notes/write": () => {
			writeState.count += 1;
			// 首次丢回包（宕机/超时），重开后重发才成功
			if (writeState.count === 1) return respond(503, { ok: false, error: { code: "unavailable", message: "x" } });
			return respond(200, { ok: true, request_id: "x", state: "applied", note: { noteId: "note_1", name: "概念", revision: "rev2" } });
		},
		// 只有服务端明确的 notFound 才证明「原 request 无记录」，才允许原载荷重发
		"GET /api/notes/request": () => respond(404, { ok: false, error: { code: "notFound", message: "没有该 request 记录", detail: { reason: "UNKNOWN" } } }),
	};
	const h = harness(t, routes);
	const sent = await h.service.writeNote({ operation: { op: "create", workId: "wrk_a", editionId: "edn_1", concept: "概念", understanding: "会丢回包" } });
	assert.equal(sent.ok, false);
	assert.equal(sent.draft.content, "会丢回包");
	const firstRequestId = sent.draft.requestId;
	// 重开应用：同一 userData 上新建 Service，草稿仍能从磁盘列出来
	const restarted = h.makeService();
	const drafts = await restarted.service.listNoteDrafts();
	assert.equal(drafts.ok, true);
	assert.equal(drafts.drafts.length, 1);
	assert.equal(drafts.drafts[0].requestId, firstRequestId, "重开保留原 requestId");
	assert.deepEqual(plain(drafts.drafts[0].operation.understanding), "会丢回包", "原 operation 原样保留");
	// 服务端无该 request 记录 → 用原 requestId + 原载荷重发
	const resumed = await restarted.service.resumeNoteDraft({ requestId: firstRequestId });
	assert.equal(resumed.ok, true);
	assert.equal(resumed.requestId, firstRequestId, "重发复用原 requestId");
	const resentCall = h.calls.filter((call) => call.path === "/api/notes/write").pop();
	assert.equal(JSON.parse(resentCall.body).request_id, firstRequestId);
	assert.equal((await restarted.service.listNoteDrafts()).drafts.length, 0, "applied 后清稿");
});

test("笔记：恢复先查 request 台账（只读）；pending 留稿；草稿文件损坏隔离且不静默清稿", async (t) => {
	const routes = {
		...baseRoutes(),
		"POST /api/notes/write": () => respond(503, { ok: false, error: { code: "unavailable", message: "x" } }),
		"GET /api/notes/by-work": () => respond(200, { ok: true, notes: [{ note_id: "note_1", name: "概念", revision: "sha256:00" }] }),
		"GET /api/notes/request": ({ url }) =>
			url.searchParams.get("request_id") === "req_applied"
				? respond(200, { ok: true, request_id: "req_applied", op: "append", state: "applied", replayed: false, note: { noteId: "note_1", name: "概念", revision: "sha256:aa" }, updated_at: "2026-10-14T00:00:00Z" })
				: respond(200, { ok: true, request_id: "req_pending", op: "append", state: "pending", replayed: false, note: null, updated_at: "2026-10-14T00:00:00Z" }),
	};
	const h = harness(t, routes);
	await h.service.listNotes("wrk_a", "edn_1");
	await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "quote", content: "a", expectedRevision: "r" } });
	const draftA = (await h.service.listNoteDrafts()).drafts[0];
	const pendingResume = await h.service.resumeNoteDraft({ requestId: draftA.requestId });
	assert.equal(pendingResume.ok, false);
	assert.equal(pendingResume.error.code, "unknownOutcome");
	assert.equal(pendingResume.error.detail.state, "pending");
	const writesBefore = h.calls.filter((call) => call.path === "/api/notes/write").length;
	assert.equal(writesBefore, 1, "对账阶段只读，不触发重放写");
	// 草稿文件损坏：隔离原件 + issue 上报，不清空输入
	const draftsFile = h.paths.noteDraftsFile;
	writeFileSync(draftsFile, "{坏 JSON");
	const corrupted = h.makeService();
	const listed = await corrupted.service.listNoteDrafts();
	assert.equal(listed.ok, true);
	assert.equal(listed.drafts.length, 0);
	assert.notEqual(listed.issue, null, "损坏必须有 issue，不静默清稿");
	assert.equal(
		readdirSync(h.paths.dataDir).some((name) => name.startsWith("note-drafts.json.corrupt-")),
		true,
		"原件隔离保留",
	);
});

test("能力：结构化 404 notFound 不关闭 notes/history；裸 404 才 unsupported", async (t) => {
	const routes = {
		...baseRoutes(),
		"GET /api/notes/by-work": () => respond(404, { ok: false, error: { code: "notFound", message: "找不到该作品，请先刷新书架", detail: { reason: "UNKNOWN" } } }),
		"GET /api/history/sources": () => respond(404, { ok: false, error: { code: "notFound", message: "旧历史根缺失", detail: { reason: "UNKNOWN" } } }),
	};
	const h = harness(t, routes);
	const notes = await h.service.listNotes("wrk_a", "edn_1");
	assert.equal(notes.ok, false);
	assert.equal(notes.error.code, "notFound", "结构化 notFound 原样透传");
	const history = await h.service.historySources();
	assert.equal(history.error.code, "notFound");
	const status = (await h.service.getStatus()).status;
	assert.notEqual(status.notesApi, false, "结构化 notFound 不得关闭整个 notes 能力");
	assert.notEqual(status.historyApi, false, "结构化 notFound 不得关闭整个 history 能力");
	// 对照：另一个 origin/未部署能力仍按裸 404 判 unsupported（回归保护）
	const missing = harness(t, baseRoutes());
	assert.equal((await missing.service.historySources()).error.code, "unsupported");
	assert.equal((await missing.service.getStatus()).status.historyApi, false);
});

test("恢复：unsupported 不证明未写入，留稿返回且禁止盲 POST；只有显式 notFound 才原载荷重发", async (t) => {
	const routes = {
		...baseRoutes(),
		"POST /api/notes/write": () => respond(503, { ok: false, error: { code: "unavailable", message: "x" } }),
		// /api/notes/request 未部署：裸 404 → unsupported（不证明原写入不存在）
	};
	const h = harness(t, routes);
	const sent = await h.service.writeNote({ operation: { op: "create", workId: "wrk_a", editionId: "edn_1", concept: "概念", understanding: "回包未知" } });
	assert.equal(sent.ok, false);
	const requestId = sent.draft.requestId;
	const writesBefore = h.calls.filter((call) => call.path === "/api/notes/write").length;
	const resumed = await h.service.resumeNoteDraft({ requestId });
	assert.equal(resumed.ok, false);
	assert.equal(resumed.error.code, "unsupported", "对账未部署：如实返回 unsupported，不冒充未写入");
	assert.equal(h.calls.filter((call) => call.path === "/api/notes/write").length, writesBefore, "unsupported 不盲 POST");
	const drafts = await h.service.listNoteDrafts();
	assert.equal(drafts.drafts.length, 1, "未知结果必须留稿");
	assert.equal(drafts.drafts[0].requestId, requestId);
});

test("连接：空密码 + 同 origin 受保护保存 → 用主进程 stored 密码恢复；跨 origin 不发送旧密码", async (t) => {
	const loginBodies = [];
	const logs = [];
	const routes = {
		...baseRoutes(),
		"POST /login": ({ init }) => {
			loginBodies.push(new URLSearchParams(init.body).get("password"));
			return respond(303, { ok: false }, { location: "/", setCookie: "deepread_auth=cookie-token; Path=/" });
		},
	};
	const h = harness(t, routes, { log: (message, details) => logs.push([message, details]) });
	const password = "记忆中的密码";
	const connected = await h.service.connect({ baseUrl: "http://127.0.0.1:18965", password, rememberPassword: true });
	assert.equal(connected.ok, true);
	assert.equal(connected.status.connection.credentialStored, true, "受保护密码已落盘");
	assert.equal(connected.status.connection.rememberPassword, true);
	assert.equal(JSON.stringify(plain(connected)).includes(password), false, "返回值不带密码");
	// 重开应用：同一 userData + 同一 fake safeStorage；getStatus 只读本地、零网络
	const restarted = h.makeService();
	const callsBefore = h.calls.length;
	const status = await restarted.service.getStatus();
	assert.equal(h.calls.length, callsBefore, "getStatus 仍零网络");
	assert.equal(status.status.connection.credentialStored, true, "getStatus 能发现 stored");
	assert.equal(JSON.stringify(plain(status)).includes(password), false);
	// 阅读页打开：空 password 且同 origin + rememberPassword → 用 stored 密码恢复登录
	const restored = await restarted.service.connect({ baseUrl: "http://127.0.0.1:18965", password: "", rememberPassword: true });
	assert.equal(restored.ok, true);
	assert.equal(loginBodies.at(-1), password, "空密码时用主进程 stored 密码登录");
	assert.equal(JSON.stringify(plain(restored)).includes(password), false);
	assert.equal(JSON.stringify(plain(restored)).includes("cookie-token"), false, "cookie 不进返回值");
	// 跨 origin：绝不把旧 origin 的密码发给新 origin
	const other = await restarted.service.connect({ baseUrl: "http://127.0.0.1:18966", password: "", rememberPassword: false });
	assert.equal(other.ok, true);
	assert.equal(loginBodies.at(-1), "", "新 origin 只收到本次空密码，不携带旧密码");
	assert.equal(JSON.stringify(logs).includes(password), false, "日志不打印密码");
	assert.equal(JSON.stringify(logs).includes("cookie-token"), false, "日志不打印 cookie");
});

test("草稿：按服务 origin 隔离；未确认后改内容不覆盖旧 intent，可单独查看与丢弃", async (t) => {
	const routes = {
		...baseRoutes(),
		"POST /login": () => respond(303, { ok: true }, { location: "/" }),
		"GET /api/notes/by-work": () => respond(200, { ok: true, notes: [{ note_id: "note_1", name: "概念", revision: "sha256:00" }] }),
		"POST /api/notes/write": () => respond(503, { ok: false, error: { code: "unavailable", message: "x" } }),
	};
	const h = harness(t, routes);
	await h.service.listNotes("wrk_a", "edn_1");
	const first = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "quote", content: "旧意图", expectedRevision: "r" } });
	assert.equal(first.ok, false);
	const changed = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "quote", content: "新内容", expectedRevision: "r" } });
	assert.notEqual(changed.draft.requestId, first.draft.requestId, "改内容必须新开 requestId");
	const drafts = await h.service.listNoteDrafts();
	assert.equal(drafts.drafts.length, 2, "旧 intent 保留可查看，不被新提交覆盖");
	assert.equal(
		drafts.drafts.some((draft) => draft.content === "旧意图"),
		true,
	);
	assert.equal(
		drafts.drafts.every((draft) => draft.origin === "http://127.0.0.1:18965" && draft.user === "default"),
		true,
		"草稿记录带 origin/user 归属",
	);
	// 同 payload 重交：幂等复用原 requestId，不新增草稿
	const same = await h.service.writeNote({ operation: { op: "append", workId: "wrk_a", editionId: "edn_1", noteId: "note_1", section: "quote", content: "旧意图", expectedRevision: "r" } });
	assert.equal(same.draft.requestId, first.draft.requestId);
	assert.equal((await h.service.listNoteDrafts()).drafts.length, 2, "同载荷不新增草稿");
	// 切到另一个服务 origin：旧草稿不可见，也不会被新服务的提交覆盖
	const connected = await h.service.connect({ baseUrl: "http://127.0.0.1:18966", password: "pw", rememberPassword: false });
	assert.equal(connected.ok, true);
	assert.equal((await h.service.listNoteDrafts()).drafts.length, 0, "换服务后旧 origin 草稿隔离（不被覆盖也不冒充新服务）");
	const back = await h.service.connect({ baseUrl: "http://127.0.0.1:18965", password: "pw", rememberPassword: false });
	assert.equal(back.ok, true);
	// 丢弃只影响指定 requestId
	const discarded = await h.service.discardNoteDraft({ requestId: changed.draft.requestId });
	assert.equal(discarded.ok, true);
	const remaining = await h.service.listNoteDrafts();
	assert.equal(remaining.drafts.length, 1);
	assert.equal(remaining.drafts[0].content, "旧意图");
	const missing = await h.service.resumeNoteDraft({ requestId: changed.draft.requestId });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.detail.reason, "draftNotFound");
});

test("位置：缺失/保存/幂等/版本边界/串行；未登记版本拒收", async (t) => {
	const h = harness(t, baseRoutes());
	const missing = await h.service.getPosition("wrk_a", "edn_1", "cv1");
	assert.deepEqual(plain(missing), { ok: true, position: null, stale: false, reason: "missing" });
	const saved = await h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.3, chapterNum: 1, chapterTextDigest: "d1" });
	assert.equal(saved.ok, true);
	assert.equal(saved.idempotent, false);
	assert.equal(saved.scope.contentVersion, "cv1");
	const again = await h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.3, chapterNum: 1, chapterTextDigest: "d1" });
	assert.equal(again.ok, true);
	assert.equal(again.idempotent, true, "同值幂等");
	const restored = await h.service.getPosition("wrk_a", "edn_1", "cv1");
	assert.equal(restored.position.fraction, 0.3);
	const mismatch = await h.service.getPosition("wrk_a", "edn_1", "cv9");
	assert.deepEqual(plain(mismatch), { ok: true, position: null, stale: true, reason: "versionMismatch" }, "版本不符不套旧 fraction");
	const staleWrite = await h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv9", fraction: 0.9 });
	assert.equal(staleWrite.ok, false);
	assert.equal(staleWrite.error.code, "staleVersion");
	const kept = await h.service.getPosition("wrk_a", "edn_1", "cv1");
	assert.equal(kept.position.fraction, 0.3, "旧内容版本的写入未覆盖当前版本位置");
	await Promise.all([h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.4 }), h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.6 })]);
	const final = await h.service.getPosition("wrk_a", "edn_1", "cv1");
	assert.equal([0.4, 0.6].includes(final.position.fraction), true, "并发写串行后仍是完整记录");
	const unregistered = await h.service.savePosition({ workId: "wrk_a", editionId: "edn_9", contentVersion: "cv1", fraction: 0.5 });
	assert.equal(unregistered.error.code, "invalidInput");
	assert.equal(existsSync(join(h.paths.positionsDir, "edn_1.json")), true);
});

test("旧历史：未部署 → unsupported；部署后只读列表与详情（session/raw/truncated 都来自响应）", async (t) => {
	const missing = harness(t, baseRoutes());
	const unsupported = await missing.service.historySources();
	assert.equal(unsupported.error.code, "unsupported");
	assert.equal((await missing.service.getStatus()).status.historyApi, false);
	const routes = {
		...baseRoutes(),
		"GET /api/history/sources": () =>
			respond(200, {
				ok: true,
				sources: [
					{ source: "deepread-current", label: "当前", root: "E:/state/sessions", count: 31, readable: true },
					{ source: "deepread-legacy", label: "旧树", root: "E:/old/sessions", count: 18, readable: true },
				],
			}),
		"GET /api/history/sessions": () => respond(200, { ok: true, source: "deepread-legacy", sessions: [{ source: "deepread-legacy", id: "s1", title: "会话", book_label: "旧书", chapter_label: null, attribution: "unattributed", provider: "deepread", model: "m", readable: true, error: null }], next_cursor: null }),
		"GET /api/history/session": ({ url }) =>
			url.searchParams.get("id") === "s1"
				? respond(200, { ok: true, session: { source: "deepread-legacy", id: "s1", title: "会话", book_label: "旧书", attribution: "unattributed", readable: true, error: null }, raw: '{"book":"旧书"}', truncated: false, bytes: 16, revision: "sha256:aa" })
				: respond(200, { ok: true, session: { source: "deepread-current", id: "s9", title: "截断的会话", attribution: "bound", readable: true, error: null }, raw: '{"partial":', truncated: true, bytes: 11, revision: "sha256:bb" }),
	};
	const h = harness(t, routes);
	const sources = await h.service.historySources();
	assert.equal(sources.ok, true);
	assert.equal(sources.sources.length, 2);
	assert.equal(sources.sources[1].count, 18, "18 条旧树单独可见，不用数量冒充迁移");
	const list = await h.service.listHistory("deepread-legacy", null, 30);
	assert.equal(list.ok, true);
	assert.equal(list.sessions[0].attribution, "unattributed");
	assert.equal(list.sessions[0].bookLabel, "旧书");
	assert.equal(h.calls.find((call) => call.path === "/api/history/sessions").query.get("source"), "deepread-legacy", "source 必须上送");
	const detail = await h.service.readHistorySession("deepread-legacy", "s1");
	assert.equal(detail.ok, true);
	assert.equal(detail.session.title, "会话", "摘要来自响应，不依赖先前的列表");
	assert.equal(JSON.parse(detail.raw).book, "旧书", "原文原样返回");
	assert.equal(detail.truncated, false);
	assert.equal(
		h.calls
			.filter((call) => call.path === "/api/history/session")
			.pop()
			.query.get("id"),
		"s1",
	);
	const truncated = await h.service.readHistorySession("deepread-current", "s9");
	assert.equal(truncated.ok, true);
	assert.equal(truncated.session.id, "s9", "未先列过也能拿到摘要（服务端保证）");
	assert.equal(truncated.truncated, true, "超上界原样转达，不重序列化");
});

test("dispose：中止客户端，之后调用返回 unavailable", async (t) => {
	const h = harness(t, baseRoutes());
	await h.service.listLibrary();
	h.service.dispose();
	const after = await h.service.getStatus();
	assert.equal(after.ok, true);
	const blocked = await h.service.listLibrary();
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error.code, "unavailable");
	const position = await h.service.savePosition({ workId: "wrk_a", editionId: "edn_1", contentVersion: "cv1", fraction: 0.5 });
	assert.equal(position.ok, false);
	assert.equal(position.error.code, "unavailable");
});
