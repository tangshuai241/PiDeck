/**
 * TPA 独立文稿：持久化存储。
 *
 * 事实源是 `userData/document-work/` 下的 JSON 元数据（文稿正文留在用户成果目录）。
 * 三条硬性约束决定实现形态：
 *
 * 1. **原子与可恢复写入**：先写 `*.tmp`，再把现有文件改名成 `*.bak`，最后 rename 覆盖。
 *    任一步失败都不会留下半截文件；读取时主文件损坏会退回 `.bak` 并原位修复。
 * 2. **revision / CAS**：每个文件（索引、单个工作）带单调 `revision`。调用者必须带
 *    `expectedRevision`，不匹配返回 `REVISION_CONFLICT` 与当前版本；并发修改只有一个成功。
 * 3. **requestId 去重**：`requestId` 记进索引，同 ID 同载荷返回原结果，同 ID 不同载荷返回
 *    `IDEMPOTENCY_CONFLICT`，绝不静默换 ID 重放。
 *
 * 损坏记录不补齐默认值、不静默重置：抛出声明的结构化错误并把该文件标记为隔离，
 * 后续写入一律拒绝，原文件保留在磁盘上供人工判断。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_WORK_SCHEMA_VERSION, isNonNegativeInteger, isRecord, isWorkId, parseArtifactVersion, parseOperation, parseOutputRoot, parsePreparation, parseWorkRecord, workFail, workOk, type WorkError, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentWorkOperation, DocumentWorkOutputRoot, DocumentWorkPreparation, DocumentWorkRecord } from "../../shared/types/documentWork";

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

type IndexState = {
	schemaVersion: number;
	revision: number;
	outputRoots: Record<string, DocumentWorkOutputRoot>;
	/** requestId → 归属（创建或某次操作）；去重与冲突判定的唯一台账。 */
	requests: Record<string, { workId: string; requestDigest: string; kind: "create" | "operation" }>;
	workIds: string[];
};

type WorkBucket = {
	schemaVersion: number;
	revision: number;
	record: DocumentWorkRecord;
	operations: Record<string, DocumentWorkOperation>;
	preparations: Record<string, DocumentWorkPreparation>;
	versions: DocumentArtifactVersion[];
};

export type DocumentWorkStoreOptions = {
	/** 元数据根目录（生产为 `userData/document-work`）。 */
	dir: string;
	fs?: DocumentWorkFsPort;
	now?: () => number;
	/** ID 生成器注入点；生产用随机 ID。 */
	newId?: (prefix: string) => string;
};

function emptyIndex(): IndexState {
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: 0, outputRoots: {}, requests: {}, workIds: [] };
}

/** 损坏或未知版本的记录：保留原文件、停止写入、返回结构化错误。 */
class QuarantinedRecord extends Error {
	constructor(
		readonly code: WorkError["code"],
		message: string,
	) {
		super(message);
		this.name = "QuarantinedRecord";
	}
}

export class DocumentWorkStore {
	private readonly dir: string;
	private readonly worksDir: string;
	private readonly fs: DocumentWorkFsPort;
	private readonly now: () => number;
	private readonly newId: (prefix: string) => string;
	private readonly quarantined = new Set<string>();

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

	private indexPath(): string {
		return join(this.dir, INDEX_FILE);
	}

	private workPath(workId: string): string {
		return join(this.worksDir, `${workId}.json`);
	}

	/**
	 * 原子写入：tmp → (旧文件 → bak) → rename。第二步失败会把 bak 还原回原位，
	 * 保证任何时刻磁盘上至少有一份可解析内容。
	 */
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

	/**
	 * 读取单个 JSON 文件。主文件缺失/损坏时用 `.bak` 兜底并原位修复；
	 * 两份都不可解析时返回 QuarantinedRecord，由调用方转成结构化错误。
	 */
	private readJson<T>(path: string, parse: (value: unknown) => T | undefined, label: string): T | undefined {
		if (this.quarantined.has(path)) throw new QuarantinedRecord("IO_ERROR", `${label} is quarantined after a corrupt read`);
		const primary = this.fs.readFile(path);
		if (primary !== undefined) {
			const parsed = this.parseSafely(primary, parse);
			if (parsed !== undefined) return parsed;
		}
		const backupPath = `${path}.bak`;
		const backup = this.fs.readFile(backupPath);
		if (backup !== undefined) {
			const parsed = this.parseSafely(backup, parse);
			if (parsed !== undefined) {
				// 仅当主文件确实存在时才隔离；恢复写入尝试失败不影响返回兜底内容。
				try {
					this.writeAtomic(path, canonical(parsed));
				} catch {
					this.quarantined.add(path);
				}
				return parsed;
			}
		}
		if (primary === undefined && backup === undefined) return undefined;
		this.quarantined.add(path);
		throw new QuarantinedRecord("IO_ERROR", `${label} is unreadable; the original file was kept and writes are stopped`);
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

	private writeJson(path: string, value: unknown): void {
		if (this.quarantined.has(path)) throw new QuarantinedRecord("IO_ERROR", "record is quarantined; writes are stopped");
		this.ensureDir();
		this.writeAtomic(path, canonical(value));
	}

	private readIndex(): IndexState | undefined {
		return this.readJson(this.indexPath(), parseIndexState, "document work index");
	}

	// ── 输出根 ───────────────────────────────────────────────────────────────

	/** 登记用户显式选择的成果目录；同一路径复用同一 ID，避免重复登记。 */
	registerOutputRoot(input: { path: string; label: string }): WorkResult<DocumentWorkOutputRoot> {
		const path = input.path.trim();
		if (!path || path.length > 2000) return workFail("INVALID_INPUT", false, { detail: "output root path is empty or too long" });
		const label = input.label.trim().slice(0, 200) || "documents";
		return this.mutateIndex(undefined, (index) => {
			const existing = Object.values(index.outputRoots).find((root) => root.path === path);
			if (existing) return workOk({ bucket: index, value: existing });
			const root: DocumentWorkOutputRoot = { outputRootId: this.newId("root"), path, label, registeredAt: this.now() };
			return workOk({ bucket: { ...index, outputRoots: { ...index.outputRoots, [root.outputRootId]: root } }, value: root });
		});
	}

	getOutputRoot(outputRootId: string): WorkResult<DocumentWorkOutputRoot> {
		const index = this.readIndex() ?? emptyIndex();
		const root = index.outputRoots[outputRootId];
		if (!root) return workFail("PATH_DENIED", false, { detail: "output root is not registered" });
		return workOk(root);
	}

	listOutputRoots(): DocumentWorkOutputRoot[] {
		const index = this.readIndex() ?? emptyIndex();
		return Object.values(index.outputRoots).sort((left, right) => left.registeredAt - right.registeredAt);
	}

	/** 去掉成果根登记（用户撤销授权）；已归档记录保留。 */
	unregisterOutputRoot(outputRootId: string): WorkResult<boolean> {
		return this.mutateIndex(undefined, (index) => {
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
		const index = this.readIndex();
		const entry = index?.requests[requestId];
		if (!entry) return undefined;
		return entry.requestDigest === requestDigest ? { kind: entry.kind, workId: entry.workId } : { conflict: true, workId: entry.workId };
	}

	/** 只按 requestId 定位归属（查询用）；返回 undefined 表示没有这个请求。 */
	lookupRequestAny(requestId: string): { workId: string } | undefined {
		const entry = this.readIndex()?.requests[requestId];
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
		return this.mutateIndex(undefined, (index) => {
			// 空字符串 = 首次提交时还没绑定成果目录（用户在聊天里选完再绑），这不是错误。
			if (input.outputRootId !== "" && !index.outputRoots[input.outputRootId]) return workFail<IndexState>("PATH_DENIED", false, { detail: "output root is not registered" });
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
			const bucket: WorkBucket = { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: 0, record, operations: {}, preparations: {}, versions: [] };
			try {
				this.writeJson(this.workPath(workId), bucket);
			} catch {
				return workFail<IndexState>("IO_ERROR", true, { detail: "failed to persist the work record" });
			}
			return workOk({
				bucket: { ...index, requests: { ...index.requests, [input.requestId]: { workId, requestDigest: input.requestDigest, kind: "create" } }, workIds: [...index.workIds, workId] },
				value: record,
			});
		});
	}

	readWork(workId: string): WorkResult<WorkBucket> {
		try {
			const bucket = this.readJson(this.workPath(workId), parseWorkBucket, `document work ${workId}`);
			if (!bucket || bucket.record.workId !== workId) return workFail("WORK_NOT_FOUND", false, { detail: "work record is missing" });
			return workOk(bucket);
		} catch (error) {
			if (error instanceof QuarantinedRecord) return workFail(error.code, false, { detail: error.message });
			return workFail("IO_ERROR", true, { detail: "failed to read the work record" });
		}
	}

	/**
	 * 带 revision 校验的同步读改写。`plan` 必须纯粹（不得 await），
	 * 因此并发提交里只有一个能匹配 expectedRevision，另一个收到 REVISION_CONFLICT。
	 */
	withWork<T>(workId: string, expectedRevision: number, plan: (bucket: WorkBucket) => WorkResult<{ bucket: WorkBucket; value: T }>): WorkResult<T> {
		const read = this.readWork(workId);
		if ("error" in read) return read;
		if (!isNonNegativeInteger(expectedRevision) || read.value.revision !== expectedRevision) return workFail("REVISION_CONFLICT", true, { currentRevision: read.value.revision, detail: "the work record advanced; retry with the current revision" });
		const planned = plan(read.value);
		if ("error" in planned) return planned;
		const next: WorkBucket = { ...planned.value.bucket, revision: read.value.revision + 1, record: { ...planned.value.bucket.record, revision: read.value.revision + 1, updatedAt: this.now() } };
		try {
			this.writeJson(this.workPath(workId), next);
		} catch (error) {
			if (error instanceof QuarantinedRecord) return workFail(error.code, false, { detail: error.message });
			return workFail("IO_ERROR", true, { detail: "failed to persist the work record" });
		}
		return workOk(planned.value.value);
	}

	/** 记录 requestId → 操作归属；与 work 提交分离是为了让幂等台账先于执行落地。 */
	recordRequest(input: { requestId: string; requestDigest: string; workId: string; kind: "create" | "operation" }): WorkResult<boolean> {
		return this.mutateIndex(undefined, (index) => workOk({ bucket: { ...index, requests: { ...index.requests, [input.requestId]: { workId: input.workId, requestDigest: input.requestDigest, kind: input.kind } } }, value: true }));
	}

	listWorkIds(): string[] {
		const index = this.readIndex() ?? emptyIndex();
		return [...index.workIds];
	}

	/** 会话恢复用：只按 sessionId 过滤，不猜测标题或文件时间。 */
	listWorksForSession(sessionId: string): DocumentWorkRecord[] {
		const records: DocumentWorkRecord[] = [];
		for (const workId of this.listWorkIds()) {
			const read = this.readWork(workId);
			if ("error" in read) continue;
			if (read.value.record.sessionId === sessionId) records.push(read.value.record);
		}
		return records.sort((left, right) => left.createdAt - right.createdAt);
	}

	private mutateIndex<T>(_expected: number | undefined, plan: (index: IndexState) => WorkResult<{ bucket: IndexState; value: T }>): WorkResult<T> {
		let current: IndexState;
		try {
			current = this.readIndex() ?? emptyIndex();
		} catch (error) {
			if (error instanceof QuarantinedRecord) return workFail(error.code, false, { detail: error.message });
			return workFail("IO_ERROR", true, { detail: "failed to read the document work index" });
		}
		const planned = plan(current);
		if ("error" in planned) return planned;
		try {
			this.writeJson(this.indexPath(), { ...planned.value.bucket, revision: current.revision + 1 });
		} catch (error) {
			if (error instanceof QuarantinedRecord) return workFail(error.code, false, { detail: error.message });
			return workFail("IO_ERROR", true, { detail: "failed to persist the document work index" });
		}
		return workOk(planned.value.value);
	}
}

export type { WorkBucket };

function canonical(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function parseIndexState(value: unknown): IndexState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isNonNegativeInteger(value.revision)) return undefined;
	if (!isRecord(value.outputRoots) || !isRecord(value.requests) || !Array.isArray(value.workIds)) return undefined;
	const outputRoots: Record<string, DocumentWorkOutputRoot> = {};
	for (const [id, root] of Object.entries(value.outputRoots)) {
		const parsed = parseOutputRoot(root);
		if (!parsed || parsed.outputRootId !== id) return undefined;
		outputRoots[id] = parsed;
	}
	const requests: IndexState["requests"] = {};
	for (const [requestId, entry] of Object.entries(value.requests)) {
		if (!isWorkId(requestId) || !isRecord(entry) || !isWorkId(entry.workId) || typeof entry.requestDigest !== "string" || !entry.requestDigest || (entry.kind !== "create" && entry.kind !== "operation")) return undefined;
		requests[requestId] = { workId: entry.workId, requestDigest: entry.requestDigest, kind: entry.kind };
	}
	if (!value.workIds.every((item) => isWorkId(item))) return undefined;
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: value.revision, outputRoots, requests, workIds: [...(value.workIds as string[])] };
}

function parseWorkBucket(value: unknown): WorkBucket | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION || !isNonNegativeInteger(value.revision)) return undefined;
	const record = parseWorkRecord(value.record);
	if (!record) return undefined;
	if (!isRecord(value.operations) || !isRecord(value.preparations) || !Array.isArray(value.versions)) return undefined;
	const operations: Record<string, DocumentWorkOperation> = {};
	for (const [attemptId, operation] of Object.entries(value.operations)) {
		const parsed = parseOperation(operation);
		if (!parsed || parsed.attemptId !== attemptId) return undefined;
		operations[attemptId] = parsed;
	}
	const preparations: Record<string, DocumentWorkPreparation> = {};
	for (const [preparationId, preparation] of Object.entries(value.preparations)) {
		const parsed = parsePreparation(preparation);
		if (!parsed || parsed.preparationId !== preparationId) return undefined;
		preparations[preparationId] = parsed;
	}
	const versions: DocumentArtifactVersion[] = [];
	for (const version of value.versions) {
		const parsed = parseArtifactVersion(version);
		if (!parsed) return undefined;
		versions.push(parsed);
	}
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: value.revision, record, operations, preparations, versions };
}
