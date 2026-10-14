/**
 * 阅读会话绑定存储（P04）：`<userData>/personal-workbench/reading/sessions/bindings.json`。
 *
 * 一句话职责：把「作品 + 版本 → Pi 会话」的绑定关系按 workId+editionId 持久化，
 * 跨重启稳定；内容版本（contentVersion）不参与绑定键，换版本不改写归属。
 *
 * 沿 readingJsonStore 的同一纪律（与 P02/P03 教训共享）：
 * - 原子写（临时文件 → renameWithRetry）；有界读（512KiB 上界）；
 * - **持久绑定不是可淘汰缓存**：绝不因容量静默删除旧绑定；条目数或序列化字节超限时
 *   结构化拒绝新写（detail.reason），既有绑定原样保留；
 * - 结构判定明确：version 不符、bindings 非数组、任一条目非法、身份重复 → 整文件按损坏
 *   隔离原件后以空状态继续；隔离失败则拒绝再写（绝不覆盖原件）。不做「静默过滤坏条目再覆写」；
 * - 写操作走单链串行，避免并发 upsert/remove 的旧快照覆盖新快照；
 * - 只存绑定关系：不读写 Pi session 文件、不碰 DeepRead、不新增权限渠道。
 */

import { join } from "node:path";
import type { ReadingErrorInfo, ReadingSessionBinding } from "../../../shared/types/reading";
import { READING_STORE_MAX_BYTES, type ReadingStoreIssue, handleReadingCorrupt, readReadingJsonBounded, serializeReadingJson, writeReadingJsonAtomic } from "./readingJsonStore";
import type { ReadingPaths } from "./readingPaths";

export const READING_BINDINGS_FILE = "bindings.json";
export const READING_BINDINGS_VERSION = 1;
/** 条目容量上限：超限拒绝新写（不淘汰既有绑定）。 */
export const READING_BINDINGS_MAX_ENTRIES = 200;

type PersistedBindings = { version: number; bindings: ReadingSessionBinding[] };

export type ReadingBindingsStoreDeps = {
	paths: ReadingPaths;
	now?: () => Date;
	log?: (message: string, details?: Record<string, unknown>) => void;
};

export type ReadingBindingsLoad = { ok: true; bindings: ReadingSessionBinding[] /** 最近一次损坏隔离诊断；null=文件健康。 */; issue: ReadingStoreIssue | null };
export type ReadingBindingsWrite = { ok: true } | { ok: false; error: ReadingErrorInfo };

function storeError(code: ReadingErrorInfo["code"], message: string, detail?: ReadingErrorInfo["detail"]): ReadingErrorInfo {
	return detail ? { code, message, detail } : { code, message };
}

/** unknown 对象收窄：只用 Reflect.get 读字段，不做 as Record 结构绕过。 */
function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: object, key: string): string | null {
	const value = Reflect.get(record, key);
	return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

/** 单条绑定结构校验：任一条目非法都视为整文件结构非法（由调用方隔离，不静默丢弃）。 */
function parseBinding(value: unknown): ReadingSessionBinding | null {
	if (!isRecord(value)) return null;
	const workId = readString(value, "workId");
	const editionId = readString(value, "editionId");
	const sessionId = readString(value, "sessionId");
	const projectId = readString(value, "projectId");
	const createdAt = readString(value, "createdAt");
	const lastUsedAt = readString(value, "lastUsedAt");
	if (!workId || !editionId || !sessionId || !projectId || !createdAt || !lastUsedAt) return null;
	return { workId, editionId, sessionId, projectId, createdAt, lastUsedAt };
}

export class ReadingSessionBindingsStore {
	private readonly filePath: string;
	private readonly now: () => Date;
	private readonly log?: ReadingBindingsStoreDeps["log"];
	private cache: ReadingSessionBinding[] | null = null;
	private loadPromise: Promise<ReadingBindingsLoad> | null = null;
	private blocked = false;
	private issue: ReadingStoreIssue | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(deps: ReadingBindingsStoreDeps) {
		this.filePath = join(deps.paths.sessionsDir, READING_BINDINGS_FILE);
		this.now = deps.now ?? (() => new Date());
		this.log = deps.log;
	}

	private nowIso(): string {
		return this.now().toISOString();
	}

	private async quarantine(code: ReadingStoreIssue["code"]): Promise<ReadingBindingsLoad> {
		const issue = await handleReadingCorrupt(this.filePath, code, this.now);
		this.issue = issue;
		this.blocked = issue.blocked;
		this.log?.("reading bindings corrupt", { code: issue.code, blocked: issue.blocked });
		return { ok: true, bindings: [], issue };
	}

	private async readFromDisk(): Promise<ReadingBindingsLoad> {
		const read = await readReadingJsonBounded(this.filePath, READING_STORE_MAX_BYTES);
		if (read.status === "missing") return { ok: true, bindings: [], issue: null };
		if (read.status === "issue") return this.quarantine(read.code);
		const value = read.value;
		if (!isRecord(value)) return this.quarantine("invalidStructure");
		// 未知 version 不能忽略（可能是别的写入口的新格式）：隔离保留原件，绝不按当前格式解读/覆写
		if (Reflect.get(value, "version") !== READING_BINDINGS_VERSION) return this.quarantine("invalidStructure");
		const rawBindings = Reflect.get(value, "bindings");
		if (!Array.isArray(rawBindings)) return this.quarantine("invalidStructure");
		const parsed: ReadingSessionBinding[] = [];
		const seen = new Set<string>();
		for (const entry of rawBindings) {
			const binding = parseBinding(entry);
			// 任一条目非法或身份重复：整文件按损坏隔离，不做「过滤坏条目后静默覆写」
			if (!binding) return this.quarantine("invalidStructure");
			const identity = `${binding.workId}\u0000${binding.editionId}`;
			if (seen.has(identity)) return this.quarantine("invalidStructure");
			seen.add(identity);
			parsed.push(binding);
		}
		return { ok: true, bindings: parsed, issue: null };
	}

	private async load(): Promise<ReadingBindingsLoad> {
		if (this.cache) return { ok: true, bindings: this.cache, issue: this.issue };
		if (!this.loadPromise) {
			this.loadPromise = this.readFromDisk().then((result) => {
				if (result.ok && result.bindings.length > 0) this.cache = result.bindings;
				return result;
			});
		}
		return this.loadPromise;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async persist(bindings: ReadingSessionBinding[]): Promise<ReadingBindingsWrite> {
		if (this.blocked) {
			return { ok: false, error: storeError("writeFailed", "本地绑定文件损坏且无法隔离，已暂停写入以保留原件", { reason: "blocked" }) };
		}
		const payload: PersistedBindings = { version: READING_BINDINGS_VERSION, bindings };
		// 有界读是硬约束：写入前先按同一序列化口径检查字节上界，避免写出下次读会当损坏隔离的文件
		if (Buffer.byteLength(serializeReadingJson(payload), "utf8") > READING_STORE_MAX_BYTES) {
			return { ok: false, error: storeError("writeFailed", "阅读会话绑定文件超过容量上限，未写入新绑定", { reason: "bindingBytesExceeded", limit: READING_STORE_MAX_BYTES }) };
		}
		const written = await writeReadingJsonAtomic(this.filePath, payload);
		if (!written.ok) return { ok: false, error: storeError("writeFailed", "阅读会话绑定写入失败", { reason: written.reason }) };
		this.cache = bindings;
		return { ok: true };
	}

	/** 全部绑定（按 workId+editionId 去重后的快照）+ 最近一次损坏隔离诊断。 */
	async list(): Promise<ReadingBindingsLoad> {
		return this.load();
	}

	async get(workId: string, editionId: string): Promise<ReadingSessionBinding | null> {
		const loaded = await this.load();
		if (!loaded.ok) return null;
		return loaded.bindings.find((binding) => binding.workId === workId && binding.editionId === editionId) ?? null;
	}

	/**
	 * 绑定/重绑：同键覆盖 sessionId 与 projectId，保留原 createdAt。
	 * 容量/字节超限时结构化拒绝新写（重绑既有键不增加条目数，不受条目容量限制）并保留既有绑定。
	 */
	async upsert(input: { workId: string; editionId: string; sessionId: string; projectId: string }): Promise<{ ok: true; binding: ReadingSessionBinding } | { ok: false; error: ReadingErrorInfo }> {
		return this.enqueue(async () => {
			const loaded = await this.load();
			const existing = loaded.bindings.find((binding) => binding.workId === input.workId && binding.editionId === input.editionId) ?? null;
			if (!existing && loaded.bindings.length >= READING_BINDINGS_MAX_ENTRIES) {
				return { ok: false, error: storeError("writeFailed", "阅读会话绑定数量已达上限，未写入新绑定（既有绑定保留）", { reason: "bindingCapacityExceeded", limit: READING_BINDINGS_MAX_ENTRIES }) };
			}
			const nowIso = this.nowIso();
			const binding: ReadingSessionBinding = {
				workId: input.workId,
				editionId: input.editionId,
				sessionId: input.sessionId,
				projectId: input.projectId,
				createdAt: existing?.createdAt ?? nowIso,
				lastUsedAt: nowIso,
			};
			const next = [...loaded.bindings.filter((entry) => !(entry.workId === input.workId && entry.editionId === input.editionId)), binding];
			const written = await this.persist(next);
			if (!written.ok) return { ok: false, error: written.error };
			return { ok: true, binding };
		});
	}

	/** 解绑：不存在也算成功（removed=false），不报「绑定不存在」打扰用户。 */
	async remove(workId: string, editionId: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: ReadingErrorInfo }> {
		return this.enqueue(async () => {
			const loaded = await this.load();
			const next = loaded.bindings.filter((entry) => !(entry.workId === workId && entry.editionId === editionId));
			if (next.length === loaded.bindings.length) return { ok: true, removed: false };
			const written = await this.persist(next);
			if (!written.ok) return { ok: false, error: written.error };
			return { ok: true, removed: true };
		});
	}

	/** 诊断用：最近一次损坏隔离信息（仅主进程日志/服务内部使用）。 */
	currentIssue(): ReadingStoreIssue | null {
		return this.issue;
	}
}
