/**
 * pi-deck-cloud-memory-sync-types —— N05/N06 共用公开契约（采集、原话身份、待传队列、发送）。
 *
 * 只放类型与常量，不做 IO、不依赖 pi SDK、不读取配置：采集（N05）、队列（N06）、
 * 后台发送（N08）都从这里取结构，避免三个模块各写一套字段。
 *
 * 冻结口径来自 `E:/A PI/cache/TPA-cloud-memory/execution/frozen-contract.md`：
 * - 来源身份包含账号、云端实例、device_id、Pi session_id、entry_id 与 revision；
 *   agentId/进程号不作为来源。
 * - source_id = "src_" + 固定 JSON 数组序列化后的完整 SHA-256（数组顺序见 identity 模块）。
 * - text_sha256 对原始 UTF-8 可见文本直接取 SHA-256：不 trim、不合并空白、不改换行。
 * - content_hash 覆盖固定业务字段（角色、文本块、时间、项目、父条目、分支、完成/可见状态），
 *   不含待传状态、重试时间、云端序号、revision 本身。
 * revision 由 TPA 侧产生：原生 entry 不可改写，编辑/隐藏/分支变化以 revision+1 的新事件表达。
 */

/** 队列状态文件与回执文件的 schema 标记；旧文件缺省字段按默认值读取，保持向后兼容。 */
export const SYNC_RECORD_SCHEMA = "pi-deck-cloud-memory-sync-record";
export const SYNC_OUTBOX_SCHEMA = "pi-deck-cloud-memory-sync-outbox";
export const SYNC_OUTBOX_RECEIPT_SCHEMA = "pi-deck-cloud-memory-sync-outbox-receipt";
export const SYNC_SCHEMA_VERSION = 1;

export const SOURCE_ID_PREFIX = "src_";
/** 身份固定字段序列化顺序：账号、云端实例、device、session、entry、revision。 */
export const SOURCE_ID_FIELD_ORDER = ["accountId", "cloudInstanceId", "deviceId", "sessionId", "entryId", "revision"] as const;

/** 单个身份字段上限；项目标签沿用云端 64 字符口径。 */
export const MAX_IDENTITY_FIELD_CHARS = 256;
export const MAX_PROJECT_CHARS = 64;
export const MAX_OCCURRED_AT_CHARS = 64;
/** 单条待传记录的落盘上限（字节）；超限由采集方分块，队列不静默截断。 */
export const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** 角色只区分用户与助手可见回答；工具结果、思考过程不进入采集范围。 */
export type SyncRole = "user" | "assistant";
/** 取消或错误中断的部分回答标 incomplete；完整回答标 completed。 */
export type SyncCompletion = "completed" | "incomplete";
/** 可见性事件：隐藏不删除原件，只追加表达。 */
export type SyncVisibility = "visible" | "hidden";
/** message = 原话/编辑后的内容事件；visibility = 仅可见性或分支变化事件。 */
export type SyncEventKind = "message" | "visibility";

/** 可见文本块：只保留 Pi 消息内容里的 text 块，逐字不改写。 */
export type SyncTextBlock = { readonly type: "text"; readonly text: string };

/** 来源身份；accountId 只来自已认证账号，不接受载荷冒充。 */
export type SyncIdentity = {
	readonly accountId: string;
	readonly cloudInstanceId: string;
	readonly deviceId: string;
	readonly sessionId: string;
	readonly entryId: string;
	/** TPA 侧修订序号，从 1 开始；Pi 1.1.0 没有 revision。 */
	readonly revision: number;
};

/** 采集/编辑事件录入队列的原始输入（content 允许 Pi 的 string | content blocks）。 */
export type SyncRecordInput = {
	readonly kind?: SyncEventKind;
	readonly identity: SyncIdentity;
	readonly role: SyncRole;
	readonly content: unknown;
	readonly project?: string | null;
	readonly parentSourceId?: string | null;
	readonly targetSourceId?: string | null;
	readonly branch?: string | null;
	readonly occurredAt: string;
	readonly completion?: SyncCompletion;
	readonly visibility?: SyncVisibility;
};

/** 本地待传原话记录（已含派生身份与哈希）；队列与发送层共用。 */
export type SyncRecord = {
	readonly schema: typeof SYNC_RECORD_SCHEMA;
	readonly version: number;
	readonly kind: SyncEventKind;
	readonly identity: SyncIdentity;
	readonly sourceId: string;
	readonly role: SyncRole;
	readonly textBlocks: readonly SyncTextBlock[];
	/** 可见文本 = 各 text 块以 LF 连接（与既有 extractMessageText 口径一致）。 */
	readonly visibleText: string;
	readonly textSha256: string;
	readonly contentHash: string;
	readonly project: string | null;
	readonly parentSourceId: string | null;
	/** 编辑/可见性事件指向上一个 revision 的 sourceId；原始条目录入时为 null。 */
	readonly targetSourceId: string | null;
	readonly branch: string | null;
	readonly occurredAt: string;
	readonly completion: SyncCompletion;
	readonly visibility: SyncVisibility;
};

/** 云端回执的本地核对视图；字段名对齐冻结契约的逐字段核对项。 */
export type SyncReceipt = {
	readonly stored: boolean;
	readonly accountId: string;
	readonly cloudInstanceId: string;
	readonly sourceId: string;
	readonly revision: number;
	readonly contentHash: string;
	readonly textSha256: string;
	readonly deduped?: boolean;
	readonly cloudMessageId?: string | null;
};

export type SyncOutboxState = "pending" | "unknown" | "auth_blocked" | "conflict";

/** 队列条目：记录本体 + 本地发送元数据（元数据不参与 content_hash）。 */
export type SyncOutboxEntry = {
	readonly schema: typeof SYNC_OUTBOX_SCHEMA;
	readonly version: number;
	readonly state: SyncOutboxState;
	/** auth_blocked 前的状态，用于认证恢复后原位还原。 */
	readonly previousState: SyncOutboxState | null;
	readonly record: SyncRecord;
	readonly attempts: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastAttemptAt: string | null;
	readonly lastError: string | null;
	readonly conflictReason: string | null;
	readonly receipt: SyncReceipt | null;
};

export type SyncRegisterStatus = "queued" | "duplicate" | "conflict";
export type SyncExistingKind = "none" | "pending" | "confirmed" | "conflict";

export type SyncRegisterResult = {
	readonly status: SyncRegisterStatus;
	readonly sourceId: string;
	readonly existing: SyncExistingKind;
	readonly entry: SyncOutboxEntry | null;
	/** 同身份异内容时，传入内容被保留的位置（证据，不清除已有条目）。 */
	readonly conflictFile?: string;
};

export type SyncReceiptStatus = "confirmed" | "not_stored" | "mismatch" | "missing" | "invalid";

export type SyncReceiptResult = {
	readonly status: SyncReceiptStatus;
	readonly sourceId: string;
	/** 逐字段核对不通过的字段名；非 mismatch 时为空数组。 */
	readonly mismatches: readonly string[];
	readonly entry: SyncOutboxEntry | null;
};

export type SyncSenderLease = {
	readonly token: string;
	readonly accountId: string;
	readonly cloudInstanceId: string;
	readonly deviceId: string;
	readonly pid: number;
	readonly processStartedAt: string;
	readonly createdAt: string;
	readonly heartbeatAt: string;
	readonly expiresAt: string;
};

export type SyncSenderClaim =
	| { readonly status: "claimed"; readonly lease: SyncSenderLease }
	/** active_owner = pid 仍存活（或同进程）；unknown_owner/unreadable_lease = 无法证实死亡，一律不抢。 */
	| { readonly status: "blocked"; readonly reason: "active_owner" | "unknown_owner" | "unreadable_lease"; readonly owner: SyncSenderLease | null };

export type SyncInvalidFile = { readonly file: string; readonly reason: string };

/** 分页读取选项：limit 默认 100（返回条数），maxScan 限制本轮扫描文件数（含 invalid）；cursor 为上一页末个已扫描 sourceId。 */
export type SyncListOptions = {
	readonly limit?: number;
	readonly maxBytes?: number;
	readonly cursor?: string | null;
	readonly maxScan?: number;
};

export type SyncListPage = {
	readonly entries: SyncOutboxEntry[];
	readonly invalid: SyncInvalidFile[];
	/** 翻页游标：本页最后一条的 sourceId；null 表示没有后续。 */
	readonly nextCursor: string | null;
	readonly hasMore: boolean;
	/** 本页实际查过的文件数（含 invalid），用于观察扫描代价。 */
	readonly scanned: number;
};

/** 全队列计数：只读文件名与元信息，不加载正文；readdir 失败必须抛错，不得冒充 0。 */
export type SyncPendingCount = { readonly count: number; readonly bytes: number };

/** 在途批次 envelope：发送前落盘，恢复 unknown 时按原 requestId/原集合查回执或重发。 */
export const OPEN_BATCH_SCHEMA = "pi-deck-cloud-memory-sync-open-batch";
export type SyncOpenBatchMode = "inline" | "chunk";
export type SyncOpenBatchItem = { readonly sourceId: string; readonly contentHash: string; readonly revision: number };
export type SyncOpenBatch = {
	readonly schema: typeof OPEN_BATCH_SCHEMA;
	readonly version: number;
	readonly requestId: string;
	readonly mode: SyncOpenBatchMode;
	readonly createdAt: string;
	readonly items: readonly SyncOpenBatchItem[];
};

/** auth 暂停状态：tokenHash 只存 hash，不存明文 token。 */
export type SyncAuthState = { readonly blocked: boolean; readonly reason: string | null; readonly tokenHash: string | null };

/** 队列句柄：绑定账号 + 云端实例 + 本机 device，切账号不混用同一目录。 */
export type SyncQueue = {
	readonly accountId: string;
	readonly cloudInstanceId: string;
	readonly deviceId: string;
	readonly dir: string;
	register(record: SyncRecord): Promise<SyncRegisterResult>;
	listPending(options?: SyncListOptions): Promise<SyncListPage>;
	/** 待传计数：只读文件名/元信息，不加载正文；readdir 错误向上抛，不冒充 0。 */
	countPending(): Promise<SyncPendingCount>;
	/** 发送前持久化在途批次 envelope；恢复 unknown 时按原 requestId 与原集合处理。 */
	beginBatch(envelope: { requestId: string; mode: SyncOpenBatchMode; items: readonly SyncOpenBatchItem[] }): Promise<void>;
	readOpenBatch(): Promise<SyncOpenBatch | null>;
	/** 只在 requestId 匹配时清除（无参则无条件），避免误清新建批次。 */
	clearOpenBatch(requestId?: string): Promise<boolean>;
	markUnknown(sourceId: string, info?: { reason?: string | null }): Promise<SyncOutboxEntry | null>;
	applyReceipt(sourceId: string, receipt: unknown): Promise<SyncReceiptResult>;
	setAuthBlocked(blocked: boolean, reason?: string | null): Promise<number>;
	isAuthBlocked(): Promise<boolean>;
	markConflict(sourceId: string, reason: string): Promise<SyncOutboxEntry | null>;
	readEntry(sourceId: string): Promise<SyncOutboxEntry | null>;
	readReceipt(sourceId: string): Promise<SyncReceipt | null>;
	/** auth 标志是整体暂停的权威：blocked 只写标志（O(1)）；解除时分页恢复旧 per-entry auth_blocked 状态。 */
	setAuthBlocked(blocked: boolean, reason?: string | null, tokenHash?: string | null): Promise<number>;
	getAuthState(): Promise<SyncAuthState>;
	claimSender(leaseTtlMs?: number): Promise<SyncSenderClaim>;
	renewSender(token: string, leaseTtlMs?: number): Promise<boolean>;
	releaseSender(token: string): Promise<boolean>;
};

export type SyncScopeInput = {
	readonly accountId: string;
	readonly cloudInstanceId: string;
	readonly deviceId: string;
};

export type SyncOutboxOptions = {
	/** 必须是绝对路径；所有读写都限制在该目录内。 */
	readonly stateDir: string;
	readonly now?: () => number;
	/** 进程存活探测的测试接缝；默认用 process.kill(pid, 0)。 */
	readonly isPidAlive?: (pid: number) => boolean;
	readonly processId?: number;
	readonly processStartedAt?: string;
	readonly leaseTtlMs?: number;
	readonly maxEntryBytes?: number;
	/** 租约 token 生成接缝；默认 randomBytes(16).hex。 */
	readonly makeToken?: () => string;
};

export type SyncOutbox = {
	open(scope: SyncScopeInput): Promise<SyncQueue>;
};

/** 队列操作的失败类型；code 可判定（invalid_input / scope_mismatch / existing_corrupt / fs_error）。 */
export class SyncOutboxError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SyncOutboxError";
		this.code = code;
	}
}
