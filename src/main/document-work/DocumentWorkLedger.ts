/**
 * TPA 独立文稿：操作台账（状态流转的唯一写入点）。
 *
 * 操作状态机的一次跃迁要么改操作本身，要么同时改工作记录（活动操作、requestId 台账、
 * 版本列表、失败标记）。这些写入散落在服务与分发器里最容易出现"两处对同一状态写不同值"，
 * 因此收口在这里：调用方只描述结果，不自己拼记录。
 */
import { workFail, workOk } from "../../shared/documentWork";
import type { DocumentWorkChangedEvent, DocumentWorkOperation } from "../../shared/types/documentWork";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import type { ArchiveOutcome } from "./DocumentArchiveService";

export function updateOperation(store: DocumentWorkStore, workId: string, attemptId: string, patch: Partial<DocumentWorkOperation>, now: () => number): boolean {
	const read = store.readWork(workId);
	if ("error" in read) return false;
	const applied = store.withWork(workId, read.value.revision, (bucket) => {
		const operation = bucket.operations[attemptId];
		if (!operation) return workFail<DocumentWorkOperation>("WORK_NOT_FOUND", false, { detail: "operation missing" });
		return workOk({ bucket: { ...bucket, operations: { ...bucket.operations, [attemptId]: { ...operation, ...patch, updatedAt: now() } } }, value: bucket.record });
	});
	return !("error" in applied);
}

const CHANGE_KIND: Record<ArchiveOutcome["state"], DocumentWorkChangedEvent["changeKind"]> = {
	archived: "archived",
	failed: "failed",
	interrupted: "interrupted",
	unknown: "unknown",
};

/**
 * 结算：只改操作与记录，不再调用模型；失败保留 staging 与输入。
 * 返回本次跃迁对应的推送事件（记录读取失败时为 undefined）。
 */
export function finishOperation(
	store: DocumentWorkStore,
	workId: string,
	attemptId: string,
	outcome: ArchiveOutcome,
	now: () => number,
	/** 额外登记的 requestId（取消请求）：让同 requestId 的重放能取回同一份回执，而不是按新请求再执行一次。 */
	alias?: { requestId: string; requestDigest: string },
): DocumentWorkChangedEvent | undefined {
	const read = store.readWork(workId);
	if ("error" in read) return undefined;
	const applied = store.withWork(workId, read.value.revision, (bucket) => {
		const operation = bucket.operations[attemptId];
		if (!operation) return workFail<DocumentWorkOperation>("WORK_NOT_FOUND", false, { detail: "operation missing" });
		const error = "code" in outcome && outcome.code ? { code: outcome.code, retryable: outcome.state === "failed" || outcome.state === "interrupted", ...("detail" in outcome && outcome.detail ? { detail: outcome.detail } : {}) } : undefined;
		const nextOperation: DocumentWorkOperation = {
			...operation,
			state: outcome.state,
			updatedAt: now(),
			...(error ? { error } : {}),
			...("versionId" in outcome && outcome.versionId ? { versionId: outcome.versionId } : {}),
		};
		const requests = {
			...bucket.record.requests,
			// 操作自己的 requestId（重复确认/未知重放保护）与调用方追加的别名请求（取消请求）都进台账。
			[operation.requestId]: { attemptId, requestDigest: operation.requestDigest, state: outcome.state },
			...(alias ? { [alias.requestId]: { attemptId, requestDigest: alias.requestDigest, state: outcome.state } } : {}),
		};
		const versions = "versionId" in outcome && outcome.versionId && !bucket.record.versions.includes(outcome.versionId) ? [...bucket.record.versions, outcome.versionId] : bucket.record.versions;
		const nextRecord = { ...bucket.record, requests, versions };
		if (bucket.record.activeOperationId === attemptId) delete nextRecord.activeOperationId;
		if (outcome.state === "failed" || outcome.state === "interrupted" || outcome.state === "unknown") nextRecord.lastFailure = { attemptId, code: error?.code ?? "IO_ERROR", at: now() };
		return workOk({ bucket: { ...bucket, record: nextRecord, operations: { ...bucket.operations, [attemptId]: nextOperation } }, value: bucket.record });
	});
	if ("error" in applied) return undefined;
	return { workId, sessionId: read.value.record.sessionId, revision: read.value.revision + 1, attemptId, changeKind: CHANGE_KIND[outcome.state] };
}
