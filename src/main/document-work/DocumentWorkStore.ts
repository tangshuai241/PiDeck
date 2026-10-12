/**
 * 文稿元数据事实源：`userData/document-work/`。
 *
 * 分工：
 * - 这里是工作、操作、准备与版本记录的权威存储，Pi 原生会话仍是对话事实源；
 * - 所有写入都经原子替换 + `.bak` 回退；`revision` 做乐观并发检查；
 * - `requestId` 去重按「同 requestId 必须同载荷」判定，重放返回原结果而不是再执行一次。
 *
 * 崩溃恢复：进程重启后仍在 dispatching/running/inspecting 的操作不会被自动重放，
 * 统一落成 `interrupted`，等待用户重新发起。
 */
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { hashText, readJsonResilient, readJsonWithHealth, writeFileAtomic, ensureDirectory } from "./documentWorkPaths";
import { isRequestId, isWorkId, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import { parseDocumentOutputRoot, parseDocumentWorkOperation, parseDocumentWorkPreparation, parseArtifactVersion, parseDocumentWorkRecord } from "../../shared/documentWorkRecords";
import type { DocumentArtifactVersion, DocumentOutputRoot, DocumentWorkOperation, DocumentWorkPreparation, DocumentWorkRecord } from "../../shared/types/documentWork";

/** 无重叠的键控串行锁：同一工作的读改写不会互相覆盖。 */
class KeyedMutex {
	private readonly tails = new Map<string, Promise<unknown>>();

	async run<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		// 无论前一个任务成功或失败都继续排队；失败由各自的调用者结算。
		const next = previous.then(action, action);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, settled);
		try {
			return await next;
		} finally {
			// 只有队尾仍是自己时才回收，避免删掉后来者的排队记录。
			if (this.tails.get(key) === settled) this.tails.delete(key);
		}
	}
}

type IdempotencyEntry = { requestDigest: string; payload: unknown };

export class DocumentWorkStore {
	private readonly mutex = new KeyedMutex();

	constructor(
		private readonly rootDir: string,
		private readonly logger?: { warn(scope: string, message: string, detail?: unknown): unknown },
	) {}

	get directory(): string {
		return this.rootDir;
	}

	/** 材料转换缓存根：交给扩展写入，仍由 TPA 管理，不落在用户成果目录里。 */
	get materialCacheDirectory(): string {
		return join(this.rootDir, "materials", "cache");
	}

	private workDir(workId: string): string {
		return join(this.rootDir, "works", workId);
	}

	async initialize(): Promise<void> {
		await ensureDirectory(join(this.rootDir, "works"));
		await ensureDirectory(join(this.rootDir, "idempotency"));
		await ensureDirectory(join(this.rootDir, "frozen"));
		await ensureDirectory(join(this.rootDir, "snapshots"));
		await ensureDirectory(join(this.rootDir, "materials"));
		await ensureDirectory(this.materialCacheDirectory);
	}

	// ---------------------------------------------------------------- output roots

	private get outputRootsFile(): string {
		return join(this.rootDir, "output-roots.json");
	}

	async listOutputRoots(): Promise<DocumentOutputRoot[]> {
		const raw = await readJsonResilient(this.outputRootsFile);
		if (!Array.isArray(raw)) return [];
		const roots: DocumentOutputRoot[] = [];
		for (const entry of raw) {
			const parsed = parseDocumentOutputRoot(entry);
			if (parsed) roots.push(parsed);
		}
		return roots;
	}

	/** 同一个真实路径只登记一次；重复选择返回既有条目，不产生第二个 ID。 */
	async registerOutputRoot(realPath: string, label: string): Promise<DocumentOutputRoot> {
		return this.mutex.run("output-roots", async () => {
			const existing = await this.listOutputRoots();
			const match = existing.find((root) => root.path.toLowerCase() === realPath.toLowerCase());
			if (match) return match;
			const entry: DocumentOutputRoot = { outputRootId: `or_${hashText(realPath).slice(0, 16)}`, label, path: realPath, addedAt: Date.now() };
			await writeFileAtomic(this.outputRootsFile, JSON.stringify([...existing, entry], null, 2));
			return entry;
		});
	}

	async getOutputRoot(outputRootId: string): Promise<DocumentOutputRoot | undefined> {
		return (await this.listOutputRoots()).find((root) => root.outputRootId === outputRootId);
	}

	// ---------------------------------------------------------------- work records

	/**
	 * 工作记录读取带健康度：`corrupt` 表示主档存在但读不动。
	 * 调用方据此只做只读展示，不拿旧备份重新授权或覆写损坏原件。
	 */
	async readRecordState(workId: string): Promise<{ kind: "ok"; record: DocumentWorkRecord } | { kind: "missing" } | { kind: "corrupt"; recovered?: DocumentWorkRecord }> {
		if (!isWorkId(workId)) return { kind: "missing" };
		const result = await readJsonWithHealth(join(this.workDir(workId), "work.json"));
		if (result.kind === "ok") {
			const record = parseDocumentWorkRecord(result.value);
			// 主档能解析成 JSON 但不符合契约，同样属于「损坏」，不能当成不存在。
			return record ? { kind: "ok", record } : { kind: "corrupt" };
		}
		if (result.kind === "missing") return { kind: "missing" };
		const recovered = parseDocumentWorkRecord(result.recovered);
		this.logger?.warn("document-work", "Work record is corrupt", { workId, hasBackup: recovered !== undefined });
		return { kind: "corrupt", ...(recovered ? { recovered } : {}) };
	}

	/** 只读路径：允许用备份当作恢复证据展示，但拿不到可写记录。 */
	async getRecord(workId: string): Promise<DocumentWorkRecord | undefined> {
		const state = await this.readRecordState(workId);
		return state.kind === "ok" ? state.record : state.kind === "corrupt" ? state.recovered : undefined;
	}

	async saveRecord(record: DocumentWorkRecord): Promise<void> {
		await writeFileAtomic(join(this.workDir(record.workId), "work.json"), JSON.stringify(record, null, 2));
		await this.writeSessionIndex(record.sessionId, record.workId);
	}

	/** 会话索引保存全部工作，不只最后一件；旧格式（单 workId）仍然读得懂。 */
	private async writeSessionIndex(sessionId: string, workId: string): Promise<void> {
		const file = join(this.rootDir, "sessions", `${hashText(sessionId)}.json`);
		// 索引是「同一会话多件工作」的恢复入口，读改写必须在自己的锁里，否则并发保存会丢工作。
		await this.mutex.run(`session-index:${hashText(sessionId)}`, async () => {
			const existing = await this.listWorkIdsForSession(sessionId);
			const workIds = existing.includes(workId) ? existing : [...existing, workId];
			await writeFileAtomic(file, JSON.stringify({ sessionId, workIds }));
		});
	}

	async listWorkIdsForSession(sessionId: string): Promise<string[]> {
		const raw = await readJsonResilient(join(this.rootDir, "sessions", `${hashText(sessionId)}.json`));
		if (typeof raw !== "object" || raw === null) return [];
		if (Reflect.get(raw, "sessionId") !== sessionId) return [];
		const workIds = Reflect.get(raw, "workIds");
		if (Array.isArray(workIds)) return workIds.filter((candidate) => isWorkId(candidate));
		// 兼容旧格式：只有一个 workId。
		const single = Reflect.get(raw, "workId");
		return isWorkId(single) ? [single] : [];
	}

	/**
	 * 乐观并发的唯一写入口。`expectedRevision` 为 undefined 时只允许创建；
	 * 传入数字时必须与磁盘一致，否则返回带 currentRevision 的冲突。
	 */
	async mutateRecord(workId: string, expectedRevision: number | undefined, mutate: (record: DocumentWorkRecord) => DocumentWorkRecord | undefined): Promise<WorkResult<DocumentWorkRecord>> {
		return this.mutex.run(`work:${workId}`, async () => {
			const state = await this.readRecordState(workId);
			// 损坏的主档不能被旧备份顶替后继续写：那会重新授予已经失效的授权。
			if (state.kind === "corrupt") return workFailure<DocumentWorkRecord>("IO_ERROR", "record_corrupt");
			if (state.kind === "missing") return workFailure<DocumentWorkRecord>("WORK_NOT_FOUND");
			const existing = state.record;
			if (expectedRevision === undefined) return workFailure<DocumentWorkRecord>("IDEMPOTENCY_CONFLICT");
			if (existing.revision !== expectedRevision) return workFailure<DocumentWorkRecord>("REVISION_CONFLICT", undefined, existing.revision);
			const mutated = mutate(existing);
			if (!mutated) return workFailure<DocumentWorkRecord>("INVALID_INPUT");
			const next: DocumentWorkRecord = { ...mutated, revision: existing.revision + 1, updatedAt: Date.now() };
			await this.saveRecord(next);
			return workSuccess(next);
		});
	}

	async createRecord(record: DocumentWorkRecord): Promise<WorkResult<DocumentWorkRecord>> {
		return this.mutex.run(`work:${record.workId}`, async () => {
			const state = await this.readRecordState(record.workId);
			if (state.kind === "ok") return workSuccess(state.record);
			// 损坏 ≠ 不存在：重建会覆盖损坏原件并丢掉恢复入口。
			if (state.kind === "corrupt") return workFailure<DocumentWorkRecord>("IO_ERROR", "record_corrupt");
			await this.saveRecord(record);
			return workSuccess(record);
		});
	}

	// ---------------------------------------------------------------- idempotency

	private idempotencyFile(requestId: string): string {
		return join(this.rootDir, "idempotency", `${requestId}.json`);
	}

	/** 同 requestId 不同载荷必须显式失败，不能悄悄按后来的载荷执行。 */
	async readIdempotent(requestId: string, requestDigest: string): Promise<{ kind: "miss" } | { kind: "hit"; payload: unknown } | { kind: "conflict" }> {
		if (!isRequestId(requestId)) return { kind: "conflict" };
		const read = await readJsonWithHealth(this.idempotencyFile(requestId));
		// 去重槽损坏时 fail-closed：宁可拒绝重放，也不能把已执行过的请求当成新请求。
		if (read.kind === "corrupt") return { kind: "conflict" };
		if (read.kind === "missing") return { kind: "miss" };
		const raw = read.value;
		if (typeof raw !== "object" || raw === null) return { kind: "conflict" };
		const entry = raw as Partial<IdempotencyEntry>;
		if (typeof entry.requestDigest !== "string") return { kind: "conflict" };
		if (entry.requestDigest !== requestDigest) return { kind: "conflict" };
		return { kind: "hit", payload: entry.payload };
	}

	/** 去重槽损坏时拒绝写入：不能把损坏原件替换成一份看起来正常的回执。 */
	async writeIdempotent(requestId: string, requestDigest: string, payload: unknown): Promise<boolean> {
		const entry: IdempotencyEntry = { requestDigest, payload };
		const existing = await readJsonWithHealth(this.idempotencyFile(requestId));
		if (existing.kind === "corrupt") {
			this.logger?.warn("document-work", "Idempotency record is corrupt; refusing to overwrite", { requestId });
			return false;
		}
		await writeFileAtomic(this.idempotencyFile(requestId), JSON.stringify(entry));
		return true;
	}

	/** 跨 store 调用串行化（读取→动作→回执），供服务层包裹去重路径。 */
	async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
		return this.mutex.run(`exclusive:${key}`, action);
	}

	// ---------------------------------------------------------------- operations / preparations / versions

	private operationsDir(workId: string): string {
		return join(this.workDir(workId), "operations");
	}

	async saveOperation(operation: DocumentWorkOperation): Promise<void> {
		await writeFileAtomic(join(this.operationsDir(operation.workId), `${operation.requestId}.json`), JSON.stringify(operation, null, 2));
	}

	async getOperation(workId: string, requestId: string): Promise<DocumentWorkOperation | undefined> {
		if (!isWorkId(workId) || !isRequestId(requestId)) return undefined;
		const raw = await readJsonResilient(join(this.operationsDir(workId), `${requestId}.json`));
		return parseDocumentWorkOperation(raw, workId);
	}

	async savePreparation(preparation: DocumentWorkPreparation): Promise<void> {
		await writeFileAtomic(join(this.workDir(preparation.workId), "preparations", `${preparation.preparationId}.json`), JSON.stringify(preparation, null, 2));
	}

	async getPreparation(workId: string, preparationId: string): Promise<DocumentWorkPreparation | undefined> {
		if (!isWorkId(workId) || !isWorkId(preparationId)) return undefined;
		const raw = await readJsonResilient(join(this.workDir(workId), "preparations", `${preparationId}.json`));
		return parseDocumentWorkPreparation(raw, workId);
	}

	async saveVersion(version: DocumentArtifactVersion): Promise<void> {
		await writeFileAtomic(join(this.workDir(version.workId), "versions", `${version.versionId}.json`), JSON.stringify(version, null, 2));
	}

	async getVersion(workId: string, versionId: string): Promise<DocumentArtifactVersion | undefined> {
		if (!isWorkId(workId) || !isWorkId(versionId)) return undefined;
		const raw = await readJsonResilient(join(this.workDir(workId), "versions", `${versionId}.json`));
		return parseArtifactVersion(raw, workId);
	}

	async listVersions(workId: string, versionIds: readonly string[]): Promise<DocumentArtifactVersion[]> {
		const versions: DocumentArtifactVersion[] = [];
		for (const versionId of versionIds) {
			const version = await this.getVersion(workId, versionId);
			if (version) versions.push(version);
		}
		return versions;
	}

	/**
	 * 启动时结算：进程不在运行，任何进行中的分发都不可能完成。
	 * 只改状态、不重放，也不把中断伪装成失败以外的结果。
	 */
	async recoverInterruptedOperation(operation: DocumentWorkOperation): Promise<DocumentWorkOperation> {
		if (operation.phase !== "dispatching" && operation.phase !== "running" && operation.phase !== "inspecting") return operation;
		const recovered: DocumentWorkOperation = {
			...operation,
			phase: operation.dispatchUnknown ? "unknown" : "interrupted",
			error: operation.dispatchUnknown ? { code: "DISPATCH_UNKNOWN", retryable: false } : { code: "IO_ERROR", retryable: false, detail: "interrupted" },
			updatedAt: Date.now(),
		};
		await this.saveOperation(recovered);
		return recovered;
	}

	/** 只删本次尝试的 staging 目录；已归档版本与冻结副本永不清理。 */
	async removeStaging(stagingDirectory: string): Promise<void> {
		await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
	}

	/** 启动结算用：枚举全部工作记录。单条损坏只跳过它，不影响其他工作。 */
	async listAllRecords(): Promise<DocumentWorkRecord[]> {
		const worksDirectory = join(this.rootDir, "works");
		const entries = await readdir(worksDirectory, { withFileTypes: true }).catch(() => []);
		const records: DocumentWorkRecord[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const record = await this.getRecord(entry.name);
			if (record) records.push(record);
		}
		return records;
	}
}
