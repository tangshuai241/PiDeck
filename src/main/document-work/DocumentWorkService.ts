/**
 * TPA 独立文稿：工作编排。
 *
 * 状态机：`prepared → dispatching → running → inspecting → archived`，另有
 * `failed / interrupted / unknown`。三条不变量贯穿全文件：
 *
 * 1. **先持久化再分发**：请求与准备身份落盘成功之后才允许发 RPC；`accepted` 只表示
 *    "RPC 收到了"，不等于授权成功，更不等于执行完成。
 * 2. **每次异步步骤后复查运行时**：`SessionRuntimeTarget` 在等待窗口内被替换就必须中止
 *    并记 `RUNTIME_CHANGED`；旧 attempt / 旧会话 / 旧世代的迟到消息一律忽略。
 * 3. **授权来自权威来源**：对齐确认单从原生投影读，改稿指令从会话里那一轮真实用户消息读；
 *    Renderer 传的布尔值、模型自报和关键词都不构成授权。
 *
 * 归档细节（复制、快照、检查、落版本记录）在 `DocumentArchiveService`。
 */
import { createHash } from "node:crypto";
import { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_COMMAND, DOCUMENT_WORK_SCHEMA_VERSION, canonicalJson, encodeWorkBinding, isBoundedText, isNonNegativeInteger, isSafeRelativePath, isWorkId, normalizeChangeScope, utf8ByteLength, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type {
	AuthorizationReference,
	DocumentChangeScope,
	DocumentMaterialReference,
	DocumentWorkChangedEvent,
	DocumentWorkCreateInput,
	DocumentWorkKind,
	DocumentWorkOperation,
	DocumentWorkOutputRoot,
	DocumentWorkPreparation,
	DocumentWorkRecord,
	DocumentWorkSnapshot,
	PreparedWork,
	RequirementsReference,
} from "../../shared/types/documentWork";
import type { DocumentWorkAlignmentSnapshot, DocumentWorkRuntimePort, DocumentWorkRuntimeTarget } from "./DocumentWorkRuntimeAdapter";
import { runtimeStillMatches, type DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { selectBaseVersion } from "./DocumentRevisionPolicy";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";
import type { ArchiveOutcome, DocumentArchiveService } from "./DocumentArchiveService";

export type DocumentWorkServiceDeps = {
	store: DocumentWorkStore;
	runtime: DocumentWorkRuntimePort;
	adapter: DocumentWorkRuntimeAdapter;
	archive: DocumentArchiveService;
	pathFs: DocumentPathFsPort;
	/** TPA 管理根（`userData/document-work`）：快照与转换缓存都在它下面。 */
	workRoot: string;
	emit: (event: DocumentWorkChangedEvent) => void;
	now?: () => number;
	newId?: (prefix: string) => string;
	/** 绑定确认等待时限覆盖点（默认取共享预算）；测试用它避免真的等 20 秒。 */
	bindAckMs?: number;
};

function digestOf(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class DocumentWorkService {
	private readonly deps: DocumentWorkServiceDeps;
	private readonly now: () => number;
	private readonly newId: (prefix: string) => string;
	private readonly inFlight = new Map<string, Promise<void>>();

	constructor(deps: DocumentWorkServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.newId = deps.newId ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`);
	}

	/** 停止服务时等未完成的编排自行收口；磁盘记录与未结算操作保持不变。 */
	async shutdown(): Promise<void> {
		const pending = [...this.inFlight.values()];
		this.inFlight.clear();
		await Promise.allSettled(pending);
	}

	// ── 创建 ─────────────────────────────────────────────────────────────────

	async create(input: unknown): Promise<WorkResult<DocumentWorkRecord>> {
		const parsed = this.parseCreate(input);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		const requestDigest = digestOf({ kind: "create", sessionId: value.sessionId, sourceTurnId: value.sourceTurnId, title: value.title, outputRootId: value.outputRootId });
		const result = this.deps.store.createWork({ ...value, requestDigest });
		if ("error" in result) return result;
		const record = result.value;
		this.deps.emit({ workId: record.workId, sessionId: record.sessionId, revision: record.revision, changeKind: "created" });
		return workOk(record);
	}

	private parseCreate(input: unknown): WorkResult<DocumentWorkCreateInput> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "create input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.requestId) || !isWorkId(value.sourceTurnId)) return workFail("INVALID_INPUT", false, { detail: "requestId and sourceTurnId must be bounded ids" });
		// 空 outputRootId 表示首次提交时用户还没选成果目录，绑定由 set-root 补上。
		if (value.outputRootId !== undefined && value.outputRootId !== "" && !isWorkId(value.outputRootId)) return workFail("INVALID_INPUT", false, { detail: "outputRootId must be a registered root id" });
		if (!isBoundedText(value.sessionId, 200) || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
		if (value.title !== undefined && !isBoundedText(value.title, 200)) return workFail("INVALID_INPUT", false, { detail: "title is too long" });
		return workOk({
			requestId: value.requestId,
			sessionId: value.sessionId,
			sourceTurnId: value.sourceTurnId,
			title: typeof value.title === "string" ? value.title : "document",
			outputRootId: typeof value.outputRootId === "string" ? value.outputRootId : "",
		});
	}

	// ── 读取 ─────────────────────────────────────────────────────────────────

	async get(input: unknown): Promise<WorkResult<DocumentWorkSnapshot>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "get input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.workId) || !isBoundedText(value.sessionId, 200) || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "workId and sessionId are required" });
		return this.snapshot(value.workId, value.sessionId);
	}

	private snapshot(workId: string, sessionId: string): WorkResult<DocumentWorkSnapshot> {
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return read;
		if (read.value.record.sessionId !== sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const record = read.value.record;
		// 有活动操作就先给活动操作；否则给最近一次操作——终态（failed/unknown/archived）
		// 同样要能被界面看到，否则失败原因会在结算后消失。
		const operations = Object.values(read.value.operations);
		const operation = (record.activeOperationId ? read.value.operations[record.activeOperationId] : undefined) ?? operations.sort((left, right) => right.updatedAt - left.updatedAt)[0];
		// 未绑定成果目录时不查根，也不报错：界面据此邀请用户选一个目录。
		const root = record.outputRootId ? this.deps.store.getOutputRoot(record.outputRootId) : undefined;
		return workOk({
			work: record,
			...(operation ? { operation } : {}),
			versions: [...read.value.versions],
			...(root && root.ok ? { outputRootPath: root.value.path } : {}),
		});
	}

	async listForSession(sessionId: unknown): Promise<WorkResult<DocumentWorkRecord[]>> {
		if (!isBoundedText(sessionId, 200) || !sessionId) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
		return workOk(this.deps.store.listWorksForSession(sessionId));
	}

	// ── 准备 ─────────────────────────────────────────────────────────────────

	async prepare(input: unknown): Promise<WorkResult<PreparedWork>> {
		const parsed = this.parsePrepare(input);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		const read = this.deps.store.readWork(value.workId);
		if ("error" in read) return read;
		if (read.value.record.sessionId !== value.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const root = read.value.record.outputRootId ? this.deps.store.getOutputRoot(read.value.record.outputRootId) : workFail<DocumentWorkOutputRoot>("PATH_DENIED", false, { detail: "no output folder is bound to this work yet" });
		if ("error" in root) return root;
		const target = await this.deps.runtime.resolveRuntime(value.sessionId);
		if (!target) return workFail("RUNTIME_CHANGED", true, { detail: "the session has no live runtime to bind" });

		const alignment = await this.deps.runtime.readAlignment(target);
		const resolved = this.resolveScopeAndAuthorization({ work: read.value.record, kind: value.kind, requirementsRef: value.requirementsRef, alignment, feedbackSourceTurnId: value.feedbackSourceTurnId });
		if ("error" in resolved) return resolved;
		const materials = this.collectMaterials(root.value.path, alignment);

		let base: DocumentWorkPreparation["base"];
		if (value.kind === "revise_document") {
			const selection = selectBaseVersion({
				versions: read.value.versions,
				explicitVersionId: value.baseVersionId,
				readCurrentDigest: (relativePath: string) => {
					const resolvedPath = resolveWithinRoot(this.deps.pathFs, root.value.path, relativePath);
					if (!resolvedPath.ok) return undefined;
					const data = this.deps.pathFs.readFile(resolvedPath.absolutePath);
					return data ? createHash("sha256").update(data).digest("hex") : undefined;
				},
			});
			if ("error" in selection) return selection;
			base = selection.value.base;
		}

		const preparationId = this.newId("prep");
		const stagingRelativeDir = `${value.workId}/staging/${preparationId}`;
		const draft: Omit<DocumentWorkPreparation, "digest"> = {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			preparationId,
			kind: value.kind,
			workRevision: read.value.revision + 1,
			requirementsRef: resolved.value.requirementsRef,
			authorization: resolved.value.authorization,
			materials,
			...(base ? { base } : {}),
			scope: resolved.value.scope,
			stagingRelativeDir,
			outputRelativeDir: value.workId,
			createdAt: this.now(),
		};
		const preparation: DocumentWorkPreparation = { ...draft, digest: digestOf(draft) };

		// 冻结副本：把基稿字节复制进本轮 staging，并校验复制前后指纹。
		const frozen = await this.deps.archive.freezePreparation({ preparation, outputRootPath: root.value.path });
		if ("error" in frozen) return frozen;

		const prepared = this.deps.store.withWork(value.workId, value.expectedRevision, (bucket) => {
			const next: DocumentWorkRecord = { ...bucket.record, requirementsRef: resolved.value.requirementsRef };
			return workOk({ bucket: { ...bucket, record: next, preparations: { ...bucket.preparations, [preparation.preparationId]: preparation } }, value: preparation });
		});
		if ("error" in prepared) return prepared;
		this.deps.emit({ workId: value.workId, sessionId: value.sessionId, revision: prepared.value.workRevision, changeKind: "prepared" });
		return workOk({ workId: value.workId, workRevision: prepared.value.workRevision, preparation: { preparationId: preparation.preparationId, digest: preparation.digest }, summary: this.summarize(preparation) });
	}

	private summarize(preparation: DocumentWorkPreparation): string {
		const scope = preparation.scope.wholeDocument ? "the whole document" : `${preparation.scope.allow.length} authorized section(s)`;
		const base = preparation.base ? ` from ${preparation.base.relativePath}` : "";
		return `${preparation.kind === "create_document" ? "create" : "revise"} a document in ${scope}${base}`;
	}

	private parsePrepare(input: unknown): WorkResult<{ workId: string; sessionId: string; requestId: string; expectedRevision: number; kind: DocumentWorkKind; requirementsRef: RequirementsReference; feedbackSourceTurnId?: string; baseVersionId?: string }> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "prepare input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.requestId) || !isWorkId(value.workId) || !isBoundedText(value.sessionId, 200) || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "requestId, workId and sessionId are required" });
		if (!isNonNegativeInteger(value.expectedRevision)) return workFail("INVALID_INPUT", false, { detail: "expectedRevision must be a non-negative integer" });
		if (value.kind !== "create_document" && value.kind !== "revise_document") return workFail("INVALID_INPUT", false, { detail: "kind must be create_document or revise_document" });
		const requirementsRef = this.parseRequirements(value.requirementsRef);
		if (!requirementsRef) return workFail("INVALID_INPUT", false, { detail: "requirementsRef must be an alignment reference or a user instruction turn" });
		if (value.feedbackSourceTurnId !== undefined && !isWorkId(value.feedbackSourceTurnId)) return workFail("INVALID_INPUT", false, { detail: "feedbackSourceTurnId must be a bounded id" });
		if (value.kind === "revise_document" && value.feedbackSourceTurnId === undefined) return workFail("INVALID_INPUT", false, { detail: "a revision needs the turn that carries the change request" });
		if (value.baseVersionId !== undefined && !isWorkId(value.baseVersionId)) return workFail("INVALID_INPUT", false, { detail: "baseVersionId must be a bounded id" });
		return workOk({
			workId: value.workId,
			sessionId: value.sessionId,
			requestId: value.requestId,
			expectedRevision: value.expectedRevision,
			kind: value.kind,
			requirementsRef,
			...(typeof value.feedbackSourceTurnId === "string" ? { feedbackSourceTurnId: value.feedbackSourceTurnId } : {}),
			...(typeof value.baseVersionId === "string" ? { baseVersionId: value.baseVersionId } : {}),
		});
	}

	private parseRequirements(value: unknown): RequirementsReference | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const ref = value as Record<string, unknown>;
		if (ref.kind === "alignment" && isWorkId(ref.briefId) && isNonNegativeInteger(ref.revision)) return { kind: "alignment", briefId: ref.briefId, revision: ref.revision };
		if (ref.kind === "user_instruction" && isWorkId(ref.sourceTurnId)) return { kind: "user_instruction", sourceTurnId: ref.sourceTurnId };
		return undefined;
	}

	/**
	 * 解析本轮范围与授权。
	 *
	 * - 对齐确认单：`briefId` 必须与工作记录绑定的一致，确认单不得来自更晚的已变化版本；
	 * - 改稿指令：授权是"那一轮真实用户消息"，因此必须能从会话里读回原文；
	 * - 没有已确认范围的改稿返回 `APPROVAL_REQUIRED`——不靠"第几节"这类关键词猜范围。
	 */
	private resolveScopeAndAuthorization(input: {
		work: DocumentWorkRecord;
		kind: DocumentWorkKind;
		requirementsRef: RequirementsReference;
		alignment: DocumentWorkAlignmentSnapshot | undefined;
		feedbackSourceTurnId?: string;
	}): WorkResult<{ scope: DocumentChangeScope; requirementsRef: RequirementsReference; authorization: AuthorizationReference }> {
		const boundBriefId = input.work.requirementsRef?.kind === "alignment" ? input.work.requirementsRef.briefId : undefined;
		const liveBrief = input.alignment && (boundBriefId === undefined || input.alignment.briefId === boundBriefId) ? input.alignment.brief : undefined;
		if (input.requirementsRef.kind === "alignment") {
			if (!input.alignment || input.alignment.briefId !== input.requirementsRef.briefId) return workFail("APPROVAL_REQUIRED", true, { detail: "the confirmation sheet for this work is no longer the live one" });
			if (input.kind === "create_document" && input.alignment.revision !== input.requirementsRef.revision) return workFail("PREPARATION_STALE", true, { detail: "the requirements changed after this confirmation" });
			if (input.kind === "revise_document" && input.requirementsRef.revision > input.alignment.revision) return workFail("PREPARATION_STALE", true, { detail: "the confirmation sheet advanced past the requested revision" });
		}
		if (input.kind === "create_document") {
			// 初稿没有可比对象：范围只用于说明本轮做了什么，不参与正文授权判定。
			return workOk({
				scope: { allow: [], preserve: [], wholeDocument: true },
				requirementsRef: input.requirementsRef,
				authorization: input.requirementsRef.kind === "alignment" ? { kind: "alignment_confirmation", briefId: input.requirementsRef.briefId, revision: input.requirementsRef.revision } : { kind: "revision_instruction", sourceTurnId: input.requirementsRef.sourceTurnId },
			});
		}
		if (!input.feedbackSourceTurnId) return workFail("INVALID_INPUT", false, { detail: "a revision needs the turn that carries the change request" });
		if (!liveBrief) return workFail("APPROVAL_REQUIRED", false, { detail: "no confirmed scope is bound to this work; confirm the requirements before revising" });
		const scope = normalizeChangeScope({ allow: liveBrief.scope, preserve: liveBrief.preserve, wholeDocument: false });
		if (!scope) return workFail("APPROVAL_REQUIRED", false, { detail: "the confirmed scope is empty or contradictory; clarify what may change before revising" });
		return workOk({ scope, requirementsRef: input.requirementsRef, authorization: { kind: "revision_instruction", sourceTurnId: input.feedbackSourceTurnId } });
	}

	/** 材料登记：只接受成果根内真实存在的文件，其他条目按描述忽略。 */
	private collectMaterials(outputRootPath: string, alignment: DocumentWorkAlignmentSnapshot | undefined): DocumentMaterialReference[] {
		const materials: DocumentMaterialReference[] = [];
		for (const entry of alignment?.brief?.materials ?? []) {
			const candidate = entry.trim();
			if (!candidate || candidate.length > 500) continue;
			const relative = candidate.replace(/\\/g, "/");
			if (!isSafeRelativePath(relative)) continue;
			const resolved = resolveWithinRoot(this.deps.pathFs, outputRootPath, relative);
			if (!resolved.ok) continue;
			const stat = this.deps.pathFs.stat(resolved.absolutePath);
			if (!stat || !stat.isFile() || stat.size === 0 || stat.size > DOCUMENT_WORK_BUDGETS.materialBytes) continue;
			const data = this.deps.pathFs.readFile(resolved.absolutePath);
			if (!data) continue;
			materials.push({ materialId: this.newId("mat"), relativePath: relative, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength, converter: "anydoc" });
			if (materials.length >= 32) break;
		}
		return materials;
	}

	// ── 分发 ─────────────────────────────────────────────────────────────────

	async start(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		const parsed = this.parseStart(input);
		if ("error" in parsed) return parsed;
		const value = parsed.value;
		const read = this.deps.store.readWork(value.workId);
		if ("error" in read) return read;
		const record = read.value.record;
		if (record.sessionId !== value.expectedRuntime.sessionId) return workFail("WORK_NOT_FOUND", false, { detail: "this work does not belong to the session" });
		const requestDigest = digestOf({ kind: "start", workId: value.workId, preparationId: value.preparation.preparationId, operationKind: value.kind, authorization: value.authorization });
		const previous = this.deps.store.lookupRequest(value.requestId, requestDigest);
		if (previous && "conflict" in previous) return workFail("IDEMPOTENCY_CONFLICT", false, { detail: "requestId was used with a different payload" });
		if (previous) {
			const attemptId = read.value.record.requests[value.requestId]?.attemptId;
			const existing = attemptId ? read.value.operations[attemptId] : undefined;
			if (existing) return workOk(existing);
		}
		if (record.activeOperationId) {
			const active = read.value.operations[record.activeOperationId];
			if (active && !this.isTerminal(active.state)) return workFail("RUNTIME_BUSY", true, { detail: "this work already has a run in flight" });
		}
		const preparation = read.value.preparations[value.preparation.preparationId];
		if (!preparation) return workFail("PREPARATION_STALE", true, { detail: "the preparation does not belong to this work" });
		if (preparation.digest !== value.preparation.digest) return workFail("PREPARATION_STALE", true, { detail: "the preparation content changed" });
		if (preparation.kind !== value.kind) return workFail("PREPARATION_STALE", true, { detail: "the preparation was made for a different operation kind" });

		const target = await this.deps.runtime.resolveRuntime(value.expectedRuntime.sessionId);
		if (!target || target.agentId !== value.expectedRuntime.agentId || target.runtimeGeneration !== value.expectedRuntime.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the session runtime changed before dispatch" });
		const authorization = await this.verifyAuthorization({ preparation, authorization: value.authorization, sessionId: value.expectedRuntime.sessionId });
		if ("error" in authorization) return authorization;
		const flags = await this.deps.runtime.runtimeFlags(target);
		if (flags.busy || flags.queued) return workFail("RUNTIME_BUSY", true, { detail: "the session runtime is busy or has queued input" });

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
		const task = this.dispatchAndSettle(operation, preparation, target).catch(() => undefined);
		this.inFlight.set(operation.attemptId, task);
		void task.finally(() => this.inFlight.delete(operation.attemptId));
		return workOk(operation);
	}

	private parseStart(input: unknown): WorkResult<{ workId: string; requestId: string; expectedRevision: number; kind: DocumentWorkKind; preparation: { preparationId: string; digest: string }; expectedRuntime: DocumentWorkRuntimeTarget; authorization: AuthorizationReference; attemptId: string }> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "start input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.workId) || !isWorkId(value.requestId) || !isNonNegativeInteger(value.expectedRevision)) return workFail("INVALID_INPUT", false, { detail: "workId, requestId and expectedRevision are required" });
		if (value.kind !== "create_document" && value.kind !== "revise_document") return workFail("INVALID_INPUT", false, { detail: "kind must be create_document or revise_document" });
		const preparation = value.preparation;
		if (typeof preparation !== "object" || preparation === null) return workFail("INVALID_INPUT", false, { detail: "preparation reference is required" });
		const reference = preparation as Record<string, unknown>;
		if (!isWorkId(reference.preparationId) || !isBoundedText(reference.digest, 200) || !reference.digest) return workFail("INVALID_INPUT", false, { detail: "the preparation reference is malformed" });
		const runtime = value.expectedRuntime;
		if (typeof runtime !== "object" || runtime === null) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime is required" });
		const triple = runtime as Record<string, unknown>;
		if (!isBoundedText(triple.sessionId, 200) || !isBoundedText(triple.agentId, 200) || !isNonNegativeInteger(triple.runtimeGeneration)) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime must carry the full runtime triple" });
		const authorization = this.parseAuthorization(value.authorization);
		if (!authorization) return workFail("INVALID_INPUT", false, { detail: "authorization must be an alignment confirmation or a revision instruction" });
		return workOk({
			workId: value.workId,
			requestId: value.requestId,
			expectedRevision: value.expectedRevision,
			kind: value.kind,
			preparation: { preparationId: reference.preparationId, digest: reference.digest },
			expectedRuntime: { sessionId: triple.sessionId, agentId: triple.agentId, runtimeGeneration: triple.runtimeGeneration },
			authorization,
			attemptId: this.newId("attempt"),
		});
	}

	private parseAuthorization(value: unknown): AuthorizationReference | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const ref = value as Record<string, unknown>;
		if (ref.kind === "alignment_confirmation" && isWorkId(ref.briefId) && isNonNegativeInteger(ref.revision)) return { kind: "alignment_confirmation", briefId: ref.briefId, revision: ref.revision };
		if (ref.kind === "revision_instruction" && isWorkId(ref.sourceTurnId)) return { kind: "revision_instruction", sourceTurnId: ref.sourceTurnId };
		return undefined;
	}

	private isTerminal(state: DocumentWorkOperation["state"]): boolean {
		return state === "archived" || state === "failed" || state === "interrupted" || state === "unknown";
	}

	/** 授权核对：只认权威来源。 */
	private async verifyAuthorization(input: { preparation: DocumentWorkPreparation; authorization: AuthorizationReference; sessionId: string }): Promise<WorkResult<true>> {
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
			const instruction = await this.deps.runtime.readUserTurnText(input.sessionId, input.authorization.sourceTurnId);
			if (instruction === undefined) return workFail("APPROVAL_REQUIRED", false, { detail: "the change request could not be read back from this session" });
			return workOk(true);
		}
		return workFail("APPROVAL_REQUIRED", false, { detail: "unsupported authorization" });
	}

	private async dispatchAndSettle(operation: DocumentWorkOperation, preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Promise<void> {
		const bound = await this.bind(operation, preparation, target);
		if (!bound) return;
		let outcome: ArchiveOutcome;
		try {
			outcome = await this.deps.archive.settleAndArchive({ operation, preparation, target, runtime: this.deps.runtime, adapter: this.deps.adapter });
		} catch {
			outcome = { state: "failed", code: "IO_ERROR", detail: "the archive step failed unexpectedly" };
		}
		this.finish(operation.workId, operation.attemptId, outcome);
	}

	/**
	 * 绑定 + 分发。
	 *
	 * 绑定失败分两种：命令被拒（确定未送达 → `failed`）与命令被接受但没等到确认
	 * （无法证明是否执行 → `unknown`，不自动重放）。
	 */
	private async bind(operation: DocumentWorkOperation, preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Promise<boolean> {
		const workRead = this.deps.store.readWork(operation.workId);
		if ("error" in workRead) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "WORK_NOT_FOUND", detail: "the work record disappeared" });
			return false;
		}
		const root = this.deps.store.getOutputRoot(workRead.value.record.outputRootId);
		const bindPayload = {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			sessionId: target.sessionId,
			workId: operation.workId,
			attemptId: operation.attemptId,
			preparationId: preparation.preparationId,
			digest: preparation.digest,
			kind: preparation.kind,
			stagingRelativeDir: preparation.stagingRelativeDir,
			outputRelativeDir: preparation.outputRelativeDir,
			outputRootPath: root.ok ? root.value.path : "",
			materials: preparation.materials.map((material) => ({ materialId: material.materialId, relativePath: material.relativePath, sha256: material.sha256, converter: material.converter })),
			...(preparation.base ? { base: { relativePath: preparation.base.relativePath, sha256: preparation.base.sha256 } } : {}),
			scope: preparation.scope,
			budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
			...(preparation.authorization.kind === "alignment_confirmation" ? { briefId: preparation.authorization.briefId, briefRevision: preparation.authorization.revision } : {}),
		};
		const encoded = encodeWorkBinding(bindPayload);
		if (utf8ByteLength(encoded) > DOCUMENT_WORK_BUDGETS.bindPayloadBytes * 2) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "INVALID_INPUT", detail: "the binding payload exceeds the byte budget" });
			return false;
		}
		if (!(await runtimeStillMatches(this.deps.runtime, target))) {
			this.finish(operation.workId, operation.attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "the runtime changed before the binding was sent" });
			return false;
		}
		const sent = await this.deps.runtime.sendControl({ sessionId: target.sessionId, requestId: `${operation.requestId}_bind`, message: `/${DOCUMENT_WORK_COMMAND} bind ${encoded}`, expectedRuntime: target });
		if (!sent.accepted) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "RUNTIME_BUSY", detail: sent.error ?? "the binding command was rejected" });
			return false;
		}
		const confirmation = await this.deps.adapter.awaitBinding({ target, attemptId: operation.attemptId, preparationId: preparation.preparationId, digest: preparation.digest, timeoutMs: this.deps.bindAckMs ?? DOCUMENT_WORK_BUDGETS.bindAckMs });
		// 等待确认期间被换绑：这可以证明（而不是猜）本轮没有落在当前运行时上，因此记中断而不是未知。
		if (!(await runtimeStillMatches(this.deps.runtime, target))) {
			this.finish(operation.workId, operation.attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "the runtime changed while waiting for the binding confirmation" });
			return false;
		}
		if (!confirmation.ok) {
			this.finish(operation.workId, operation.attemptId, { state: "unknown", code: "DISPATCH_UNKNOWN", detail: confirmation.reason });
			return false;
		}
		if (!(await runtimeStillMatches(this.deps.runtime, target))) {
			this.finish(operation.workId, operation.attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "the runtime changed after binding" });
			return false;
		}
		this.update(operation.workId, operation.attemptId, { state: "running" });
		this.deps.emit({ workId: operation.workId, sessionId: target.sessionId, revision: 0, attemptId: operation.attemptId, changeKind: "running" });
		const runMessage = await this.runMessage(preparation, target);
		if (!runMessage) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "APPROVAL_REQUIRED", detail: "the round could not be dispatched from the recorded authorization" });
			return false;
		}
		const run = await this.deps.runtime.sendControl({ sessionId: target.sessionId, requestId: `${operation.requestId}_run`, message: runMessage, expectedRuntime: target });
		if (!run.accepted) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "RUNTIME_BUSY", detail: run.error ?? "the execution prompt was rejected" });
			return false;
		}
		return true;
	}

	/**
	 * 本轮执行消息：初稿走既有的对齐批准入口（旧 `/align approve` 语义不变，
	 * 只是现在被文稿扩展的绑定闸管住）；改稿复用那一轮用户指令原文。
	 */
	private async runMessage(preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Promise<string | undefined> {
		if (preparation.authorization.kind === "alignment_confirmation") return `/align approve ${preparation.authorization.briefId} ${preparation.authorization.revision}`;
		return await this.deps.runtime.readUserTurnText(target.sessionId, preparation.authorization.sourceTurnId);
	}

	private update(workId: string, attemptId: string, patch: Partial<DocumentWorkOperation>): void {
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return;
		this.deps.store.withWork(workId, read.value.revision, (bucket) => {
			const operation = bucket.operations[attemptId];
			if (!operation) return workFail<DocumentWorkRecord>("WORK_NOT_FOUND", false, { detail: "operation missing" });
			return workOk({ bucket: { ...bucket, operations: { ...bucket.operations, [attemptId]: { ...operation, ...patch, updatedAt: this.now() } } }, value: bucket.record });
		});
	}

	/** 结算：只改操作与记录，不再调用模型；失败保留 staging 与输入。 */
	private finish(workId: string, attemptId: string, outcome: ArchiveOutcome): void {
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return;
		const applied = this.deps.store.withWork(workId, read.value.revision, (bucket) => {
			const operation = bucket.operations[attemptId];
			if (!operation) return workFail<DocumentWorkRecord>("WORK_NOT_FOUND", false, { detail: "operation missing" });
			const nextOperation: DocumentWorkOperation = {
				...operation,
				state: outcome.state,
				updatedAt: this.now(),
				...("code" in outcome && outcome.code ? { error: { code: outcome.code, retryable: outcome.state === "failed" || outcome.state === "interrupted", ...("detail" in outcome && outcome.detail ? { detail: outcome.detail } : {}) } } : {}),
				...("versionId" in outcome && outcome.versionId ? { versionId: outcome.versionId } : {}),
			};
			const requests = { ...bucket.record.requests, [operation.requestId]: { attemptId, requestDigest: operation.requestDigest, state: outcome.state } };
			const versions = "versionId" in outcome && outcome.versionId && !bucket.record.versions.includes(outcome.versionId) ? [...bucket.record.versions, outcome.versionId] : bucket.record.versions;
			const nextRecord: DocumentWorkRecord = { ...bucket.record, requests, versions };
			if (bucket.record.activeOperationId === attemptId) delete nextRecord.activeOperationId;
			if (outcome.state === "failed" || outcome.state === "interrupted" || outcome.state === "unknown") nextRecord.lastFailure = { attemptId, code: "code" in outcome && outcome.code ? outcome.code : "IO_ERROR", at: this.now() };
			return workOk({ bucket: { ...bucket, record: nextRecord, operations: { ...bucket.operations, [attemptId]: nextOperation } }, value: bucket.record });
		});
		if ("error" in applied) return;
		const changeKind: DocumentWorkChangedEvent["changeKind"] = outcome.state === "archived" ? "archived" : outcome.state === "failed" ? "failed" : outcome.state === "interrupted" ? "interrupted" : outcome.state === "unknown" ? "unknown" : "inspecting";
		this.deps.emit({ workId, sessionId: read.value.record.sessionId, revision: read.value.revision + 1, attemptId, changeKind });
	}

	// ── 取消与查询 ───────────────────────────────────────────────────────────

	async cancel(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "cancel input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.requestId) || !isNonNegativeInteger(value.expectedRevision)) return workFail("INVALID_INPUT", false, { detail: "workId, attemptId, requestId and expectedRevision are required" });
		const expected = value.expectedRuntime;
		if (typeof expected !== "object" || expected === null) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime is required" });
		const target = expected as Record<string, unknown>;
		const sessionId = target.sessionId;
		const agentId = target.agentId;
		if (!isBoundedText(sessionId, 200) || !sessionId || !isBoundedText(agentId, 200) || !agentId || !isNonNegativeInteger(target.runtimeGeneration)) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime must carry the full runtime triple" });
		const read = this.deps.store.readWork(value.workId);
		if ("error" in read) return read;
		const operation = read.value.operations[value.attemptId];
		if (!operation) return workFail("WORK_NOT_FOUND", false, { detail: "the attempt does not belong to this work" });
		if (this.isTerminal(operation.state)) return workOk(operation);
		const current = await this.deps.runtime.resolveRuntime(read.value.record.sessionId);
		// 只取消匹配的运行时：换绑后旧 attempt 的运行由新运行时自行收口，不越界中止别人的回合。
		if (!current || current.agentId !== operation.runtime.agentId || current.runtimeGeneration !== operation.runtime.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the runtime for this attempt is gone; the run cannot be cancelled scoped" });
		if (current.agentId !== agentId || current.runtimeGeneration !== target.runtimeGeneration) return workFail("RUNTIME_CHANGED", true, { detail: "the cancellation targets a stale runtime" });
		await this.deps.runtime.abort({ sessionId: read.value.record.sessionId, agentId: current.agentId, runtimeGeneration: current.runtimeGeneration });
		this.finish(value.workId, value.attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "cancelled by the user for this attempt only" });
		const after = this.deps.store.readWork(value.workId);
		return "error" in after ? after : workOk(after.value.operations[value.attemptId]);
	}

	async getOperation(input: unknown): Promise<WorkResult<DocumentWorkOperation>> {
		if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "operation input must be an object" });
		const value = input as Record<string, unknown>;
		if (!isWorkId(value.requestId) || !isBoundedText(value.sessionId, 200) || !value.sessionId) return workFail("INVALID_INPUT", false, { detail: "requestId and sessionId are required" });
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
	async recover(sessionId: unknown): Promise<WorkResult<{ works: DocumentWorkRecord[]; operations: DocumentWorkOperation[] }>> {
		if (!isBoundedText(sessionId, 200) || !sessionId) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
		const works = this.deps.store.listWorksForSession(sessionId);
		const operations: DocumentWorkOperation[] = [];
		for (const work of works) {
			const read = this.deps.store.readWork(work.workId);
			if ("error" in read) continue;
			operations.push(...Object.values(read.value.operations));
		}
		return workOk({ works, operations });
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
}
