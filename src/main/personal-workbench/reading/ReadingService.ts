/**
 * 阅读 Service（P03）：DeepRead 适配 + TPA 本地阅读位置 + 笔记注册索引与失败留稿。
 *
 * 职责边界：
 * - 只经主进程 HTTP 客户端访问回环 DeepRead（renderer 不 fetch、不碰路径/URL）；
 * - 「按需启动」：构造不做任何网络/扫描；只有 IPC 调用才触达服务与书库；
 * - 书库/版本/章节只由服务端登记数据定位（registry 由 listLibrary 建立），不接受任意路径；
 * - 位置是 TPA 本地主账（按 edition+work+contentVersion），写入按版本串行且版本不符不覆盖；
 * - 笔记主账仍在 DeepRead：本节点只按 noteId 引用、维护本地注册索引；
 *   未确认草稿（原 operation + 原 requestId）原子落盘，只有服务端 `state:"applied"` + revision 才算已保存；
 * - 契约新增接口未部署时返回 unsupported（不假数据、不旁路文件系统）；
 * - dispose 中止在飞请求、清串行链；generation 守卫丢弃关闭/切换后的迟到结果。
 */

import type {
	ReadingBindSessionInput,
	ReadingBindingListResult,
	ReadingBindingMutationResult,
	ReadingBindingRef,
	ReadingBindingResolveResult,
	ReadingChapterResult,
	ReadingConnectInput,
	ReadingEdition,
	ReadingEditionResult,
	ReadingErrorInfo,
	ReadingHistoryListResult,
	ReadingHistorySessionResult,
	ReadingHistorySourceName,
	ReadingHistorySourcesResult,
	ReadingLibraryResult,
	ReadingNoteDraftActionResult,
	ReadingNoteDraftListResult,
	ReadingNoteDraftRef,
	ReadingNoteDraftResumeResult,
	ReadingNoteListResult,
	ReadingNoteReadResult,
	ReadingNoteWriteInput,
	ReadingNoteWriteResult,
	ReadingPosition,
	ReadingPositionGetResult,
	ReadingPositionSaveInput,
	ReadingPositionSaveResult,
	ReadingQuoteResult,
	ReadingServiceStatus,
	ReadingStatusResult,
	ReadingUnbindResult,
	ReadingWork,
} from "../../../shared/types/reading";
import { READING_DEFAULT_BASE_URL } from "../../../shared/types/reading";
import type { ReadingConnectionPersisted, ReadingConnectionStore } from "./readingConnectionStore";
import type { ReadingHttpClient } from "./readingHttpClient";
import type { ReadingHttpResult } from "./readingHttpClientTypes";
import { ReadingNoteDraftStore } from "./readingNoteDrafts";
import { ReadingNoteIndexStore } from "./readingNoteIndexStore";
import { ReadingNoteWriter } from "./readingNoteWriter";
import { ReadingPositionStore } from "./ReadingPositionStore";
import { ReadingSessionBindingsStore } from "./readingSessionBindings";
import type { ReadingPaths } from "./readingPaths";
import { readingOriginOf } from "./readingValidation";
import { parseWireChapter, parseWireEditionView, parseWireHistoryList, parseWireHistorySessionDetail, parseWireHistorySources, parseWireLibrary, parseWireNoteList, parseWireNoteRead, parseWireQuote } from "./readingWire";

export type ReadingServiceDeps = {
	paths: ReadingPaths;
	client: ReadingHttpClient;
	connection: ReadingConnectionStore;
	/**
	 * 会话存在性检查（装配层注入 SessionCatalog 查询，不直接依赖会话域）。
	 * 缺失时一律当「不存在」：宁可报 stale 让用户显式重绑，也不把材料送进未知会话。
	 */
	sessionExists?: (sessionId: string) => boolean | Promise<boolean>;
	now?: () => Date;
	log?: (message: string, details?: Record<string, unknown>) => void;
};

type EditionRegistryEntry = { edition: ReadingEdition; workId: string };
type HandledResult = { ok: true; result: Extract<ReadingHttpResult, { ok: true }> } | { ok: false; error: ReadingErrorInfo };

function internalError(message: string, detail?: ReadingErrorInfo["detail"]): ReadingErrorInfo {
	return detail ? { code: "internalError", message, detail } : { code: "internalError", message };
}

function invalidInput(message: string, field: string, reason?: string): ReadingErrorInfo {
	return { code: "invalidInput", message, detail: reason ? { field, reason } : { field } };
}

export class ReadingService {
	private readonly deps: ReadingServiceDeps;
	private readonly positionStore: ReadingPositionStore;
	private readonly noteIndexStore: ReadingNoteIndexStore;
	private readonly noteWriter: ReadingNoteWriter;
	private readonly bindings: ReadingSessionBindingsStore;
	private readonly editions = new Map<string, EditionRegistryEntry>();
	private readonly positionChains = new Map<string, Promise<unknown>>();
	private availability: ReadingServiceStatus["availability"] = "unknown";
	private authRequired: boolean | null = null;
	private notesApi: boolean | null = null;
	private historyApi: boolean | null = null;
	private lastError: ReadingErrorInfo | null = null;
	private lastConnectedAt: string | null = null;
	private persisted: ReadingConnectionPersisted | null = null;
	private loaded: Promise<void> | null = null;
	private generation = 0;
	private disposed = false;

	constructor(deps: ReadingServiceDeps) {
		this.deps = deps;
		this.positionStore = new ReadingPositionStore({ paths: deps.paths, log: deps.log });
		this.noteIndexStore = new ReadingNoteIndexStore({ paths: deps.paths, log: deps.log });
		this.bindings = new ReadingSessionBindingsStore({ paths: deps.paths, now: deps.now, log: deps.log });
		this.noteWriter = new ReadingNoteWriter({
			client: deps.client,
			drafts: new ReadingNoteDraftStore(deps.paths),
			index: this.noteIndexStore,
			nowIso: () => this.nowIso(),
			// 草稿按服务 origin 隔离（wire user 固定 default）：切服务不互相覆盖，旧服务草稿仍可查
			resolveScope: () => ({ origin: readingOriginOf(this.persisted?.baseUrl || READING_DEFAULT_BASE_URL), user: "default" }),
			handleResult: (result, feature) => this.handleResult(result, feature),
		});
	}

	// ── 状态与连接 ─────────────────────────────────────────────────────────────

	private nowIso(): string {
		return (this.deps.now?.() ?? new Date()).toISOString();
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			this.loaded = (async () => {
				const settings = await this.deps.connection.read();
				this.persisted = settings;
				this.lastConnectedAt = settings.lastConnectedAt;
				this.deps.client.setBaseUrl(settings.baseUrl || READING_DEFAULT_BASE_URL);
				if (settings.rememberPassword && !this.deps.connection.readPassword(settings)) this.authRequired = true;
			})();
		}
		return this.loaded;
	}

	private noteSuccess(feature: "notes" | "history" | null): void {
		this.availability = "ready";
		this.lastError = null;
		if (feature === "notes") this.notesApi = true;
		if (feature === "history") this.historyApi = true;
	}

	private noteFailure(error: ReadingErrorInfo): ReadingErrorInfo {
		this.lastError = error;
		if (error.code === "needsConnection") {
			this.availability = "needsConnection";
			if (this.authRequired === null) this.authRequired = true;
		} else if (error.code === "unavailable") {
			this.availability = "unavailable";
		}
		return error;
	}

	/** 统一处理服务结果：成功标记 ready；unsupported 只调整能力位，不改可用性。 */
	private handleResult(result: ReadingHttpResult, feature: "notes" | "history" | null): HandledResult {
		if (result.ok) {
			this.noteSuccess(feature);
			return { ok: true, result };
		}
		if (feature === "notes" && result.error.code === "unsupported") this.notesApi = false;
		if (feature === "history" && result.error.code === "unsupported") this.historyApi = false;
		return { ok: false, error: this.noteFailure(result.error) };
	}

	private statusOf(): ReadingServiceStatus {
		const persisted = this.persisted;
		return {
			availability: this.availability,
			connection: {
				baseUrl: this.deps.client.getBaseUrl(),
				connected: this.availability === "ready",
				authRequired: this.authRequired,
				credentialStored: Boolean(persisted?.protectedPassword),
				rememberPassword: persisted?.rememberPassword === true,
				lastError: this.lastError,
				lastConnectedAt: this.lastConnectedAt,
			},
			notesApi: this.notesApi,
			historyApi: this.historyApi,
			dataDir: this.deps.paths.dataDir,
		};
	}

	async getStatus(): Promise<ReadingStatusResult> {
		await this.ensureLoaded();
		return { ok: true, status: this.statusOf() };
	}

	async connect(input: ReadingConnectInput): Promise<ReadingStatusResult> {
		await this.ensureLoaded();
		const baseUrl = input.baseUrl ?? READING_DEFAULT_BASE_URL;
		const persisted = this.persisted;
		// 空密码恢复：只有「同 origin + rememberPassword」的受保护凭据才读主进程密码；
		// 其它情况（换地址/未记住/解密失败）一律用调用方明文，绝不把旧 origin 的密码发给新 origin。
		let password = input.password;
		if (password === "" && persisted?.rememberPassword === true && persisted.baseUrl === baseUrl) {
			password = this.deps.connection.readPassword(persisted) ?? "";
		}
		const login = await this.deps.client.login(baseUrl, password);
		if (!login.ok) {
			this.noteFailure(login.error);
			return { ok: false, error: login.error };
		}
		const next: ReadingConnectionPersisted = { version: 1, baseUrl, rememberPassword: input.rememberPassword, lastConnectedAt: this.nowIso() };
		if (input.rememberPassword) {
			const protectedPassword = this.deps.connection.protectPassword(password);
			if (!protectedPassword) {
				const error: ReadingErrorInfo = { code: "secureStorageUnavailable", message: "系统安全存储不可用，未保存密码" };
				this.availability = "ready";
				this.authRequired = login.authRequired;
				this.lastError = error;
				return { ok: false, error };
			}
			next.protectedPassword = protectedPassword;
		} else if (persisted?.protectedPassword && persisted.baseUrl === baseUrl) {
			// 同一地址且本次未要求记住：保留原凭据，仅更新 remember 标志
			next.rememberPassword = false;
		}
		const written = await this.deps.connection.write(next);
		if (!written.ok) {
			const error: ReadingErrorInfo = { code: "writeFailed", message: "本地连接状态写入失败", detail: { reason: written.reason } };
			this.noteFailure(error);
			return { ok: false, error };
		}
		this.persisted = next;
		this.authRequired = login.authRequired;
		this.lastConnectedAt = next.lastConnectedAt;
		this.noteSuccess(null);
		this.deps.log?.("reading service connected", { baseUrl, authRequired: login.authRequired, rememberPassword: input.rememberPassword });
		return { ok: true, status: this.statusOf() };
	}

	async disconnect(): Promise<ReadingStatusResult> {
		await this.ensureLoaded();
		this.deps.client.clearSession();
		if (this.persisted) {
			const next: ReadingConnectionPersisted = { version: 1, baseUrl: this.persisted.baseUrl, rememberPassword: false, lastConnectedAt: null };
			const written = await this.deps.connection.write(next);
			if (written.ok) this.persisted = next;
		}
		this.availability = "unknown";
		this.authRequired = null;
		this.lastError = null;
		this.lastConnectedAt = null;
		return { ok: true, status: this.statusOf() };
	}

	// ── 书库与正文 ─────────────────────────────────────────────────────────────

	private async refreshLibrary(): Promise<{ ok: true; works: ReadingWork[] } | { ok: false; error: ReadingErrorInfo }> {
		const catalog = await this.deps.client.catalog();
		if (!catalog.ok) return { ok: false, error: this.noteFailure(catalog.error) };
		const books = await this.deps.client.listBooks();
		const works = parseWireLibrary(catalog.json, books.ok ? books.json : null);
		this.editions.clear();
		for (const work of works) for (const edition of work.editions) this.editions.set(edition.editionId, { edition, workId: work.workId });
		this.noteSuccess(null);
		return { ok: true, works };
	}

	async listLibrary(): Promise<ReadingLibraryResult> {
		await this.ensureLoaded();
		const outcome = await this.refreshLibrary();
		if (!outcome.ok) return { ok: false, error: outcome.error };
		return { ok: true, works: outcome.works, fetchedAt: this.nowIso() };
	}

	/** 版本必须来自已登记书库（只由服务端数据定位）；必要时惰性刷新一次。 */
	private async requireEdition(workId: string, editionId: string): Promise<{ ok: true; entry: EditionRegistryEntry } | { ok: false; error: ReadingErrorInfo }> {
		if (!this.editions.has(editionId)) await this.refreshLibrary();
		const entry = this.editions.get(editionId);
		if (!entry) return { ok: false, error: invalidInput("该版本未在已登记书库中", "editionId", "notRegistered") };
		if (entry.workId !== workId) return { ok: false, error: invalidInput("版本与作品不一致", "editionId", "workEditionMismatch") };
		return { ok: true, entry };
	}

	async getEdition(workId: string, editionId: string): Promise<ReadingEditionResult> {
		await this.ensureLoaded();
		const resolved = await this.requireEdition(workId, editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		const result = await this.deps.client.getEdition(resolved.entry.edition.rel);
		const handled = this.handleResult(result, null);
		if (!handled.ok) return { ok: false, error: handled.error };
		const view = parseWireEditionView(handled.result.json, { workId, editionId });
		if (!view) return { ok: false, error: this.noteFailure(internalError("阅读服务目录响应格式不正确")) };
		return { ok: true, edition: view };
	}

	async getChapter(workId: string, editionId: string, chapter: string): Promise<ReadingChapterResult> {
		await this.ensureLoaded();
		const resolved = await this.requireEdition(workId, editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		const result = await this.deps.client.getChapter(resolved.entry.edition.rel, chapter);
		const handled = this.handleResult(result, null);
		if (!handled.ok) return { ok: false, error: handled.error };
		const parsed = parseWireChapter(handled.result.json, { workId, editionId });
		if (!parsed) return { ok: false, error: this.noteFailure(internalError("阅读服务正文响应格式不正确")) };
		return { ok: true, identity: parsed.identity, chapter: parsed.chapter };
	}

	async resolveQuote(workId: string, editionId: string, text: string, chapterHref: string | null, expectedVersion: string): Promise<ReadingQuoteResult> {
		await this.ensureLoaded();
		const resolved = await this.requireEdition(workId, editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		const result = await this.deps.client.resolveQuote(resolved.entry.edition.rel, text, chapterHref, expectedVersion);
		const handled = this.handleResult(result, null);
		if (!handled.ok) return { ok: false, error: handled.error };
		const parsed = parseWireQuote(handled.result.json, { workId, editionId });
		if (!parsed) return { ok: false, error: this.noteFailure(internalError("阅读服务核验响应格式不正确")) };
		return { ok: true, ...parsed };
	}

	// ── 笔记 ──────────────────────────────────────────────────────────────────

	async listNotes(workId: string, editionId: string): Promise<ReadingNoteListResult> {
		await this.ensureLoaded();
		const resolved = await this.requireEdition(workId, editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		const result = await this.deps.client.listNotes(workId, editionId);
		const handled = this.handleResult(result, "notes");
		if (!handled.ok) return { ok: false, error: handled.error };
		const parsed = parseWireNoteList(handled.result.json);
		if (!parsed) return { ok: false, error: this.noteFailure(internalError("阅读服务笔记列表格式不正确")) };
		await this.noteIndexStore.replaceAll(workId, parsed.notes, this.nowIso());
		return { ok: true, notes: parsed.notes, unattributed: parsed.unattributed };
	}

	async readNote(workId: string, noteId: string): Promise<ReadingNoteReadResult> {
		await this.ensureLoaded();
		if (!(await this.noteIndexStore.hasNote(workId, noteId))) return { ok: false, error: invalidInput("该笔记未登记，请先刷新笔记列表", "noteId", "notRegistered") };
		const result = await this.deps.client.readNote(noteId);
		const handled = this.handleResult(result, "notes");
		if (!handled.ok) return { ok: false, error: handled.error };
		const parsed = parseWireNoteRead(handled.result.json);
		if (!parsed) return { ok: false, error: this.noteFailure(internalError("阅读服务笔记响应格式不正确")) };
		await this.noteIndexStore.upsert(workId, parsed.note, this.nowIso());
		return { ok: true, note: parsed.note, content: parsed.content, truncated: parsed.truncated };
	}

	async writeNote(input: ReadingNoteWriteInput): Promise<ReadingNoteWriteResult> {
		await this.ensureLoaded();
		const operation = input.operation;
		const noteId = operation.op === "create" ? null : operation.noteId;
		const resolved = await this.requireEdition(operation.workId, operation.editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		if (noteId && !(await this.noteIndexStore.hasNote(operation.workId, noteId))) return { ok: false, error: invalidInput("该笔记未登记，请先刷新笔记列表", "noteId", "notRegistered") };
		// 写入编排（留稿/严格 applied/幂等）在 readingNoteWriter，本处只做登记与边界策略
		return this.noteWriter.write(operation, input.clientRequestId);
	}

	/** 未确认草稿列表（重开恢复用；不做自动重发）。 */
	async listNoteDrafts(): Promise<ReadingNoteDraftListResult> {
		await this.ensureLoaded();
		return this.noteWriter.list();
	}

	async discardNoteDraft(ref: ReadingNoteDraftRef): Promise<ReadingNoteDraftActionResult> {
		await this.ensureLoaded();
		return this.noteWriter.discard(ref);
	}

	/** 恢复草稿：先只读对账，applied 才清稿；pending/unknown 留稿返回。 */
	async resumeNoteDraft(ref: ReadingNoteDraftRef): Promise<ReadingNoteDraftResumeResult> {
		await this.ensureLoaded();
		return this.noteWriter.resume(ref);
	}

	// ── 阅读位置 ───────────────────────────────────────────────────────────────

	async getPosition(workId: string, editionId: string, contentVersion: string): Promise<ReadingPositionGetResult> {
		await this.ensureLoaded();
		const resolved = await this.requireEdition(workId, editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		const loaded = await this.positionStore.load(editionId);
		if (loaded.issue) this.lastError = { code: "internalError", message: loaded.issue.message, detail: { reason: loaded.issue.code, blocked: loaded.issue.blocked } };
		const position = loaded.value;
		if (!position) return { ok: true, position: null, stale: false, reason: "missing" };
		// 作品或内容版本不符：标 stale 回章首，不把旧 fraction 套到新版本
		if (position.workId !== workId || position.contentVersion !== contentVersion) return { ok: true, position: null, stale: true, reason: "versionMismatch" };
		return { ok: true, position, stale: false, reason: "none" };
	}

	async savePosition(input: ReadingPositionSaveInput): Promise<ReadingPositionSaveResult> {
		const run = async (): Promise<ReadingPositionSaveResult> => {
			// 校验入链原因（2026-10 顺序反转）：首帧 save 会惰性触发 requireEdition → refreshLibrary 的
			// 慢网络请求；若校验在链外，并发第二次 save 可能先校验先写入，早发的旧位置反而后完成
			// 并在链内覆盖新位置。把「校验 + 读改写」整体交给既有 per-edition 链，保持先发先写。
			await this.ensureLoaded();
			const resolved = await this.requireEdition(input.workId, input.editionId);
			if (!resolved.ok) return { ok: false, error: resolved.error };
			if (this.disposed) return { ok: false, error: { code: "unavailable", message: "阅读服务已停止" } };
			const generation = this.generation;
			const loaded = await this.positionStore.load(input.editionId);
			if (loaded.issue?.blocked) return { ok: false, error: { code: "writeFailed", message: loaded.issue.message, detail: { reason: "blocked" } } };
			if (loaded.value && (loaded.value.contentVersion !== input.contentVersion || loaded.value.workId !== input.workId)) {
				return { ok: false, error: { code: "staleVersion", message: "阅读位置属于另一个内容版本，未写入", detail: { current: loaded.value.contentVersion, incoming: input.contentVersion } } };
			}
			if (this.generation !== generation) return { ok: false, error: { code: "unavailable", message: "阅读服务状态已变化，本次结果作废" } };
			const position: ReadingPosition = {
				workId: input.workId,
				editionId: input.editionId,
				contentVersion: input.contentVersion,
				fraction: input.fraction,
				spineHref: input.spineHref ?? null,
				chapterNum: input.chapterNum ?? null,
				chapterTextDigest: input.chapterTextDigest ?? null,
				source: "reader",
				savedAt: this.nowIso(),
			};
			const saved = await this.positionStore.save(position);
			if (!saved.ok) return { ok: false, error: { code: "writeFailed", message: "阅读位置写入失败", detail: { reason: saved.reason } } };
			return { ok: true, position, idempotent: saved.idempotent, scope: { workId: input.workId, editionId: input.editionId, contentVersion: input.contentVersion } };
		};
		// 每版串行：同一 edition 的读改写不交错
		const previous = this.positionChains.get(input.editionId) ?? Promise.resolve();
		const chain = previous.then(run, run);
		this.positionChains.set(
			input.editionId,
			chain.then(
				() => undefined,
				() => undefined,
			),
		);
		return chain;
	}

	// ── 会话绑定（P04）：本地主账，不读写 Pi session 文件、不新建 agent ────────

	/** 会话是否存在（catalog 查询注入；探针抛错当不存在，不让绑定写入失去护栏）。 */
	private async sessionExists(sessionId: string): Promise<boolean> {
		const probe = this.deps.sessionExists;
		if (!probe) return false;
		try {
			return await probe(sessionId);
		} catch {
			return false;
		}
	}

	/** 全部绑定 + 指向已不存在会话的 id 集（界面据此显式提示重绑，不静默重建）。 */
	async listBindings(): Promise<ReadingBindingListResult> {
		const loaded = await this.bindings.list();
		const stale = new Set<string>();
		for (const binding of loaded.bindings) {
			if (!(await this.sessionExists(binding.sessionId))) stale.add(binding.sessionId);
		}
		// 损坏隔离诊断如实上交（仅供界面/日志提示）；绑定列表本身仍返回当前可用内容。
		const issue: ReadingErrorInfo | null = loaded.issue ? { code: "internalError", message: loaded.issue.message, detail: { reason: loaded.issue.code, blocked: loaded.issue.blocked } } : null;
		return { ok: true, bindings: loaded.bindings, staleSessionIds: [...stale], issue };
	}

	/** 解析指定版本的绑定：missing=未绑定；sessionMissing=绑定还在但会话已删（stale）。 */
	async resolveBinding(ref: ReadingBindingRef): Promise<ReadingBindingResolveResult> {
		const binding = await this.bindings.get(ref.workId, ref.editionId);
		if (!binding) return { ok: true, binding: null, sessionExists: false, stale: false, reason: "missing" };
		const exists = await this.sessionExists(binding.sessionId);
		return { ok: true, binding, sessionExists: exists, stale: !exists, reason: exists ? "none" : "sessionMissing" };
	}

	/**
	 * 显式绑定（新建或重绑）：目标会话必须已存在；版本必须属于已登记书库。
	 * 不自动新建会话、不改写 Pi 会话文件；内容版本变化不改绑定键。
	 */
	async bindSession(input: ReadingBindSessionInput): Promise<ReadingBindingMutationResult> {
		if (this.disposed) return { ok: false, error: { code: "unavailable", message: "阅读服务已停止" } };
		await this.ensureLoaded();
		const resolved = await this.requireEdition(input.workId, input.editionId);
		if (!resolved.ok) return { ok: false, error: resolved.error };
		if (!(await this.sessionExists(input.sessionId))) return { ok: false, error: invalidInput("目标会话已不存在，请重新选择或新建会话", "sessionId", "sessionMissing") };
		const written = await this.bindings.upsert({ workId: input.workId, editionId: input.editionId, sessionId: input.sessionId, projectId: input.projectId });
		if (!written.ok) {
			this.lastError = written.error;
			return { ok: false, error: written.error };
		}
		this.deps.log?.("reading bind session", { workId: input.workId, editionId: input.editionId, sessionId: input.sessionId });
		return { ok: true, binding: written.binding };
	}

	/** 解绑：未绑定也成功（removed=false）；不清除任何会话内容/草稿。 */
	async unbindSession(ref: ReadingBindingRef): Promise<ReadingUnbindResult> {
		const removed = await this.bindings.remove(ref.workId, ref.editionId);
		if (!removed.ok) {
			this.lastError = removed.error;
			return { ok: false, error: removed.error };
		}
		return { ok: true, removed: removed.removed };
	}

	// ── 旧阅读历史（source-labelled，只读） ─────────────────────────────────────

	async historySources(): Promise<ReadingHistorySourcesResult> {
		await this.ensureLoaded();
		const result = await this.deps.client.historySources();
		const handled = this.handleResult(result, "history");
		if (!handled.ok) return { ok: false, error: handled.error };
		const sources = parseWireHistorySources(handled.result.json);
		if (sources.length === 0) return { ok: false, error: this.noteFailure(internalError("阅读服务历史来源格式不正确")) };
		return { ok: true, sources };
	}

	async listHistory(source: ReadingHistorySourceName, cursor: string | null, limit: number): Promise<ReadingHistoryListResult> {
		await this.ensureLoaded();
		const result = await this.deps.client.listHistory({ source, cursor, limit });
		const handled = this.handleResult(result, "history");
		if (!handled.ok) return { ok: false, error: handled.error };
		const parsed = parseWireHistoryList(handled.result.json);
		if (!parsed) return { ok: false, error: this.noteFailure(internalError("阅读服务历史列表格式不正确")) };
		return { ok: true, source: parsed.source, sessions: parsed.sessions, nextCursor: parsed.nextCursor };
	}

	async readHistorySession(source: ReadingHistorySourceName, id: string): Promise<ReadingHistorySessionResult> {
		await this.ensureLoaded();
		const result = await this.deps.client.readHistorySession(source, id);
		const handled = this.handleResult(result, "history");
		if (!handled.ok) return { ok: false, error: handled.error };
		// 摘要与原文本都取自本次响应（服务端保证 session 存在）；raw 原样返回，truncated 照实转达
		const parsed = parseWireHistorySessionDetail(handled.result.json, handled.result.text);
		if (!parsed || !parsed.session) return { ok: false, error: this.noteFailure(internalError("阅读服务历史会话响应格式不正确")) };
		return { ok: true, source, id, session: parsed.session, raw: parsed.raw, truncated: parsed.truncated };
	}

	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.positionChains.clear();
		this.deps.client.dispose();
	}
}
