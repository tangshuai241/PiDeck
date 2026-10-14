/**
 * pi-deck-cloud-memory-sync-sender-loop —— N08 发送器生命周期与调度循环（装配层）。
 *
 * 每 tick 先看持久 envelope：有在途批次就按原 requestId/原集合查询或重发，不重新组批；
 * 没有才扫描队列装新批。auth 以 flag 为权威（token 只存 hash 指纹）；stop 等本 tick 结算、
 * 只 abort 自己的请求并按自己的 token 释放租约；暂停/空转状态保留慢轮询，新 token/新消息无需外部 wake。
 */

import { clearTimeout, setTimeout } from "node:timers";
import { createDefaultSyncFetch, MAX_BATCH_BYTES, MAX_BATCH_RECORDS, MAX_INLINE_RECORD_BYTES, requestIdForBatch, type SyncFetch } from "./pi-deck-cloud-memory-sync-transport";
import { deliverChunkEntry, deliverInlineBatch, type DeliveryDeps, type DeliveryOutcome } from "./pi-deck-cloud-memory-sync-sender-delivery";
import { ensureSenderLease, resolveSendEndpoint, tokenFingerprint, writeAuthBlocked } from "./pi-deck-cloud-memory-sync-sender-auth";
import { pickChunkEntry, recoverOpenBatch, removeSettledOversized } from "./pi-deck-cloud-memory-sync-sender-recover";
import { createInlineSelector, type InlineSelector } from "./pi-deck-cloud-memory-sync-sender-scan";
import { SyncOutboxError, type SyncOutboxEntry } from "./pi-deck-cloud-memory-sync-types";
import type { SyncConnectionSnapshot, SyncSender, SyncSenderDeps, SyncSenderStatus } from "./pi-deck-cloud-memory-sync-sender-types";

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
/** 连接/租约/账号/空转等暂停状态的慢轮询；不是发送超时门槛。 */
const SLOW_POLL_MS = 30_000;
const SAMPLE_LIMIT = 20;

export function createSenderRuntime(deps: SyncSenderDeps): SyncSender {
	const { queue, scope } = deps;
	if (queue.accountId !== scope.accountId || queue.cloudInstanceId !== scope.cloudInstanceId || queue.deviceId !== scope.deviceId) {
		throw new SyncOutboxError("scope_mismatch", "scope 与队列绑定不一致");
	}
	const now = deps.now ?? (() => Date.now());
	const iso = (): string => new Date(now()).toISOString();
	const fetchImpl: SyncFetch = deps.fetchImpl ?? createDefaultSyncFetch();
	const retryBase = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
	const retryMax = deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
	const slowPollMs = deps.retrySlowPollMs ?? SLOW_POLL_MS;
	const maxBatchBytes = deps.maxBatchBytes ?? MAX_BATCH_BYTES;
	const maxBatchRecords = deps.maxBatchRecords ?? MAX_BATCH_RECORDS;
	const maxInlineRecordBytes = deps.maxInlineRecordBytes ?? MAX_INLINE_RECORD_BYTES;
	const maxChunkRecordsPerTick = deps.maxChunkRecordsPerTick ?? 1;
	const leaseTtlMs = deps.leaseTtlMs ?? 60_000;

	let running = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let activeTick: Promise<void> | null = null;
	let tickAbort: AbortController | null = null;
	let retryAttempt = 0;
	let pendingTotal: number | null = 0;
	let pendingBytes: number | null = 0;
	let pendingCountError: string | null = null;
	let phase: SyncSenderStatus["phase"] = "idle";
	let lastReceiptAt: string | null = null;
	let lastError: string | null = null;
	let lastErrorAt: string | null = null;
	let updatedAt = iso();
	const counters = { batchesSent: 0, confirmedCount: 0, conflictCount: 0, notStoredCount: 0, invalidCount: 0, chunkCount: 0 };
	const oversized = new Map<string, { bytes: number; entry: SyncOutboxEntry }>();
	const rejected = new Map<string, number>();
	const leaseHolder = { token: null as string | null };
	const selector: InlineSelector = createInlineSelector({ queue, maxBatchRecords, maxBatchBytes, maxInlineRecordBytes });

	const alive = (): boolean => running && !stopped;

	function snapshot(): SyncSenderStatus {
		return {
			running,
			phase,
			accountId: scope.accountId,
			cloudInstanceId: scope.cloudInstanceId,
			deviceId: scope.deviceId,
			pendingTotal,
			pendingBytes,
			pendingCountError,
			conflictCount: counters.conflictCount,
			notStoredCount: counters.notStoredCount,
			invalidCount: counters.invalidCount,
			oversizedCount: oversized.size,
			oversized: [...oversized.entries()].slice(0, SAMPLE_LIMIT).map(([sourceId, item]) => ({ sourceId, bytes: item.bytes })),
			rejectedCount: rejected.size,
			rejected: [...rejected.entries()].slice(0, SAMPLE_LIMIT).map(([sourceId, bytes]) => ({ sourceId, bytes })),
			batchesSent: counters.batchesSent,
			confirmedCount: counters.confirmedCount,
			chunkCount: counters.chunkCount,
			lastReceiptAt,
			lastError,
			lastErrorAt,
			hasLease: leaseHolder.token !== null,
			updatedAt,
		};
	}

	function emit(): void {
		updatedAt = iso();
		try {
			deps.onStatus?.(snapshot());
		} catch {
			// 状态回调失败不得影响发送链路。
		}
	}

	function log(event: string, fields?: Record<string, unknown>): void {
		try {
			deps.log?.(event, fields);
		} catch {
			// 日志失败不影响发送。
		}
	}

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function requestTick(delayMs: number): void {
		if (!alive()) return;
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			startTick();
		}, Math.max(0, delayMs));
		timer.unref();
	}

	function startTick(): void {
		if (!alive() || activeTick !== null) return;
		activeTick = runTick()
			.catch(() => {
				if (alive()) scheduleRetry("unexpected_sender_error");
			})
			.finally(() => {
				activeTick = null;
			});
	}

	function noteFailure(reason: string): void {
		lastError = reason;
		lastErrorAt = iso();
	}

	function scheduleRetry(reason: string): void {
		retryAttempt += 1;
		noteFailure(reason);
		phase = "retrying";
		emit();
		log("sync.send.retry", { attempt: retryAttempt, reason });
		requestTick(Math.min(retryMax, retryBase * 2 ** Math.min(retryAttempt, 16)));
	}

	async function readConnection(): Promise<SyncConnectionSnapshot | null> {
		try {
			const connection = await deps.getConnection();
			return connection && typeof connection === "object" ? connection : null;
		} catch {
			return null;
		}
	}

	async function refreshCounts(): Promise<void> {
		try {
			const counts = await queue.countPending();
			pendingTotal = counts.count;
			pendingBytes = counts.bytes;
			pendingCountError = null;
		} catch {
			// 计数失败如实置 unknown，不冒充 0；发送仍走分页扫描。
			pendingTotal = null;
			pendingBytes = null;
			pendingCountError = "queue_count_failed";
			noteFailure("queue_count_failed");
		}
	}

	async function handleUnauthorized(token: string): Promise<void> {
		phase = "auth_blocked";
		noteFailure("http_401");
		try {
			await writeAuthBlocked(queue, scope, token);
		} catch {
			// 标志写失败仍内存暂停，不冒进发送。
		}
		emit();
		log("sync.send.auth_blocked", {});
		requestTick(slowPollMs);
	}

	async function handleOutcome(outcome: DeliveryOutcome, token: string): Promise<void> {
		if (outcome.kind === "progress") {
			counters.confirmedCount += outcome.confirmed;
			counters.conflictCount += outcome.conflicts;
			if (outcome.confirmed > 0) lastReceiptAt = iso();
			retryAttempt = 0;
			lastError = null;
			lastErrorAt = null;
			selector.reset();
			await refreshCounts();
			await removeSettledOversized(queue, oversized);
			phase = "sending";
			emit();
			requestTick(0);
			return;
		}
		if (outcome.kind === "retry") {
			if (outcome.reason === "receipt_not_stored") counters.notStoredCount += 1;
			scheduleRetry(outcome.reason);
			return;
		}
		if (outcome.kind === "paused") await handleUnauthorized(token);
		if (outcome.kind === "stale") requestTick(0);
		// aborted / too_large：由调用点处理。
	}

	/** 读取最新连接快照；不可发送时写 phase、安排慢轮询并返回 null。 */
	async function resolveEndpointOrPause(): Promise<{ baseUrl: string; token: string } | null> {
		const resolved = await resolveSendEndpoint({ readConnection, scope, alive });
		if (resolved.kind === "noop") return null;
		if (resolved.kind !== "ok") {
			phase = resolved.kind;
			emit();
			requestTick(slowPollMs);
			return null;
		}
		return { baseUrl: resolved.baseUrl, token: resolved.token };
	}

	async function runTick(): Promise<void> {
		await refreshCounts();
		if (!alive()) return;
		const pre = await resolveEndpointOrPause();
		if (!pre) return;
		const token = pre.token;

		// auth flag 权威；token 只比对指纹，同 scope 新 token 才恢复（旧 per-entry auth_blocked 分页还原）。
		const auth = await queue.getAuthState();
		if (!alive()) return;
		if (auth.blocked) {
			const fingerprint = tokenFingerprint(scope, token);
			if (auth.tokenHash === null || auth.tokenHash === fingerprint) {
				if (auth.tokenHash === null) await queue.setAuthBlocked(true, auth.reason ?? "auth_blocked", fingerprint);
				phase = "auth_blocked";
				emit();
				requestTick(slowPollMs);
				return;
			}
			await queue.setAuthBlocked(false, null);
			if (!alive()) return;
		}

		const leased = await ensureSenderLease({
			queue,
			alive,
			holder: leaseHolder,
			leaseTtlMs,
			onOwnerBlocked: (reason) => {
				phase = "owner_blocked";
				noteFailure(reason);
				emit();
				requestTick(slowPollMs);
			},
			onError: (reason) => scheduleRetry(reason),
		});
		if (!leased || !alive()) return;
		const endpoint = await resolveEndpointOrPause();
		if (!endpoint) return;
		const currentBaseUrl = endpoint.baseUrl;
		const currentToken = endpoint.token;

		const controller = new AbortController();
		tickAbort = controller;
		const checkCurrent = async (): Promise<boolean> => {
			if (!alive()) return false;
			const latest = await readConnection();
			return Boolean(latest && latest.enabled && latest.syncEnabled && latest.baseUrl === currentBaseUrl && latest.token === currentToken && latest.accountId === scope.accountId && latest.cloudInstanceId === scope.cloudInstanceId);
		};
		const delivery: DeliveryDeps = { queue, endpoint: { baseUrl: currentBaseUrl, token: currentToken }, fetchImpl, signal: controller.signal, isAlive: alive, checkCurrent, log };
		try {
			const open = await queue.readOpenBatch();
			if (!alive()) return;
			if (open) {
				const outcome = await recoverOpenBatch({ queue, delivery, alive }, open);
				if (!alive()) return;
				if (outcome.kind === "too_large") {
					rejected.set(open.items[0].sourceId, outcome.bytes);
					await queue.clearOpenBatch(open.requestId);
					requestTick(0);
					return;
				}
				await handleOutcome(outcome, currentToken);
				return;
			}

			const selected = await selector.select();
			if (!alive()) return;
			counters.invalidCount += selected.invalidCount;
			if (selected.invalidCount > 0) log("sync.send.invalid", { count: selected.invalidCount });
			for (const item of selected.oversized) oversized.set(item.sourceId, { bytes: item.bytes, entry: item.entry });
			if (selected.batch.length > 0) {
				const requestId = requestIdForBatch(selected.batch.map((entry) => entry.record));
				const wasUnknown = selected.batch.some((entry) => entry.state === "unknown");
				const outcome = await deliverInlineBatch(delivery, selected.batch, requestId, wasUnknown);
				if (!alive()) return;
				if (outcome.kind === "progress") counters.batchesSent += 1;
				await handleOutcome(outcome, currentToken);
				return;
			}

			for (let index = 0; index < maxChunkRecordsPerTick; index += 1) {
				if (!alive()) return;
				const picked = pickChunkEntry(oversized, rejected, log);
				if (picked === null) break;
				const outcome = await deliverChunkEntry(delivery, picked);
				if (!alive()) return;
				if (outcome.kind === "progress") {
					if (outcome.confirmed > 0 || outcome.conflicts > 0) oversized.delete(picked.record.sourceId);
					if (outcome.confirmed > 0) counters.chunkCount += 1;
					await handleOutcome(outcome, currentToken);
					return;
				}
				if (outcome.kind === "too_large") {
					rejected.set(picked.record.sourceId, outcome.bytes);
					oversized.delete(picked.record.sourceId);
					log("sync.send.chunk_rejected", { bytes: outcome.bytes });
					requestTick(0);
					return;
				}
				await handleOutcome(outcome, currentToken);
				return;
			}

			phase = oversized.size > 0 || rejected.size > 0 ? "oversized" : "idle";
			emit();
			requestTick(slowPollMs);
		} finally {
			if (tickAbort === controller) tickAbort = null;
		}
	}

	async function start(): Promise<void> {
		if (running || stopped) return;
		running = true;
		phase = "idle";
		retryAttempt = 0;
		log("sync.send.started", {});
		await refreshCounts();
		emit();
		requestTick(0);
	}

	function wake(): void {
		if (!alive()) return;
		requestTick(0);
	}

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		running = false;
		clearTimer();
		if (tickAbort !== null) {
			tickAbort.abort();
			tickAbort = null;
		}
		const active = activeTick;
		if (active !== null) {
			try {
				await active;
			} catch {
				// 本 tick 的失败已在发送链路内结算。
			}
		}
		if (leaseHolder.token !== null) {
			try {
				await queue.releaseSender(leaseHolder.token);
			} catch {
				// 释放失败保持租约，等 TTL/存活校验过期。
			}
			leaseHolder.token = null;
		}
		await refreshCounts();
		phase = "stopped";
		emit();
		log("sync.send.stopped", {});
	}

	return { start, wake, stop, getStatus: snapshot };
}
