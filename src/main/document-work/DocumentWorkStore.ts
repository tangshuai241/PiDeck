/**
 * TPA 独立文稿：持久化存储。
 *
 * 事实源是 `userData/document-work/` 下的 JSON 元数据（文稿正文留在用户成果目录）。
 *
 * 三条硬性约束决定实现形态：
 *
 * 1. **原子与可恢复写入**：先写 `*.tmp`，再把现有文件改名成 `*.bak`，最后 rename 覆盖。
 *    任一步失败都不会留下半截文件。
 * 2. **revision / CAS**：每个文件（索引、单个工作）带单调 `revision`。调用者必须带
 *    `expectedRevision`，不匹配返回 `REVISION_CONFLICT` 与当前版本。
 * 3. **requestId 去重**：`requestId` 记进索引，同 ID 同载荷返回原结果，同 ID 不同载荷返回
 *    `IDEMPOTENCY_CONFLICT`，绝不静默换 ID 重放。
 *
 * 损坏语义（审查修正项 6）：主档不可解析时**不自动修复、不当作缺失重建**。若 `.bak`
 * 仍可解析，只把它当作**只读**展示来源（`readWorkForDisplay`），磁盘上的损坏文件原样保留，
 * 写入与新执行一律拒绝。这样旧授权不会因为一次自动修复被"恢复"出来。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_WORK_SCHEMA_VERSION, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentWorkOperation, DocumentWorkOutputRoot, DocumentWorkRecord } from "../../shared/types/documentWork";
import { canonicalJsonForStore, emptyIndex, parseIndexState, parseWorkBucket, type DocumentWorkBucketState, type DocumentWorkIndexState } from "./DocumentWorkStoreCodec";

/** 注入点：测试用它模拟写入失败/损坏文件，生产用真实 fs。 */
export type DocumentWorkFsPort = {
	readFile(path: string): string | undefined;
	writeFile(path: string, content: string): void;
	rename(from: string, to: string): void;
	removeFile(path: string): void;
	exists(path: string): boolean;
	mkdirp(path: string): void;
};

export const nodeDocumentWorkFs: DocumentWorkFsPort = {
	readFile: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	writeFile: (path, content) => writeFileSync(path, content, "utf8"),
	rename: (from, to) => renameSync(from, to),
	removeFile: (path) => rmSync(path, { force: true }),
	exists: (path) => existsSync(path),
	mkdirp: (path) => mkdirSync(path, { recursive: true }),
};

const INDEX_FILE = "index.json";
const WORKS_DIR = "works";

export type DocumentWorkStoreOptions = {
	/** 元数据根目录（生产为 `userData/document-work`）。 */
	dir: string;
	fs?: DocumentWorkFsPort;
	now?: () => number;
	/** ID 生成器注入点；生产用随机 ID。 */
	newId?: (prefix: string) => string;
};

/** 记录损坏：既有文件不可解析。原文件保留，写入与新执行一律拒绝。 */
export class CorruptDocumentWorkRecord extends Error {
	constructor(
		readonly reason: string,
		/** `.bak` 里是否还有可解析的旧内容（只作只读展示，不写回）。 */
		readonly backupValue?: unknown,
	) {
		super(reason);
		this.name = "CorruptDocumentWorkRecord";
	}
}

export class DocumentWorkStore {
	private readonly dir: string;
	private readonly worksDir: string;
	private readonly fs: DocumentWorkFsPort;
	private readonly now: () => number;
	private readonly newId: (prefix: string) => string;
	/** 隔离集合：键为文件路径，值为 `.bak` 里解析出来的只读快照（供只读展示）。 */
	private readonly quarantined = new Map<string, unknown>();

	constructor(options: DocumentWorkStoreOptions) {
		this.dir = options.dir;
		this.worksDir = join(options.dir, WORKS_DIR);
		this.fs = options.fs ?? nodeDocumentWorkFs;
		this.now = options.now ?? (() => Date.now());
		this.newId = options.newId ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`);
	}

	/** 目录与索引的懒初始化：只读调用不应该创建任何文件。 */
	private ensureDir(): void {
		this.fs.mkdirp(this.worksDir);
	}

	public indexPath(): string {
		return join(this.dir, INDEX_FILE);
	}

	public workPath(workId: string): string {
		return join(this.worksDir, `${workId}.json`);
	}

	/** 原子写入：tmp → (旧文件 → bak) → rename。 */
	private writeAtomic(path: string, content: string): void {
		const temporary = `${path}.tmp`;
		const backup = `${path}.bak`;
		this.fs.writeFile(temporary, content);
		const hadPrevious = this.fs.exists(path);
		if (hadPrevious) {
			this.fs.removeFile(backup);
			this.fs.rename(path, backup);
		}
		try {
			this.fs.rename(temporary, path);
		} catch (error) {
			if (hadPrevious) {
				try {
					this.fs.rename(backup, path);
				} catch {
					// 还原也失败：磁盘上仍有 bak，由读取路径兜底，不掩盖原始错误。
				}
			}
			this.fs.removeFile(temporary);
			throw error;
		}
	}

	private parseSafely<T>(content: string, parse: (value: unknown) => T | undefined): T | undefined {
		let value: unknown;
		try {
			value = JSON.parse(content);
		} catch {
			return undefined;
		}
		try {
			return parse(value);
		} catch {
			return undefined;
		}
	}

	/**
	 * 读取单个 JSON 文件。
	 *
	 * 主文件不可解析时**不修复、不重建**：标记隔离并抛出携带 `.bak` 只读快照的
	 * `CorruptDocumentWorkRecord`。文件不存在（首次使用）返回 undefined。
	 */
	private readJson<T>(path: string, parse: (value: unknown) => T | undefined, label: string): T | undefined {
		if (this.quarantined.has(path)) throw new CorruptDocumentWorkRecord(`${label} is quarantined after a corrupt read`, this.quarantined.get(path));
		const primary = this.fs.readFile(path);
		if (primary !== undefined) {
			const parsed = this.parseSafely(primary, parse);
			if (parsed !== undefined) return parsed;
		}
		const backup = this.fs.readFile(`${path}.bak`);
		const backupValue = backup === undefined ? undefined : this.parseSafely(backup, parse);
		if (primary === undefined && backupValue === undefined) return undefined;
		// 保留原文件 + 记住备份快照：不原位修复，只允许只读展示。
		this.quarantined.set(path, backupValue);
		throw new CorruptDocumentWorkRecord(`${label} is unreadable; the original file was kept and writes are stopped`, backupValue);
	}

	private writeJson(path: string, value: unknown): void {
		if (this.quarantined.has(path)) throw new CorruptDocumentWorkRecord("record is quarantined; writes are stopped", this.quarantined.get(path));
		this.ensureDir();
		this.writeAtomic(path, canonicalJsonForStore(value));
	}

	private readIndex(): DocumentWorkIndexState | undefined {
		return this.readJson(this.indexPath(), parseIndexState, "document work index");
	}

	// ── 输出根 ───────────────────────────────────────────────────────────────

	/** 登记用户显式选择的成果目录；同一路径复用同一 ID，避免重复登记。 */
	registerOutputRoot(input: { path: string; label: string }): WorkResult<DocumentWorkOutputRoot> {
		const path = input.path.trim();
		if (!path || path.length > 2000) return workFail("INVALID_INPUT", false, { detail: "output root path is empty or too long" });
		const label = input.label.trim().slice(0, 200) || "documents";
		return this.mutateIndex((index) => {
			const existing = Object.values(index.outputRoots).find((root) => root.path === path);
			if (existing) return workOk({ bucket: index, value: existing });
			const root: DocumentWorkOutputRoot = { outputRootId: this.newId("root"), path, label, registeredAt: this.now() };
			return workOk({ bucket: { ...index, outputRoots: { ...index.outputRoots, [root.outputRootId]: root } }, value: root });
		});
	}

	getOutputRoot(outputRootId: string): WorkResult<DocumentWorkOutputRoot> {
		const root = this.readIndexOrEmpty().outputRoots[outputRootId];
		if (!root) return workFail("PATH_DENIED", false, { detail: "output root is not registered" });
		return workOk(root);
	}

	listOutputRoots(): DocumentWorkOutputRoot[] {
		return Object.values(this.readIndexOrEmpty().outputRoots).sort((left, right) => left.registeredAt - right.registeredAt);
	}

	private readIndexOrEmpty(): DocumentWorkIndexState {
		return this.readIndex() ?? emptyIndex();
	}

	/** 撤销成果根登记（用户撤销授权）；已归档记录保留。 */
	unregisterOutputRoot(outputRootId: string): WorkResult<boolean> {
		return this.mutateIndex((index) => {
			if (!index.outputRoots[outputRootId]) return workOk({ bucket: index, value: false });
			const outputRoots = { ...index.outputRoots };
			delete outputRoots[outputRootId];
			return workOk({ bucket: { ...index, outputRoots }, value: true });
		});
	}

	// ── 请求台账 ─────────────────────────────────────────────────────────────

	/**
	 * 查询 requestId 的归属。返回 `conflict` 表示同 ID 携带了不同载荷，调用方
	 * 必须返回 IDEMPOTENCY_CONFLICT，不得自动换 ID 再执行。
	 */
	lookupRequest(requestId: string, requestDigest: string): { kind: "create" | "operation"; workId: string } | { conflict: true; workId: string } | undefined {
		const entry = this.readIndexOrEmpty().requests[requestId];
		if (!entry) return undefined;
		return entry.requestDigest === requestDigest ? { kind: entry.kind, workId: entry.workId } : { conflict: true, workId: entry.workId };
	}

	/** 只按 requestId 定位归属（查询用）；返回 undefined 表示没有这个请求。 */
	lookupRequestAny(requestId: string): { workId: string } | undefined {
		const entry = this.readIndexOrEmpty().requests[requestId];
		return entry ? { workId: entry.workId } : undefined;
	}

	// ── 工作 ─────────────────────────────────────────────────────────────────

	/** 新建工作记录；同一 requestId 重复调用返回原记录。 */
	createWork(input: { requestId: string; requestDigest: string; sessionId: string; sourceTurnId: string; title: string; outputRootId: string }): WorkResult<DocumentWorkRecord> {
		const existing = this.lookupRequest(input.requestId, input.requestDigest);
		if (existing && "conflict" in existing) return workFail("IDEMPOTENCY_CONFLICT", false, { detail: "requestId was used with a different payload" });
		if (existing) {
			const found = this.readWork(existing.workId);
			if ("error" in found) return found;
			return workOk(found.value.record);
		}
		return this.mutateIndex((index) => {
			// 空字符串 = 首次提交时还没绑定成果目录（用户在聊天里选完再绑），这不是错误。
			if (input.outputRootId !== "" && !index.outputRoots[input.outputRootId]) return workFail("PATH_DENIED", false, { detail: "output root is not registered" });
			const now = this.now();
			const workId = this.newId("work");
			const record: DocumentWorkRecord = {
				schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
				workId,
				sessionId: input.sessionId,
				revision: 0,
				title: input.title.trim().slice(0, 200) || "document",
				sourceTurnId: input.sourceTurnId,
				outputRootId: input.outputRootId,
				requests: {},
				versions: [],
				createdAt: now,
				updatedAt: now,
			};
			const bucket: DocumentWorkBucketState = { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: 0, record, operations: {}, preparations: {}, versions: [] };
			try {
				this.writeJson(this.workPath(workId), bucket);
			} catch {
				return workFail("IO_ERROR", true, { detail: "failed to persist the work record" });
			}
			return workOk({
				bucket: { ...index, requests: { ...index.requests, [input.requestId]: { workId, requestDigest: input.requestDigest, kind: "create" } }, workIds: [...index.workIds, workId] },
				value: record,
			});
		});
	}

	readWork(workId: string): WorkResult<DocumentWorkBucketState> {
		try {
			const bucket = this.readJson(this.workPath(workId), parseWorkBucket, `document work ${workId}`);
			if (!bucket || bucket.record.workId !== workId) return workFail("WORK_NOT_FOUND", false, { detail: "work record is missing" });
			return workOk(bucket);
		} catch (error) {
			if (error instanceof CorruptDocumentWorkRecord) return workFail("IO_ERROR", false, { detail: error.reason });
			return workFail("IO_ERROR", true, { detail: "failed to read the work record" });
		}
	}

	/**
	 * 只读展示：记录损坏时用 `.bak` 的可解析内容做**只读**快照，便于界面提示
	 * "记录损坏，需要人工处理"。不写回磁盘，也不允许据此恢复任何授权。
	 */
	readWorkForDisplay(workId: string): { record?: DocumentWorkRecord; versions: DocumentArtifactVersion[]; corrupt?: { reason: string; repairedFromBackup?: boolean } } {
		try {
			const bucket = this.readJson(this.workPath(workId), parseWorkBucket, `document work ${workId}`);
			return bucket ? { record: bucket.record, versions: bucket.versions } : { versions: [] };
		} catch (error) {
			if (!(error instanceof CorruptDocumentWorkRecord)) return { versions: [], corrupt: { reason: "failed to read the work record" } };
			const backup = error.backupValue as DocumentWorkBucketState | undefined;
			return backup?.record ? { record: backup.record, versions: backup.versions, corrupt: { reason: error.reason, repairedFromBackup: true } } : { versions: [], corrupt: { reason: error.reason } };
		}
	}

	/**
	 * 带 revision 校验的同步读改写。`plan` 必须纯粹（不得 await），
	 * 因此并发提交里只有一个能匹配 expectedRevision，另一个收到 REVISION_CONFLICT。
	 */
	withWork<T>(workId: string, expectedRevision: number, plan: (bucket: DocumentWorkBucketState) => WorkResult<{ bucket: DocumentWorkBucketState; value: T }>): WorkResult<T> {
		const read = this.readWork(workId);
		if ("error" in read) return read;
		if (!Number.isSafeInteger(expectedRevision) || read.value.revision !== expectedRevision) return workFail("REVISION_CONFLICT", true, { currentRevision: read.value.revision, detail: "the work record advanced; retry with the current revision" });
		const planned = plan(read.value);
		if ("error" in planned) return planned;
		const next: DocumentWorkBucketState = { ...planned.value.bucket, revision: read.value.revision + 1, record: { ...planned.value.bucket.record, revision: read.value.revision + 1, updatedAt: this.now() } };
		try {
			this.writeJson(this.workPath(workId), next);
		} catch (error) {
			if (error instanceof CorruptDocumentWorkRecord) return workFail("IO_ERROR", false, { detail: error.reason });
			return workFail("IO_ERROR", true, { detail: "failed to persist the work record" });
		}
		return workOk(planned.value.value);
	}

	/** 记录 requestId → 操作归属；与 work 提交分离是为了让幂等台账先于执行落地。 */
	recordRequest(input: { requestId: string; requestDigest: string; workId: string; kind: "create" | "operation" }): WorkResult<boolean> {
		return this.mutateIndex((index) => workOk({ bucket: { ...index, requests: { ...index.requests, [input.requestId]: { workId: input.workId, requestDigest: input.requestDigest, kind: input.kind } } }, value: true }));
	}

	listWorkIds(): string[] {
		return [...this.readIndexOrEmpty().workIds];
	}

	/**
	 * 会话恢复用：只按 sessionId 过滤，不猜测标题或文件时间。
	 * 记录损坏时退回 `.bak` 的只读快照——**不能让损坏的工作从列表里消失**，
	 * 否则界面会以为它不存在、用户会重新建一件。
	 */
	listWorksForSession(sessionId: string): DocumentWorkRecord[] {
		const records: DocumentWorkRecord[] = [];
		for (const workId of this.listWorkIds()) {
			const read = this.readWork(workId);
			// 注意：不能用 `"ok" in read` 判定——失败分支同样有这个键（值为 false）。
			if (read.ok) {
				if (read.value.record.sessionId === sessionId) records.push(read.value.record);
				continue;
			}
			const display = this.readWorkForDisplay(workId);
			if (display.record?.sessionId === sessionId) records.push(display.record);
		}
		return records.sort((left, right) => left.createdAt - right.createdAt);
	}

	/**
	 * 同一会话里是否有"结果未知"的操作卡在这个运行时上。
	 *
	 * 这是**持久化**的保守恢复策略（不只内存租约）：未知分发意味着无法证明那一轮是否
	 * 已经在 pi 里跑过，因此同一个运行时上的新文稿 attempt 一律拒绝，直到
	 * 用户显式取消（操作转 interrupted）或会话换绑到新的运行时（agentId/世代不同）。
	 * 应用重启后这条判定照常生效；新运行时的三代组不同，天然不受影响。
	 */
	blockingUnknownOperation(input: { sessionId: string; target: { agentId: string; runtimeGeneration: number } }): DocumentWorkOperation | undefined {
		for (const work of this.listWorksForSession(input.sessionId)) {
			const read = this.readWork(work.workId);
			if (!read.ok) continue;
			for (const operation of Object.values(read.value.operations)) {
				if (operation.state !== "unknown") continue;
				if (operation.runtime.agentId !== input.target.agentId || operation.runtime.runtimeGeneration !== input.target.runtimeGeneration) continue;
				return operation;
			}
		}
		return undefined;
	}

	/** 哪些工作记录当前不可解析（损坏）；供恢复提示与诊断。 */
	corruptWorkIds(): string[] {
		return this.listWorkIds().filter((workId) => "error" in this.readWork(workId));
	}

	private mutateIndex<T>(plan: (index: DocumentWorkIndexState) => WorkResult<{ bucket: DocumentWorkIndexState; value: T }>): WorkResult<T> {
		let current: DocumentWorkIndexState;
		try {
			current = this.readIndexOrEmpty();
		} catch (error) {
			if (error instanceof CorruptDocumentWorkRecord) return workFail("IO_ERROR", false, { detail: error.reason });
			return workFail("IO_ERROR", true, { detail: "failed to read the document work index" });
		}
		const planned = plan(current);
		if ("error" in planned) return planned;
		try {
			this.writeJson(this.indexPath(), { ...planned.value.bucket, revision: current.revision + 1 });
		} catch (error) {
			if (error instanceof CorruptDocumentWorkRecord) return workFail("IO_ERROR", false, { detail: error.reason });
			return workFail("IO_ERROR", true, { detail: "failed to persist the document work index" });
		}
		return workOk(planned.value.value);
	}
}
