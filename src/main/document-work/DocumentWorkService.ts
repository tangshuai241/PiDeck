/**
 * TPA 独立文稿：工作编排（生命周期与事务边界）。
 *
 * 状态机：`prepared → dispatching → running → inspecting → archived`，另有
 * `failed / interrupted / unknown`。三条不变量贯穿全文件：
 *
 * 1. **先持久化再分发**：请求与准备身份落盘成功之后才允许发 RPC；`accepted` 只表示
 *    "RPC 收到了"，不等于授权成功，更不等于执行完成。
 * 2. **事务边界**：`prepare` / `start` / `cancel` 全程持同一把按 workId 的互斥锁，
 *    覆盖"检查活动操作 → 校验授权 → 写记录 → 发 RPC"整段；否则两次并发确认会
 *    双双通过 activeOperationId 检查，发出两次 approve。
 * 3. **每次异步步骤后复查运行时**：`SessionRuntimeTarget` 在等待窗口内被替换就必须中止
 *    并记 `RUNTIME_CHANGED`；旧 attempt / 旧会话 / 旧世代的迟到消息一律忽略。
 *
 * 授权、范围与材料的判定在 `DocumentWorkRound`；绑定与派发在 `DocumentWorkDispatcher`；
 * 归档在 `DocumentArchiveService`。
 */
import { createHash } from "node:crypto";
import { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_SCHEMA_VERSION, canonicalJson, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type { DocumentWorkChangedEvent, DocumentWorkOperation, DocumentWorkPreparation, DocumentWorkRecord, DocumentWorkRevisionIntent, DocumentWorkSnapshot, PreparedWork } from "../../shared/types/documentWork";
import type { DocumentWorkRuntimePort, DocumentWorkRuntimeTarget, DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import { runtimeStillMatches } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import type { ArchiveOutcome, DocumentArchiveService } from "./DocumentArchiveService";
import { collectMaterials, instructionDigest, parseCreate, parsePrepare, parseStart, resolveCreateAuthorization, resolveRevisionRound, type ParsedPrepare, type ParsedStart, type ResolvedRound } from "./DocumentWorkRound";
import type { DocumentWorkBucketState } from "./DocumentWorkStoreCodec";

/** withWork 成功结果的别名，避免在方法签名里重复展开条件类型。 */
type WorkBucketStateResult = { ok: true; value: DocumentWorkBucketState };
import { KeyedMutex } from "./KeyedMutex";
import { DocumentWorkRuntimeLease } from "./DocumentWorkRuntimeLease";
import { finishOperation } from "./DocumentWorkLedger";
import { DocumentWorkDispatcher } from "./DocumentWorkDispatcher";
import { selectBaseVersion } from "./DocumentRevisionPolicy";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";

export type DocumentWorkServiceDeps = {
	store: DocumentWorkStore;
	runtime: DocumentWorkRuntimePort;
	adapter: DocumentWorkRuntimeAdapter;
	archive: DocumentArchiveService;
	pathFs: DocumentPathFsPort;
	/** TPA 管理根（`userData/document-work`）：快照与转换缓存都在它下面。 */
	workRoot: string;
	emit: (event: DocumentWorkChangedEvent) => void;
	/** 读取冻结基稿里的标题（用于把"第N节"落到真实章节）；失败按空处理。 */
	readBaseHeadings: (absolutePath: string) => Promise<string[]>;
	now?: () => number;
	newId?: (prefix: string) => string;
	bindAckMs?: number;
	settleMs?: number;
	/** 运行时租约（装配层与测试可注入；默认自建）。 */
	lease?: DocumentWorkRuntimeLease;
};

function digestOf(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class DocumentWorkService {
	private readonly deps: DocumentWorkServiceDeps;
	private readonly now: () => number;
	private readonly newId: (prefix: string) => string;
	private readonly dispatcher: DocumentWorkDispatcher;
	private readonly mutex = new KeyedMutex();
	/** 同一运行时上的排他所有权：占用 → 绑定 → 运行 → 结算。 */
	private readonly lease: DocumentWorkRuntimeLease;
	private readonly inFlight = new Map<string, Promise<void>>();
	/** 已经处理过的改稿意向（workId:turnId），同一轮绝不派发第二次。 */
	private readonly handledIntents = new Set<string>();

	constructor(deps: DocumentWorkServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.newId = deps.newId ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`);
		this.lease = deps.lease ?? new DocumentWorkRuntimeLease({ now: this.now });
		this.dispatcher = new DocumentWorkDispatcher({ store: deps.store, runtime: deps.runtime, adapter: deps.adapter, archive: deps.archive, emit: deps.emit, lease: this.lease, now: this.now, ...(deps.bindAckMs === undefined ? {} : { bindAckMs: deps.bindAckMs }) });
	}

	/** 停止服务时等未完成的编排自行收口；磁盘记录与未结算操作保持不变。 */
	async shutdown(): Promise<void> {
		const pending = [...this.inFlight.values()];
		this.inFlight.clear();
		await Promise.allSettled(pending);
		// 退出清理与申请配对：不留下占着运行时的租约。
		this.lease.releaseAll();
	}

	private track(attemptId: string, task: Promise<void>): void {
		this.inFlight.set(attemptId, task);
		void task.finally(() => this.inFlight.delete(attemptId));
	}

	// ── 创建 ─────────────────────────────────────────────────────────────────

	async create(input: unknown): Promise<WorkResult<DocumentWorkRecord>> {
		const parsed = parseCreate(input);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		// 同一会话的创建串行化：并发两次 create 不会生成两件工作记录。
		return await this.mutex.run(`session:${value.sessionId}`, async () => {
			const requestDigest = digestOf({ kind: "create", sessionId: value.sessionId, sourceTurnId: value.sourceTurnId, title: value.title, outputRootId: value.outputRootId });
			const result = this.deps.store.createWork({ ...value, requestDigest });
			if ("error" in result) return result;
			this.deps.emit({ workId: result.value.workId, sessionId: result.value.sessionId, revision: result.value.revision, changeKind: "created" });
			return workOk(result.value);
		});
	}

	// ── 读取 ─────────────────────────────────────────────────────────────────

	async get(input: unknown): Promise<WorkResult<DocumentWorkSnapshot>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "get input must be an object" });
		const value = input as Record<string, unknown>;
		if (typeof value.workId !== "string" || typeof value.sessionId !== "string" || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "workId and sessionId are required" });
		return this.snapshot(value.workId, value.sessionId);
	}

	private snapshot(workId: string, sessionId: string): WorkResult<DocumentWorkSnapshot> {
		const read = this.deps.store.readWork(workId);
		if ("error" in read) {
			// 记录损坏：给出**只读**展示（含 .bak 里的旧内容）与明确原因，不自动修复、不重建。
			const display = this.deps.store.readWorkForDisplay(workId);
			if (!display.record || display.record.sessionId !== sessionId) return read;
			return workOk({ work: display.record, versions: display.versions, corrupt: display.corrupt ?? { reason: "the work record is unreadable" } });
		}
		if (read.value.record.sessionId !== sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const record = read.value.record;
		const operations = Object.values(read.value.operations);
		const operation = (record.activeOperationId ? read.value.operations[record.activeOperationId] : undefined) ?? operations.sort((left, right) => right.updatedAt - left.updatedAt)[0];
		const root = record.outputRootId ? this.deps.store.getOutputRoot(record.outputRootId) : undefined;
		return workOk({
			work: record,
			...(operation ? { operation } : {}),
			versions: [...read.value.versions],
			...(root && root.ok ? { outputRootPath: root.value.path } : {}),
		});
	}

	async listForSession(sessionId: unknown): Promise<WorkResult<DocumentWorkRecord[]>> {
		if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
		return workOk(this.deps.store.listWorksForSession(sessionId));
	}

	// ── 准备 ─────────────────────────────────────────────────────────────────

	async prepare(input: unknown): Promise<WorkResult<PreparedWork>> {
		const parsed = parsePrepare(input);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		return await this.mutex.run(`work:${value.workId}`, async () => this.prepareLocked(value));
	}

	private async prepareLocked(value: ParsedPrepare): Promise<WorkResult<PreparedWork>> {
		const read = this.deps.store.readWork(value.workId);
		if ("error" in read) return read;
		if (read.value.record.sessionId !== value.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const record = read.value.record;
		const target = await this.deps.runtime.resolveRuntime(value.sessionId);
		if (!target) return workFail("RUNTIME_CHANGED", true, { detail: "the session has no live runtime to bind" });
		const alignment = await this.deps.runtime.readAlignment(target);
		const materialRoots = this.materialRootsFor(record, target);
		const materialCandidates = alignment?.brief?.materials ?? [];
		const stagingRelativeDir = this.stagingDirFor(record.workId, value.requestId);

		let base: DocumentWorkPreparation["base"];
		let round: ResolvedRound;
		let stagingPrepared = false;
		if (value.kind === "create_document") {
			// 首次制作只认**当前**对齐确认单；用户指令/模型文本/布尔值都不在此列。
			const authorized = resolveCreateAuthorization({ requirementsRef: value.requirementsRef, alignment });
			if ("error" in authorized) return authorized;
			round = { scope: authorized.value.scope, requirementsRef: value.requirementsRef, authorization: authorized.value.authorization, materials: [], materialRoots, summary: "create a new document" };
		} else {
			const root = record.outputRootId ? this.deps.store.getOutputRoot(record.outputRootId) : workFail<never>("PATH_DENIED", false, { detail: "no output folder is bound to this work yet" });
			if ("error" in root) return root;
			const selection = selectBaseVersion({
				versions: read.value.versions,
				explicitVersionId: value.baseVersionId,
				readCurrentDigest: (relativePath) => {
					const resolved = resolveWithinRoot(this.deps.pathFs, root.value.path, relativePath);
					if (!resolved.ok) return undefined;
					const data = this.deps.pathFs.readFile(resolved.absolutePath);
					return data ? createHash("sha256").update(data).digest("hex") : undefined;
				},
			});
			if ("error" in selection) return selection;
			base = selection.value.base;
			// 先冻结基稿副本，再按真实存在的章节定范围（顺序不能反）。
			const staging = await this.deps.archive.prepareStaging({ outputRootPath: root.value.path, outputRelativeDir: record.workId, stagingRelativeDir, base });
			if ("error" in staging) return staging;
			stagingPrepared = true;
			const headings = staging.value.frozenBaseAbsolutePath ? await this.deps.readBaseHeadings(staging.value.frozenBaseAbsolutePath).catch(() => [] as string[]) : [];
			const turn = await this.deps.runtime.readUserTurn({ sessionId: value.sessionId, turnId: value.feedbackSourceTurnId as string });
			const resolved = resolveRevisionRound({
				instruction: turn?.text ?? "",
				turn,
				sourceTurnId: value.feedbackSourceTurnId as string,
				baseHeadings: headings,
				inheritedPreserve: alignment?.brief?.preserve ?? [],
			});
			if ("error" in resolved) return resolved;
			round = { scope: resolved.value.scope, requirementsRef: value.requirementsRef, authorization: resolved.value.authorization, materials: [], materialRoots, instruction: resolved.value.instruction, summary: resolved.value.summary };
		}
		return await this.persistPreparation({ value, read, record, round, base, materialCandidates, materialRoots, stagingRelativeDir, stagingPrepared });
	}

	/** 准备记录落盘（在互斥内）：staging 骨架 + 冻结基稿 + 材料登记 + CAS 写入。 */
	private async persistPreparation(input: {
		value: ParsedPrepare;
		read: WorkBucketStateResult;
		record: DocumentWorkRecord;
		round: ResolvedRound;
		base: DocumentWorkPreparation["base"];
		materialCandidates: readonly string[];
		materialRoots: DocumentWorkPreparation["materialRoots"];
		stagingRelativeDir: string;
		stagingPrepared: boolean;
	}): Promise<WorkResult<PreparedWork>> {
		if (!input.stagingPrepared) {
			const root = input.record.outputRootId ? this.deps.store.getOutputRoot(input.record.outputRootId) : workFail<never>("PATH_DENIED", false, { detail: "no output folder is bound to this work yet" });
			if ("error" in root) return root;
			const staging = await this.deps.archive.prepareStaging({ outputRootPath: root.value.path, outputRelativeDir: input.record.workId, stagingRelativeDir: input.stagingRelativeDir, base: input.base });
			if ("error" in staging) return staging;
		}
		const materials = collectMaterials({ roots: input.materialRoots, candidates: input.materialCandidates, pathFs: this.deps.pathFs, newId: this.newId });
		const preparationId = this.newId("prep");
		const draft: Omit<DocumentWorkPreparation, "digest"> = {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			preparationId,
			kind: input.value.kind,
			workRevision: input.read.value.revision + 1,
			requirementsRef: input.round.requirementsRef,
			authorization: input.round.authorization,
			materials,
			materialRoots: [...input.materialRoots],
			...(input.base ? { base: input.base } : {}),
			scope: input.round.scope,
			...(input.round.instruction ? { instruction: input.round.instruction } : {}),
			stagingRelativeDir: input.stagingRelativeDir,
			outputRelativeDir: input.record.workId,
			createdAt: this.now(),
		};
		const preparation: DocumentWorkPreparation = { ...draft, digest: digestOf(draft) };
		const prepared = this.deps.store.withWork(input.record.workId, input.value.expectedRevision, (bucket) => {
			const next: DocumentWorkRecord = { ...bucket.record, requirementsRef: input.round.requirementsRef };
			return workOk({ bucket: { ...bucket, record: next, preparations: { ...bucket.preparations, [preparation.preparationId]: preparation } }, value: preparation });
		});
		if ("error" in prepared) return prepared;
		this.deps.emit({ workId: input.record.workId, sessionId: input.value.sessionId, revision: prepared.value.workRevision, changeKind: "prepared" });
		return workOk({ workId: input.record.workId, workRevision: prepared.value.workRevision, preparation: { preparationId: preparation.preparationId, digest: preparation.digest }, summary: input.round.summary });
	}

	private stagingDirFor(workId: string, requestId: string): string {
		// staging 目录名必须稳定可复算：同一 requestId 重试落在同一目录，不产生垃圾。
		return `${workId}/staging/${requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "round"}`;
	}

	/**
	 * 材料读取的授权根：成果目录 + 会话项目目录。
	 *
	 * 两者都来自用户已有的授权入口（成果目录选择器 / 项目目录登记），因此材料不必
	 * 搬进输出目录；扩展只能在这些根内按相对路径解析。
	 */
	private materialRootsFor(record: DocumentWorkRecord, target: DocumentWorkRuntimeTarget): DocumentWorkPreparation["materialRoots"] {
		const roots: DocumentWorkPreparation["materialRoots"] = [];
		if (record.outputRootId) {
			const root = this.deps.store.getOutputRoot(record.outputRootId);
			if (root.ok) roots.push({ rootId: root.value.outputRootId, kind: "output_root", path: root.value.path, label: root.value.label });
		}
		if (target.projectRoot) roots.push({ rootId: "project", kind: "project_root", path: target.projectRoot, label: "project" });
		return roots;
	}

	// ── 分发 ─────────────────────────────────────────────────────────────────

	async start(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		const parsed = parseStart(input, this.newId);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		return await this.mutex.run(`work:${value.workId}`, async () => this.startLocked(value));
	}

	private async startLocked(value: ParsedStart): Promise<WorkResult<DocumentWorkOperation>> {
		const read = this.deps.store.readWork(value.workId);
		if ("error" in read) return read;
		const record = read.value.record;
		if (record.sessionId !== value.expectedRuntime.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const requestDigest = digestOf({ kind: "start", workId: value.workId, preparationId: value.preparation.preparationId, operationKind: value.kind, authorization: value.authorization });
		const previous = this.deps.store.lookupRequest(value.requestId, requestDigest);
		if (previous && "conflict" in previous) return workFail("IDEMPOTENCY_CONFLICT", false, { detail: "requestId was used with a different payload" });
		if (previous) {
			// 幂等：同一请求返回原操作，绝不二次派发。
			const attemptId = record.requests[value.requestId]?.attemptId;
			const existing = attemptId ? read.value.operations[attemptId] : undefined;
			if (existing) return workOk(existing);
		}
		const preparation = read.value.preparations[value.preparation.preparationId];
		if (!preparation) return workFail("PREPARATION_STALE", true, { detail: "the preparation does not belong to this work" });
		if (preparation.digest !== value.preparation.digest) return workFail("PREPARATION_STALE", true, { detail: "the preparation content changed" });
		if (preparation.kind !== value.kind) return workFail("PREPARATION_STALE", true, { detail: "the preparation was made for a different operation kind" });

		const target = await this.deps.runtime.resolveRuntime(value.expectedRuntime.sessionId);
		if (!target || target.agentId !== value.expectedRuntime.agentId || target.runtimeGeneration !== value.expectedRuntime.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the session runtime changed before dispatch" });
		if (target.piSessionId === undefined) return workFail("EXTENSION_UNAVAILABLE", true, { detail: "the native pi session identity is not available" });
		if (value.expectedRuntime.piSessionId !== undefined && value.expectedRuntime.piSessionId !== target.piSessionId) return workFail("RUNTIME_CHANGED", true, { detail: "the native pi session changed before dispatch" });
		const authorized = await this.verifyAuthorization({ preparation, authorization: value.authorization, sessionId: value.expectedRuntime.sessionId });
		if ("error" in authorized) return authorized;
		const flags = await this.deps.runtime.runtimeFlags(target);
		if (flags.busy || flags.queued) return workFail("RUNTIME_BUSY", true, { detail: "the session runtime is busy or has queued input" });
		// 互斥内再查一次活动操作：并发确认只有一个能派发。
		if (record.activeOperationId) {
			const active = read.value.operations[record.activeOperationId];
			if (active && !this.isTerminal(active.state)) return workFail("RUNTIME_BUSY", true, { detail: "this work already has a run in flight" });
		}
		// 未知分发：无法证明上一轮是否已经在 pi 里跑过，同一个运行时上的新 attempt 一律拒绝，
		// 直到显式取消或换绑（持久化判定，重启后仍生效）。
		const blockingUnknown = this.deps.store.blockingUnknownOperation({ sessionId: value.expectedRuntime.sessionId, target });
		if (blockingUnknown) {
			return workFail("DISPATCH_UNKNOWN", true, { detail: `an earlier attempt (${blockingUnknown.attemptId}) on this runtime has an unknown outcome; cancel it or restart the session runtime before starting another round` });
		}
		// 同一运行时上只允许一件文稿工作：占用发生在**任何 RPC 之前**，所以两件不同工作
		// 并发确认时，后到的那件在绑定之前就被拒（不会互相覆盖绑定）。
		const lease = this.lease.acquire({ target, workId: value.workId, attemptId: value.attemptId });
		if (!lease.ok) return workFail("RUNTIME_BUSY", true, { detail: `another document round (${lease.holder.workId}) already owns this runtime` });
		const now = this.now();
		const operation: DocumentWorkOperation = {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			requestId: value.requestId,
			workId: value.workId,
			attemptId: value.attemptId,
			kind: value.kind,
			preparationId: preparation.preparationId,
			preparationDigest: preparation.digest,
			state: "dispatching",
			runtime: { agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
			requestDigest,
			createdAt: now,
			updatedAt: now,
		};
		const persisted = this.deps.store.withWork(value.workId, value.expectedRevision, (bucket) => {
			const nextRecord: DocumentWorkRecord = { ...bucket.record, activeOperationId: operation.attemptId, requests: { ...bucket.record.requests, [value.requestId]: { attemptId: operation.attemptId, requestDigest, state: "dispatching" } } };
			return workOk({ bucket: { ...bucket, record: nextRecord, operations: { ...bucket.operations, [operation.attemptId]: operation } }, value: operation });
		});
		if ("error" in persisted) return persisted;
		this.deps.store.recordRequest({ requestId: value.requestId, requestDigest, workId: value.workId, kind: "operation" });
		this.deps.emit({ workId: value.workId, sessionId: target.sessionId, revision: read.value.revision + 1, attemptId: operation.attemptId, changeKind: "dispatching" });
		this.track(
			operation.attemptId,
			this.dispatcher.run(operation, preparation, target).catch(() => undefined),
		);
		return workOk(operation);
	}

	private isTerminal(state: DocumentWorkOperation["state"]): boolean {
		return state === "archived" || state === "failed" || state === "interrupted" || state === "unknown";
	}

	/** 授权核对：只认权威来源（对齐原生投影 / 会话里真实用户轮次）。 */
	private async verifyAuthorization(input: { preparation: DocumentWorkPreparation; authorization: DocumentWorkPreparation["authorization"]; sessionId: string }): Promise<WorkResult<true>> {
		const expected = input.preparation.authorization;
		if (expected.kind !== input.authorization.kind) return workFail("APPROVAL_REQUIRED", false, { detail: "the authorization kind does not match the preparation" });
		if (expected.kind === "alignment_confirmation" && input.authorization.kind === "alignment_confirmation") {
			if (expected.briefId !== input.authorization.briefId || expected.revision !== input.authorization.revision) return workFail("APPROVAL_REQUIRED", false, { detail: "the authorization does not match the confirmed requirements" });
			const target = await this.deps.runtime.resolveRuntime(input.sessionId);
			if (!target) return workFail("RUNTIME_CHANGED", true, { detail: "the session runtime is gone" });
			const alignment = await this.deps.runtime.readAlignment(target);
			if (!alignment || alignment.briefId !== input.authorization.briefId || alignment.revision !== input.authorization.revision) return workFail("APPROVAL_REQUIRED", true, { detail: "the live confirmation sheet no longer matches this authorization" });
			return workOk(true);
		}
		if (expected.kind === "revision_instruction" && input.authorization.kind === "revision_instruction") {
			if (expected.sourceTurnId !== input.authorization.sourceTurnId) return workFail("APPROVAL_REQUIRED", false, { detail: "the authorization does not match the recorded instruction" });
			const instruction = input.preparation.instruction;
			if (!instruction || instruction.sourceTurnId !== expected.sourceTurnId) return workFail("PREPARATION_STALE", true, { detail: "the preparation has no frozen instruction" });
			// 冻结正文与指纹都必须仍然成立：用户编辑过正文即失效。
			if (instructionDigest(instruction.text) !== instruction.textDigest) return workFail("PREPARATION_STALE", true, { detail: "the frozen instruction is inconsistent" });
			const turn = await this.deps.runtime.readUserTurn({ sessionId: input.sessionId, turnId: expected.sourceTurnId });
			if (!turn || turn.role !== "user" || turn.textDigest !== instruction.textDigest) return workFail("PREPARATION_STALE", true, { detail: "the change request changed after it was frozen" });
			return workOk(true);
		}
		return workFail("APPROVAL_REQUIRED", false, { detail: "unsupported authorization" });
	}

	// ── 普通聊天的改稿意向（候选 → 主进程派发）─────────────────────────────

	/**
	 * 处理扩展报上来的改稿意向。
	 *
	 * 扩展只能"报"，主进程在这里重新验证并决定是否派发：
	 * 1. 会话/原生身份与本轮运行时一致，工作属于该会话且已有归档版本；
	 * 2. 该轮是最后一条真实用户消息、正文指纹一致、范围能从本轮指令定位；
	 * 3. **等该回合权威稳定**（意向发生在 busy 的回合里），期间换绑或新消息即作废；
	 * 4. 同一 workId + turnId 只派发一次。
	 */
	async handleRevisionIntent(input: { target: DocumentWorkRuntimeTarget; intent: DocumentWorkRevisionIntent }): Promise<WorkResult<DocumentWorkOperation | undefined>> {
		const { target, intent } = input;
		if (intent.sessionId !== target.sessionId || !target.piSessionId || intent.nativeSessionId !== target.piSessionId) return workFail("RUNTIME_CHANGED", true, { detail: "the intent does not belong to the current runtime" });
		const key = `${intent.workId}:${intent.sourceTurnId}`;
		if (this.handledIntents.has(key)) return workOk(undefined);
		const read = this.deps.store.readWork(intent.workId);
		if ("error" in read) return read;
		if (read.value.record.sessionId !== target.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		if (read.value.versions.length === 0) return workFail("APPROVAL_REQUIRED", false, { detail: "this work has no archived version to revise yet" });
		this.handledIntents.add(key);
		try {
			// 意向产生在工具执行中的忙碌回合里：先等这一回合到权威稳定点。
			const settled = await this.deps.adapter.waitFor((event) => event.kind === "settled" && !event.stale && event.target.agentId === target.agentId && event.target.runtimeGeneration === target.runtimeGeneration, this.deps.settleMs ?? DOCUMENT_WORK_BUDGETS.settleMs);
			if (!settled) return workFail("DISPATCH_UNKNOWN", true, { detail: "the round did not reach a settled state; the change request was not dispatched" });
			if (!(await runtimeStillMatches(this.deps.runtime, target))) return workFail("RUNTIME_CHANGED", true, { detail: "the runtime changed before the change request was dispatched" });
			return await this.mutex.run(`work:${intent.workId}`, async () => this.dispatchIntentLocked(target, intent));
		} finally {
			// 已处理的意向即使失败也不再自动重试；用户重发一次就会得到新的 turnId。
		}
	}

	private async dispatchIntentLocked(target: DocumentWorkRuntimeTarget, intent: DocumentWorkRevisionIntent): Promise<WorkResult<DocumentWorkOperation | undefined>> {
		const read = this.deps.store.readWork(intent.workId);
		if ("error" in read) return read;
		const record = read.value.record;
		if (record.activeOperationId) {
			const active = read.value.operations[record.activeOperationId];
			if (active && !this.isTerminal(active.state)) return workFail("RUNTIME_BUSY", true, { detail: "this work already has a run in flight" });
		}
		const turn = await this.deps.runtime.readUserTurn({ sessionId: target.sessionId, turnId: intent.sourceTurnId });
		if (!turn || turn.role !== "user" || !turn.isLatestUserTurn || turn.textDigest !== intent.instructionDigest) return workFail("APPROVAL_REQUIRED", false, { detail: "the change request is no longer the latest user message" });
		const prepared = await this.prepareLocked({
			requestId: `revise_${intent.sourceTurnId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
			workId: intent.workId,
			sessionId: target.sessionId,
			expectedRevision: read.value.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: intent.sourceTurnId },
			feedbackSourceTurnId: intent.sourceTurnId,
		});
		if ("error" in prepared) return prepared;
		return await this.startLocked({
			requestId: `startrev_${intent.sourceTurnId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
			workId: intent.workId,
			expectedRevision: prepared.value.workRevision,
			kind: "revise_document",
			preparation: prepared.value.preparation,
			expectedRuntime: target,
			authorization: { kind: "revision_instruction", sourceTurnId: intent.sourceTurnId },
			attemptId: this.newId("attempt"),
		});
	}

	// ── 取消与查询 ───────────────────────────────────────────────────────────

	async cancel(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "cancel input must be an object" });
		const value = input as Record<string, unknown>;
		if (typeof value.workId !== "string" || typeof value.attemptId !== "string" || typeof value.requestId !== "string") return workFail("INVALID_INPUT", false, { detail: "workId, attemptId and requestId are required" });
		return await this.mutex.run(`work:${value.workId}`, async () => this.cancelLocked(value));
	}

	private async cancelLocked(value: Record<string, unknown>): Promise<WorkResult<DocumentWorkOperation>> {
		const workId = value.workId as string;
		const attemptId = value.attemptId as string;
		const expected = value.expectedRuntime;
		if (typeof expected !== "object" || expected === null) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime is required" });
		const triple = expected as Record<string, unknown>;
		if (typeof triple.sessionId !== "string" || typeof triple.agentId !== "string" || !Number.isSafeInteger(triple.runtimeGeneration)) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime must carry the full runtime triple" });
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return read;
		// 会话归属：expectedRuntime 必须指向这条工作记录所属的会话，跨会话一律拒绝。
		if (read.value.record.sessionId !== triple.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the runtime's session" });
		const operation = read.value.operations[attemptId];
		if (!operation) return workFail("WORK_NOT_FOUND", false, { detail: "the attempt does not belong to this work" });
		// 尝试归属：expectedRuntime 的三代组必须与这条 attempt 记录的一致。
		// 这一步必须在下面的 `unknown` 清理**之前**，否则错误 agent/generation（乃至别的会话）
		// 就能解除别人的未知占用——未知占用是"无法证明没执行过"的保守状态，不能被任意身份清掉。
		if (operation.runtime.agentId !== triple.agentId || operation.runtime.runtimeGeneration !== triple.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the cancellation targets a different runtime than this attempt was dispatched to" });
		if (this.isTerminal(operation.state) && operation.state !== "unknown") return workOk(operation);
		// `unknown` 是唯一"终态但可显式清理"的状态：它是保守占用（阻止同运行时的新 attempt）。
		// 用户显式清理只表示"解除这条保守占用、让运行时可以被重新使用"，
		// **不**表示旧派发没有执行过——那一轮的副作用仍然未知，不会有任何重放或补记。
		if (operation.state === "unknown") {
			const cleared = finishOperation(this.deps.store, workId, attemptId, { state: "interrupted", code: "DISPATCH_UNKNOWN", detail: "the user cleared an unknown outcome for this attempt" }, this.now);
			if (cleared) this.deps.emit(cleared);
			this.lease.releaseWork(workId);
			const afterClear = this.deps.store.readWork(workId);
			return "error" in afterClear ? afterClear : workOk(afterClear.value.operations[attemptId]);
		}
		const current = await this.deps.runtime.resolveRuntime(read.value.record.sessionId);
		// 只取消匹配的运行时：换绑后旧 attempt 的运行由新运行时自行收口，不越界中止别人的回合。
		if (!current || current.agentId !== operation.runtime.agentId || current.runtimeGeneration !== operation.runtime.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the runtime for this attempt is gone; the run cannot be cancelled scoped" });
		if (current.agentId !== triple.agentId || current.runtimeGeneration !== triple.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the cancellation targets a stale runtime" });
		await this.deps.runtime.abort({ sessionId: read.value.record.sessionId, agentId: current.agentId, runtimeGeneration: current.runtimeGeneration, ...(current.piSessionId ? { piSessionId: current.piSessionId } : {}) });
		const event = finishOperation(this.deps.store, workId, attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "cancelled by the user for this attempt only" }, this.now);
		if (event) this.deps.emit(event);
		this.lease.releaseWork(workId);
		const after = this.deps.store.readWork(workId);
		return "error" in after ? after : workOk(after.value.operations[attemptId]);
	}

	async getOperation(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "operation input must be an object" });
		const value = input as Record<string, unknown>;
		if (typeof value.requestId !== "string" || typeof value.sessionId !== "string" || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "requestId and sessionId are required" });
		const entry = this.deps.store.lookupRequestAny(value.requestId);
		if (!entry) return workFail("WORK_NOT_FOUND", false, { detail: "no operation was recorded for this request" });
		const read = this.deps.store.readWork(entry.workId);
		if ("error" in read) return read;
		if (read.value.record.sessionId !== value.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this operation does not belong to the session" });
		const attemptId = read.value.record.requests[value.requestId]?.attemptId;
		const operation = attemptId ? read.value.operations[attemptId] : undefined;
		if (!operation) return workFail("WORK_NOT_FOUND", false, { detail: "this request has no operation" });
		return workOk(operation);
	}

	/** 会话重开后的恢复查询：不重放、不新建，只回报已知状态。 */
	async recover(sessionId: unknown): Promise<WorkResult<{ works: DocumentWorkRecord[]; operations: DocumentWorkOperation[]; corruptWorkIds: string[] }>> {
		if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
		const works = this.deps.store.listWorksForSession(sessionId);
		const operations: DocumentWorkOperation[] = [];
		// 损坏的工作不出现在"可继续操作"的列表里，但必须如实报出来（界面只读展示）。
		const corruptWorkIds = this.deps.store.corruptWorkIds();
		for (const work of works) {
			const read = this.deps.store.readWork(work.workId);
			if ("error" in read) continue;
			operations.push(...Object.values(read.value.operations));
		}
		return workOk({ works, operations, corruptWorkIds });
	}

	/** 未结算操作 id（应用重启后核对用）：只回报，不自动重放。 */
	unsettledOperationIds(): string[] {
		const ids: string[] = [];
		for (const workId of this.deps.store.listWorkIds()) {
			const read = this.deps.store.readWork(workId);
			if ("error" in read) continue;
			for (const operation of Object.values(read.value.operations)) {
				if (!this.isTerminal(operation.state)) ids.push(operation.attemptId);
			}
		}
		return ids;
	}

	/** 归档结果（供界面/报告读取）：只读。 */
	async versions(workId: unknown): Promise<WorkResult<DocumentWorkSnapshot>> {
		if (typeof workId !== "string" || !workId) return workFail("INVALID_INPUT", false, { detail: "workId is required" });
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return read;
		return this.snapshot(workId, read.value.record.sessionId);
	}

	/** 诊断：等待中的编排数量。 */
	pendingOperations(): number {
		return this.inFlight.size + this.mutex.pendingKeys().length;
	}

	/** 归档失败时给界面的一行说明（引用持久化的 lastFailure，不重新推断）。 */
	static describeOutcome(outcome: ArchiveOutcome): string {
		return outcome.state === "archived" ? "archived" : `${outcome.state}:${"code" in outcome ? outcome.code : "UNKNOWN"}`;
	}
}
