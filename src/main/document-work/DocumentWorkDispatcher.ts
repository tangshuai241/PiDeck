/**
 * TPA 独立文稿：分发器（绑定 → 派发 → 等稳定点 → 结算）。
 *
 * 这里是"accepted 不等于执行完成"的落点：
 * - 绑定命令被拒 = 确定没送达 → `failed`；
 * - 命令被接受但没等到绑定确认 = 无法证明是否执行 → `unknown`，**不重放**；
 * - 等确认期间或确认之后换绑 = 可以证明没落在当前运行时上 → `interrupted`；
 * - 派发完成后必须等 `agent_settled` 且运行时无排队才归档（`DocumentArchiveService`）。
 *
 * 初稿走既有的 `/align approve` 入口（语义不变，只是被文稿绑定闸管住）；
 * 改稿走 `/tpa-work revise`，由扩展用**主进程冻结的那一份指令正文**触发一个回合。
 */
import { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_COMMAND, DOCUMENT_WORK_SCHEMA_VERSION, encodeWorkBinding, utf8ByteLength, type WorkResult } from "../../shared/documentWork";
import type { DocumentWorkChangedEvent, DocumentWorkOperation, DocumentWorkPreparation } from "../../shared/types/documentWork";
import type { ArchiveOutcome, DocumentArchiveService } from "./DocumentArchiveService";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { finishOperation, updateOperation } from "./DocumentWorkLedger";
import { runtimeStillMatches, type DocumentWorkRuntimeAdapter, type DocumentWorkRuntimePort, type DocumentWorkRuntimeTarget } from "./DocumentWorkRuntimeAdapter";

export type DocumentWorkDispatcherDeps = {
	store: DocumentWorkStore;
	runtime: DocumentWorkRuntimePort;
	adapter: DocumentWorkRuntimeAdapter;
	archive: DocumentArchiveService;
	emit: (event: DocumentWorkChangedEvent) => void;
	now?: () => number;
	/** 绑定确认等待时限覆盖点（默认取共享预算）；测试用它避免真的等 20 秒。 */
	bindAckMs?: number;
};

export class DocumentWorkDispatcher {
	private readonly deps: DocumentWorkDispatcherDeps;
	private readonly now: () => number;

	constructor(deps: DocumentWorkDispatcherDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
	}

	/** 分发 + 结算；调用方（服务）负责在互斥里把操作记录先落盘。 */
	async run(operation: DocumentWorkOperation, preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Promise<void> {
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

	private finish(workId: string, attemptId: string, outcome: ArchiveOutcome): void {
		const event = finishOperation(this.deps.store, workId, attemptId, outcome, this.now);
		if (event) this.deps.emit(event);
	}

	private update(workId: string, attemptId: string, patch: Partial<DocumentWorkOperation>): void {
		updateOperation(this.deps.store, workId, attemptId, patch, this.now);
	}

	/** 组装绑定载荷：只带本轮需要的身份与边界，不带正文。 */
	buildBindPayload(operation: DocumentWorkOperation, preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Record<string, unknown> {
		return {
			schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
			// 稳定会话 id（主进程看）与原生 Pi 会话 id（扩展只能看这个）必须同时给出。
			sessionId: target.sessionId,
			nativeSessionId: target.piSessionId ?? "",
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
			workId: operation.workId,
			attemptId: operation.attemptId,
			preparationId: preparation.preparationId,
			digest: preparation.digest,
			kind: preparation.kind,
			stagingRelativeDir: preparation.stagingRelativeDir,
			outputRelativeDir: preparation.outputRelativeDir,
			outputRootId: this.outputRootIdOf(operation.workId),
			outputRootPath: this.outputRootPathOf(operation.workId),
			materialRoots: preparation.materialRoots.map((root) => ({ rootId: root.rootId, path: root.path, kind: root.kind, label: root.label })),
			materials: preparation.materials.map((material) => ({ materialId: material.materialId, rootId: material.rootId, relativePath: material.relativePath, sha256: material.sha256, converter: material.converter })),
			...(preparation.base ? { base: { relativePath: preparation.base.relativePath, sha256: preparation.base.sha256, versionId: preparation.base.versionId } } : {}),
			scope: preparation.scope,
			...(preparation.instruction ? { instruction: { sourceTurnId: preparation.instruction.sourceTurnId, text: preparation.instruction.text, textDigest: preparation.instruction.textDigest } } : {}),
			budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
			...(preparation.authorization.kind === "alignment_confirmation" ? { briefId: preparation.authorization.briefId, briefRevision: preparation.authorization.revision } : {}),
		};
	}

	private outputRootIdOf(workId: string): string {
		const read = this.deps.store.readWork(workId);
		return "error" in read ? "" : read.value.record.outputRootId;
	}

	private outputRootPathOf(workId: string): string {
		const read = this.deps.store.readWork(workId);
		if ("error" in read) return "";
		const root = read.value.record.outputRootId ? this.deps.store.getOutputRoot(read.value.record.outputRootId) : undefined;
		return root && root.ok ? root.value.path : "";
	}

	/**
	 * 绑定 + 派发。返回 true 表示已经派发了实际执行回合（可以进入等待稳定点）。
	 */
	private async bind(operation: DocumentWorkOperation, preparation: DocumentWorkPreparation, target: DocumentWorkRuntimeTarget): Promise<boolean> {
		const workRead = this.deps.store.readWork(operation.workId);
		if ("error" in workRead) {
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "WORK_NOT_FOUND", detail: "the work record disappeared" });
			return false;
		}
		if (!target.piSessionId) {
			// 拿不到原生身份就不绑定：扩展无法核对，绑定只会被拒，属于运行时不完整。
			this.finish(operation.workId, operation.attemptId, { state: "failed", code: "EXTENSION_UNAVAILABLE", detail: "the native pi session identity is not available for this runtime" });
			return false;
		}
		const encoded = encodeWorkBinding(this.buildBindPayload(operation, preparation, target));
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
		// 等待确认期间被换绑：这可以证明（而不是猜）本轮没有落在当前运行时上，记中断。
		if (!(await runtimeStillMatches(this.deps.runtime, target))) {
			this.finish(operation.workId, operation.attemptId, { state: "interrupted", code: "RUNTIME_CHANGED", detail: "the runtime changed while waiting for the binding confirmation" });
			return false;
		}
		if (!confirmation.ok) {
			// 命令已被接受但没等到确认：可能已执行也可能没有，记未知且不重放。
			this.finish(operation.workId, operation.attemptId, { state: "unknown", code: "DISPATCH_UNKNOWN", detail: confirmation.reason });
			return false;
		}
		this.update(operation.workId, operation.attemptId, { state: "running" });
		this.deps.emit({ workId: operation.workId, sessionId: target.sessionId, revision: 0, attemptId: operation.attemptId, changeKind: "running" });
		const runMessage = this.runMessage(preparation);
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
	 * 本轮执行消息。
	 *
	 * 初稿：既有的 `/align approve <briefId> <revision>`（旧入口兼容）。
	 * 改稿：`/tpa-work revise`，扩展用主进程冻结的指令正文触发回合；主进程不把
	 * 用户原文再塞一遍进会话（避免重复消息与二次计费），扩展只从绑定载荷取。
	 */
	private runMessage(preparation: DocumentWorkPreparation): string | undefined {
		if (preparation.authorization.kind === "alignment_confirmation") return `/align approve ${preparation.authorization.briefId} ${preparation.authorization.revision}`;
		if (preparation.kind !== "revise_document" || !preparation.instruction) return undefined;
		return `/${DOCUMENT_WORK_COMMAND} revise`;
	}
}

export type DispatcherResult = WorkResult<DocumentWorkOperation>;
