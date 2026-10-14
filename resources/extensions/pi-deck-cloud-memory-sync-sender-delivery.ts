/**
 * pi-deck-cloud-memory-sync-sender-delivery —— 发送动作层（inline 批 / 409 拆单条 / chunk 单条 / 回执核对）。
 *
 * 发送前先落盘 in-flight envelope 并把条目持久化为 unknown；未知结果先按 envelope 的 requestId
 * 查询回执，404 才用同一 requestId 重发。冲突 409 有 sourceId 列表时只标该条，无列表时拆单条定位。
 */

import { getConversationImportReceipt, postConversationImport, requestIdForBatch, type SyncFetch } from "./pi-deck-cloud-memory-sync-transport";
import { deliverChunkRecord } from "./pi-deck-cloud-memory-sync-sender-chunk";
import type { SyncOutboxEntry, SyncQueue, SyncRecord } from "./pi-deck-cloud-memory-sync-types";

export type DeliveryEndpoint = { baseUrl: string; token: string };

export type DeliveryDeps = {
	queue: SyncQueue;
	endpoint: DeliveryEndpoint;
	fetchImpl: SyncFetch;
	signal: AbortSignal;
	isAlive: () => boolean;
	/** chunk 每片请求前复核 stopped/scope/enabled/token 未变；false 则本轮中止、下轮重来。 */
	checkCurrent?: () => Promise<boolean>;
	log?: (event: string, fields?: Record<string, unknown>) => void;
};

export type DeliveryOutcome =
	| { kind: "progress"; confirmed: number; conflicts: number }
	| { kind: "retry"; reason: string }
	| { kind: "paused"; status: number }
	| { kind: "aborted" }
	| { kind: "stale" }
	| { kind: "too_large"; bytes: number };

function log(deps: DeliveryDeps, event: string, fields?: Record<string, unknown>): void {
	try {
		deps.log?.(event, fields);
	} catch {
		// 日志失败不影响发送。
	}
}

function readReceiptSourceId(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	if ("sourceId" in value && typeof value.sourceId === "string") return value.sourceId;
	if ("source_id" in value && typeof value.source_id === "string") return value.source_id;
	return null;
}

type ReceiptSummary = { confirmed: number; conflicts: number; problem: string | null };

async function applyReceipts(deps: DeliveryDeps, receipts: readonly unknown[], batch: readonly SyncOutboxEntry[]): Promise<ReceiptSummary> {
	const bySourceId = new Map(batch.map((entry) => [entry.record.sourceId, entry]));
	let confirmed = 0;
	let conflicts = 0;
	let problem: string | null = null;
	for (const raw of receipts) {
		const sourceId = readReceiptSourceId(raw);
		const entry = sourceId === null ? undefined : bySourceId.get(sourceId);
		if (!entry) {
			log(deps, "sync.send.receipt_unmatched", {});
			continue;
		}
		const result = await deps.queue.applyReceipt(entry.record.sourceId, raw);
		switch (result.status) {
			case "confirmed":
				confirmed += 1;
				break;
			case "mismatch":
				conflicts += 1;
				problem = problem ?? "receipt_mismatch";
				break;
			case "not_stored":
				problem = problem ?? "receipt_not_stored";
				break;
			default:
				problem = problem ?? "receipt_invalid";
				break;
		}
	}
	return { confirmed, conflicts, problem };
}

/** 只有批次内不再有 unknown/pending 残留（或已冲突）时才清除 envelope；信封不是回执。 */
export async function settleEnvelope(deps: DeliveryDeps, requestId: string, batch: readonly SyncOutboxEntry[]): Promise<void> {
	for (const entry of batch) {
		let current: SyncOutboxEntry | null;
		try {
			current = await deps.queue.readEntry(entry.record.sourceId);
		} catch {
			return; // 损坏保留证据，envelope 不动
		}
		if (current !== null && current.state !== "conflict") return;
	}
	await deps.queue.clearOpenBatch(requestId);
}

async function persistBatchAndMarkUnknown(deps: DeliveryDeps, requestId: string, mode: "inline" | "chunk", entries: readonly SyncOutboxEntry[]): Promise<void> {
	await deps.queue.beginBatch({ requestId, mode, items: entries.map((entry) => ({ sourceId: entry.record.sourceId, contentHash: entry.record.contentHash, revision: entry.record.identity.revision })) });
	for (const entry of entries) await deps.queue.markUnknown(entry.record.sourceId, { reason: "send_started" });
}

type SingleOutcome = { kind: "progress"; confirmed: number; conflicts: number } | { kind: "retry"; reason: string } | { kind: "paused"; status: number } | { kind: "aborted" };

async function deliverSingleInline(deps: DeliveryDeps, entry: SyncOutboxEntry): Promise<SingleOutcome> {
	const batch = [entry];
	const requestId = requestIdForBatch([entry.record]);
	try {
		await persistBatchAndMarkUnknown(deps, requestId, "inline", batch);
	} catch {
		return { kind: "retry", reason: "queue_mark_unknown_failed" };
	}
	if (!deps.isAlive()) return { kind: "aborted" };
	const result = await postConversationImport({ baseUrl: deps.endpoint.baseUrl, token: deps.endpoint.token, requestId, records: [entry.record], fetchImpl: deps.fetchImpl, signal: deps.signal });
	if (!deps.isAlive()) return { kind: "aborted" };
	if (result.kind === "unauthorized") return { kind: "paused", status: result.status };
	if (result.kind === "conflict") {
		try {
			await deps.queue.markConflict(entry.record.sourceId, "server_409");
		} catch {
			// 标记失败保留 unknown，下轮重试。
		}
		await deps.queue.clearOpenBatch(requestId);
		return { kind: "progress", confirmed: 0, conflicts: 1 };
	}
	if (result.kind === "ok") {
		const summary = await applyReceipts(deps, result.receipts, batch);
		await settleEnvelope(deps, requestId, batch);
		if (summary.confirmed > 0 || summary.conflicts > 0) return { kind: "progress", confirmed: summary.confirmed, conflicts: summary.conflicts };
		return { kind: "retry", reason: summary.problem ?? "receipt_no_progress" };
	}
	if (result.kind === "failure") return result.reason === "aborted" ? { kind: "aborted" } : { kind: "retry", reason: result.reason };
	return { kind: "retry", reason: "import_not_found" };
}

async function deliverSplit(deps: DeliveryDeps, entries: readonly SyncOutboxEntry[]): Promise<DeliveryOutcome> {
	let confirmed = 0;
	let conflicts = 0;
	for (const entry of entries) {
		if (!deps.isAlive()) return { kind: "aborted" };
		const outcome = await deliverSingleInline(deps, entry);
		if (outcome.kind === "paused") return outcome;
		if (outcome.kind === "aborted") return outcome;
		if (outcome.kind === "retry") return { kind: "retry", reason: outcome.reason };
		confirmed += outcome.confirmed;
		conflicts += outcome.conflicts;
	}
	return { kind: "progress", confirmed, conflicts };
}

export async function deliverInlineBatch(deps: DeliveryDeps, batch: readonly SyncOutboxEntry[], requestId: string, wasUnknown: boolean): Promise<DeliveryOutcome> {
	try {
		await persistBatchAndMarkUnknown(deps, requestId, "inline", batch);
	} catch {
		return { kind: "retry", reason: "queue_mark_unknown_failed" };
	}
	if (!deps.isAlive()) return { kind: "aborted" };
	if (wasUnknown) {
		const receipt = await getConversationImportReceipt({ baseUrl: deps.endpoint.baseUrl, token: deps.endpoint.token, requestId, fetchImpl: deps.fetchImpl, signal: deps.signal });
		if (!deps.isAlive()) return { kind: "aborted" };
		if (receipt.kind === "ok") {
			const summary = await applyReceipts(deps, receipt.receipts, batch);
			await settleEnvelope(deps, requestId, batch);
			if (summary.confirmed > 0 || summary.conflicts > 0) return { kind: "progress", confirmed: summary.confirmed, conflicts: summary.conflicts };
			return { kind: "retry", reason: summary.problem ?? "receipt_no_progress" };
		}
		if (receipt.kind === "unauthorized") return { kind: "paused", status: receipt.status };
		if (receipt.kind === "conflict") {
			if (batch.length > 1 && receipt.sourceIds.length === 0) return deliverSplit(deps, batch);
			const target = receipt.sourceIds.length > 0 ? batch.filter((entry) => receipt.sourceIds.includes(entry.record.sourceId)) : batch;
			for (const entry of target) {
				try {
					await deps.queue.markConflict(entry.record.sourceId, "server_409");
				} catch {
					// 保留 unknown。
				}
			}
			await deps.queue.clearOpenBatch(requestId);
			return { kind: "progress", confirmed: 0, conflicts: target.length };
		}
		if (receipt.kind === "failure") return receipt.reason === "aborted" ? { kind: "aborted" } : { kind: "retry", reason: receipt.reason };
		// not_found → 用同一 requestId 重发。
	}
	const result = await postConversationImport({ baseUrl: deps.endpoint.baseUrl, token: deps.endpoint.token, requestId, records: batch.map((entry) => entry.record), fetchImpl: deps.fetchImpl, signal: deps.signal });
	if (!deps.isAlive()) return { kind: "aborted" };
	if (result.kind === "unauthorized") return { kind: "paused", status: result.status };
	if (result.kind === "conflict") {
		if (batch.length > 1 && result.sourceIds.length === 0) return deliverSplit(deps, batch);
		const target = result.sourceIds.length > 0 ? batch.filter((entry) => result.sourceIds.includes(entry.record.sourceId)) : batch;
		for (const entry of target) {
			try {
				await deps.queue.markConflict(entry.record.sourceId, "server_409");
			} catch {
				// 保留 unknown。
			}
		}
		await deps.queue.clearOpenBatch(requestId);
		return { kind: "progress", confirmed: 0, conflicts: target.length };
	}
	if (result.kind === "ok") {
		const summary = await applyReceipts(deps, result.receipts, batch);
		await settleEnvelope(deps, requestId, batch);
		log(deps, "sync.send.batch", { records: batch.length, status: result.status });
		if (summary.confirmed > 0 || summary.conflicts > 0) return { kind: "progress", confirmed: summary.confirmed, conflicts: summary.conflicts };
		return { kind: "retry", reason: summary.problem ?? "receipt_no_progress" };
	}
	if (result.kind === "failure") return result.reason === "aborted" ? { kind: "aborted" } : { kind: "retry", reason: result.reason };
	return { kind: "retry", reason: "import_not_found" };
}

/** 单条长记录：envelope(mode=chunk) 落盘 → chunk 状态/续传/complete → 回执逐字段核对。 */
export async function deliverChunkEntry(deps: DeliveryDeps, entry: SyncOutboxEntry): Promise<DeliveryOutcome> {
	const wasUnknown = entry.state === "unknown";
	const requestId = requestIdForBatch([entry.record]);
	try {
		await persistBatchAndMarkUnknown(deps, requestId, "chunk", [entry]);
	} catch {
		return { kind: "retry", reason: "queue_mark_unknown_failed" };
	}
	if (!deps.isAlive()) return { kind: "aborted" };
	const result = await deliverChunkRecord({ baseUrl: deps.endpoint.baseUrl, token: deps.endpoint.token, record: entry.record, wasUnknown, fetchImpl: deps.fetchImpl, signal: deps.signal, checkCurrent: deps.checkCurrent });
	if (!deps.isAlive()) return { kind: "aborted" };
	switch (result.kind) {
		case "confirmed": {
			const applied = await deps.queue.applyReceipt(entry.record.sourceId, result.receipt);
			await settleEnvelope(deps, requestId, [entry]);
			if (applied.status === "confirmed") return { kind: "progress", confirmed: 1, conflicts: 0 };
			if (applied.status === "mismatch") return { kind: "progress", confirmed: 0, conflicts: 1 };
			return { kind: "retry", reason: applied.status === "not_stored" ? "receipt_not_stored" : "receipt_invalid" };
		}
		case "conflict":
			try {
				await deps.queue.markConflict(entry.record.sourceId, "server_409");
			} catch {
				// 保留 unknown。
			}
			await deps.queue.clearOpenBatch(requestId);
			return { kind: "progress", confirmed: 0, conflicts: 1 };
		case "too_large":
			await deps.queue.clearOpenBatch(requestId);
			return { kind: "too_large", bytes: result.bytes };
		case "unauthorized":
			return { kind: "paused", status: result.status };
		case "aborted":
			return { kind: "aborted" };
		case "stale":
			return { kind: "stale" };
		default:
			return { kind: "retry", reason: result.reason };
	}
}

/** 恢复 unknown 批次：按 envelope 的原 requestId 与原集合查回执/重发，不重新组批。 */
export async function recoverEnvelopeBatch(deps: DeliveryDeps, requestId: string, mode: "inline" | "chunk", entries: readonly SyncOutboxEntry[]): Promise<DeliveryOutcome> {
	if (entries.length === 0) {
		await deps.queue.clearOpenBatch(requestId);
		return { kind: "progress", confirmed: 0, conflicts: 0 };
	}
	if (mode === "chunk") {
		let confirmed = 0;
		let conflicts = 0;
		for (const entry of entries) {
			if (!deps.isAlive()) return { kind: "aborted" };
			const outcome = await deliverChunkEntry(deps, entry);
			if (outcome.kind === "paused" || outcome.kind === "aborted" || outcome.kind === "stale") return outcome;
			if (outcome.kind === "retry") return outcome;
			if (outcome.kind === "too_large") return outcome;
			confirmed += outcome.confirmed;
			conflicts += outcome.conflicts;
		}
		return { kind: "progress", confirmed, conflicts };
	}
	const wasUnknown = entries.some((entry) => entry.state === "unknown");
	return deliverInlineBatch(deps, entries, requestId, wasUnknown);
}
