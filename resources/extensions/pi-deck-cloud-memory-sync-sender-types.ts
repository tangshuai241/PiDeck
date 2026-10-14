/**
 * pi-deck-cloud-memory-sync-sender-types —— N08 发送器公开类型（B 接线 / C 消费状态）。
 * sync-sender.ts 从这里 re-export，保持既有 import 路径兼容。
 */

import type { SyncFetch } from "./pi-deck-cloud-memory-sync-transport";
import type { SyncQueue, SyncScopeInput } from "./pi-deck-cloud-memory-sync-types";

/** getConnection() 每次返回当前连接快照；sender 不缓存 token，只在单次 tick 内使用。 */
export type SyncConnectionSnapshot = {
	enabled: boolean;
	syncEnabled: boolean;
	baseUrl: string | null;
	token: string | null;
	accountId: string | null;
	cloudInstanceId: string | null;
};

export type SyncSenderPhase = "idle" | "sending" | "retrying" | "disabled" | "auth_blocked" | "scope_mismatch" | "owner_blocked" | "oversized" | "stopped";

export type SyncSenderStatus = {
	running: boolean;
	phase: SyncSenderPhase;
	accountId: string;
	cloudInstanceId: string;
	deviceId: string;
	/** 待传文件数/字节：只读元信息，含尚未确认的全部条目；计数失败为 null，不冒充 0。 */
	pendingTotal: number | null;
	pendingBytes: number | null;
	pendingCountError: string | null;
	conflictCount: number;
	notStoredCount: number;
	/** 本轮观察到的损坏/超大文件数（保留证据，不静默删除）。 */
	invalidCount: number;
	oversizedCount: number;
	/** 需要 chunk 协议的长记录（仅 sourceId 与字节数，无正文）。 */
	oversized: Array<{ sourceId: string; bytes: number }>;
	/** chunk 也拒绝（超过 record 16MiB 上限）的记录，同样不丢原件。 */
	rejectedCount: number;
	rejected: Array<{ sourceId: string; bytes: number }>;
	batchesSent: number;
	confirmedCount: number;
	chunkCount: number;
	/** 只有逐字段核对通过的回执才更新时间；未核对恒为 null。 */
	lastReceiptAt: string | null;
	lastError: string | null;
	lastErrorAt: string | null;
	hasLease: boolean;
	updatedAt: string;
};

export type SyncSenderDeps = {
	queue: SyncQueue;
	scope: SyncScopeInput;
	/** 可同步或异步返回当前快照（B 的 profileLoader 异步）；sender 每个关键 await 前后都复核同 scope。 */
	getConnection: () => SyncConnectionSnapshot | Promise<SyncConnectionSnapshot>;
	fetchImpl?: SyncFetch;
	onStatus?: (status: SyncSenderStatus) => void;
	/** 只允许元信息字段；不得传 token/URL query/正文。 */
	log?: (event: string, fields?: Record<string, unknown>) => void;
	now?: () => number;
	leaseTtlMs?: number;
	retryBaseMs?: number;
	retryMaxMs?: number;
	retrySlowPollMs?: number;
	maxBatchBytes?: number;
	maxBatchRecords?: number;
	/** 服务端 inline 单条上限，默认 48KiB；超过的条目走 chunk 协议。 */
	maxInlineRecordBytes?: number;
	/** 每 tick 最多处理的长记录条数，默认 1。 */
	maxChunkRecordsPerTick?: number;
};

export type SyncSender = {
	start(): Promise<void>;
	wake(): void;
	stop(): Promise<void>;
	getStatus(): SyncSenderStatus;
};
