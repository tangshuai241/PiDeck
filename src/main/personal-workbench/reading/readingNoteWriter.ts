/**
 * 笔记写入编排（P03）：未确认草稿 + 严格「已保存」判定 + 只读对账恢复。
 *
 * 规则来源：DeepRead wire 契约 §3/§4（两阶段 intent→note→ACK）与协调者补充：
 * - 成功只认 HTTP 200 + `ok:true` + `state:"applied"` + note revision 非空；
 *   pending/unknown 即使 HTTP 200 也只算未确认，草稿必须保留；
 * - 提交前先把「原 operation + 原 requestId」原子落盘（重开可复原，不做自动队列/轮询）；
 * - 重试复用同一 requestId + 完全相同 payload（签名一致才复用，改了就换新 id，避免 REQUEST_CONFLICT）；
 * - 恢复先查 `GET /api/notes/request`（只读）：applied→清稿，pending/unknown→留稿，
 *   结构化 404 `notFound`（服务端明确无记录）才用原载荷重发；unsupported/网络/认证等一切未确认都留稿返回，不盲 POST。
 */

import { randomBytes } from "node:crypto";
import type { ReadingErrorInfo, ReadingNoteDraft, ReadingNoteDraftActionResult, ReadingNoteDraftListResult, ReadingNoteDraftRef, ReadingNoteDraftResumeResult, ReadingNoteSummary, ReadingNoteWriteOperation, ReadingNoteWriteResult } from "../../../shared/types/reading";
import type { ReadingHttpClient } from "./readingHttpClient";
import type { ReadingHttpResult } from "./readingHttpClientTypes";
import type { ReadingNoteDraftScope, ReadingNoteDraftStore } from "./readingNoteDrafts";
import type { ReadingNoteIndexStore } from "./readingNoteIndexStore";
import { buildNoteWriteBody, parseWireNoteRequest, parseWireNoteWriteOutcome } from "./readingWire";

export type ReadingHandledResult = { ok: true; result: Extract<ReadingHttpResult, { ok: true }> } | { ok: false; error: ReadingErrorInfo };

export type ReadingNoteWriterDeps = {
	client: ReadingHttpClient;
	drafts: ReadingNoteDraftStore;
	index: ReadingNoteIndexStore;
	nowIso: () => string;
	/** 当前服务 origin + user：草稿按此隔离（切服务后旧草稿不被新服务的提交覆盖）。 */
	resolveScope: () => ReadingNoteDraftScope;
	/** 服务端结果分类（成功置 ready / 失败记 lastError 与能力位）。 */
	handleResult: (result: ReadingHttpResult, feature: "notes") => ReadingHandledResult;
};

/** 载荷签名：字段顺序固定，用于判断「同 key 的新提交是否与原草稿完全一致」。 */
function operationSignature(operation: ReadingNoteWriteOperation): string {
	if (operation.op === "create") {
		return JSON.stringify([operation.op, operation.workId, operation.editionId, operation.concept, operation.chapter ?? null, operation.quote ?? null, operation.understanding ?? null]);
	}
	return JSON.stringify([operation.op, operation.workId, operation.editionId, operation.noteId, operation.section, operation.content, operation.expectedRevision]);
}

function isApplied(outcome: { ok: boolean; state: string | null; note: { revision: string | null } | null }): boolean {
	return outcome.ok && outcome.state === "applied" && outcome.note !== null && outcome.note.revision !== null;
}

export class ReadingNoteWriter {
	private readonly deps: ReadingNoteWriterDeps;

	constructor(deps: ReadingNoteWriterDeps) {
		this.deps = deps;
	}

	/** 未确认草稿列表（当前 origin/user；含草稿文件损坏 issue，UI 可据此提示且不清稿）。 */
	async list(): Promise<ReadingNoteDraftListResult> {
		const { drafts, issue } = await this.deps.drafts.list(this.deps.resolveScope());
		return { ok: true, drafts, issue };
	}

	async discard(ref: ReadingNoteDraftRef): Promise<ReadingNoteDraftActionResult> {
		const scope = this.deps.resolveScope();
		const existing = await this.deps.drafts.get(ref.requestId, scope);
		if (!existing) return { ok: false, error: { code: "invalidInput", message: "没有对应的未确认草稿", detail: { field: "requestId", reason: "draftNotFound" } } };
		const removed = await this.deps.drafts.remove(ref.requestId);
		if (!removed.persisted) return { ok: false, error: removed.issue ?? { code: "writeFailed", message: "草稿删除失败" } };
		return { ok: true, discarded: true };
	}

	/** 提交写入：同载荷复用原 requestId，否则新开一份草稿（旧 intent 保留可查看）。 */
	async write(operation: ReadingNoteWriteOperation, clientRequestId?: string): Promise<ReadingNoteWriteResult> {
		const scope = this.deps.resolveScope();
		const noteId = operation.op === "create" ? null : operation.noteId;
		const signature = operationSignature(operation);
		const reusable = clientRequestId === undefined ? await this.deps.drafts.findReusable(scope, signature, (draft) => operationSignature(draft.operation)) : null;
		const requestId = clientRequestId ?? reusable?.requestId ?? `nd_${randomBytes(8).toString("hex")}`;
		const draft: ReadingNoteDraft = {
			requestId,
			origin: scope.origin,
			user: scope.user,
			workId: operation.workId,
			editionId: operation.editionId,
			noteId,
			op: operation.op,
			section: operation.op === "create" ? null : operation.section,
			content: operation.op === "create" ? (operation.understanding ?? "") : operation.content,
			chapterLabel: operation.op === "create" ? (operation.chapter ?? null) : null,
			updatedAt: this.deps.nowIso(),
			operation,
		};
		// 先留稿再发：字段校验已在边界完成；这里的失败只影响显示，不丢输入
		await this.deps.drafts.put(draft);
		return this.send(draft);
	}

	/** 恢复：先只读对账，必要时才用原 requestId + 原载荷重发。 */
	async resume(ref: ReadingNoteDraftRef): Promise<ReadingNoteDraftResumeResult> {
		const draft = await this.deps.drafts.get(ref.requestId, this.deps.resolveScope());
		if (!draft) return { ok: false, error: { code: "invalidInput", message: "没有对应的未确认草稿", detail: { field: "requestId", reason: "draftNotFound" } } };
		const probe = this.deps.handleResult(await this.deps.client.noteRequest(draft.requestId), "notes");
		if (probe.ok) {
			const state = parseWireNoteRequest(probe.result.json);
			if (state && isApplied({ ok: true, state: state.state, note: state.note })) {
				await this.confirm(draft, state.note!);
				return { ok: true, note: state.note!, requestId: draft.requestId };
			}
			const error: ReadingErrorInfo = { code: "unknownOutcome", message: "服务端仍未确认该笔记写入", detail: { state: state?.state ?? "unknown" } };
			return { ok: false, error, draft };
		}
		// 只有服务端明确「没有该 request 记录」（结构化 404 notFound）才证明原写入不存在，用原 requestId + 原载荷重发；
		// unsupported（端点未部署）不证明未写入，网络/认证/内部错误同样不证明——一律留稿返回，禁止盲 POST。
		if (probe.error.code === "notFound") return this.send(draft);
		return { ok: false, error: probe.error, draft };
	}

	private async confirm(draft: ReadingNoteDraft, note: ReadingNoteSummary): Promise<void> {
		await this.deps.drafts.remove(draft.requestId);
		await this.deps.index.upsert(draft.workId, note, this.deps.nowIso());
	}

	private async send(draft: ReadingNoteDraft): Promise<ReadingNoteWriteResult> {
		const handled = this.deps.handleResult(await this.deps.client.writeNote(buildNoteWriteBody(draft.operation, draft.requestId)), "notes");
		if (!handled.ok) return { ok: false, error: handled.error, draft };
		const outcome = parseWireNoteWriteOutcome(handled.result.json);
		if (!outcome) return { ok: false, error: { code: "internalError", message: "阅读服务笔记写入响应格式不正确" }, draft };
		if (!isApplied(outcome)) {
			const error: ReadingErrorInfo = outcome.error ?? { code: "unknownOutcome", message: "服务端尚未确认该笔记写入", detail: outcome.state ? { state: outcome.state } : undefined };
			return { ok: false, error, draft };
		}
		await this.confirm(draft, outcome.note!);
		return { ok: true, note: outcome.note!, requestId: draft.requestId };
	}
}

export { operationSignature as readingNoteOperationSignature };
