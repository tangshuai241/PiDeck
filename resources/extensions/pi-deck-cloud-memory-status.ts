/**
 * pi-deck-cloud-memory-status —— 采集/人格/档案/同步状态的最小 schema 与原生 RPC 上报。
 *
 * 为什么独立：状态要经 Pi 原生通道（customMessage + display:false + triggerTurn:false）发给宿主，
 * 不能靠 appendEntry 冒充 stdout 推送，也不轮询宿主文件、不依赖 GUI 桥。字段白名单在这里收口，
 * 绝不含 query、原话正文、思考正文或凭据。
 *
 * 与模型上下文的关系：custom_message 会被 Pi 投影进模型上下文（sessionEntryToContextMessages →
 * createCustomMessage），所以这里 content 保持空串、details 只放元信息；扩展侧另有 context
 * 过滤器把本 customType 的控制消息从模型请求里剔除（wrapper 里注册），其它扩展消息不动。
 */

export const STATUS_SCHEMA = "pi-deck-cloud-memory-status";
export const STATUS_VERSION = 1;
export const STATUS_CUSTOM_TYPE = "pi-deck-cloud-memory-status";

/** sender 相位固定枚举（D 的 SyncSenderPhase）；未知值一律归 null，不把自由文本写进状态。 */
export const SYNC_STATES = ["idle", "sending", "retrying", "disabled", "auth_blocked", "scope_mismatch", "owner_blocked", "oversized", "stopped"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export type CloudMemoryStatusKind = "capture" | "persona" | "profile" | "sync";
export type CloudMemoryStatus = {
	readonly schema: typeof STATUS_SCHEMA;
	readonly version: typeof STATUS_VERSION;
	readonly kind: CloudMemoryStatusKind;
	readonly status: string;
	readonly at: string;
	readonly sessionId: string | null;
	readonly account: string | null;
	readonly cloudInstanceId: string | null;
	readonly personaRevision: string | null;
	readonly registered: number | null;
	readonly failed: number | null;
	readonly lineagePartial: boolean;
	readonly needsNewSession: boolean;
	readonly reason: string | null;
	/** sender 相位（固定枚举）；非 sync 状态为 null。 */
	readonly state: SyncState | null;
	readonly deviceId: string | null;
	readonly pendingCount: number | null;
	/** 只有逐字段核对通过的回执才更新时间；未核对恒为 null。 */
	readonly lastReceiptAt: string | null;
};

export type StatusInput = {
	kind: CloudMemoryStatusKind;
	status: string;
	nowIso: string;
	sessionId?: string | null;
	account?: string | null;
	cloudInstanceId?: string | null;
	personaRevision?: string | null;
	registered?: number | null;
	failed?: number | null;
	lineagePartial?: boolean;
	needsNewSession?: boolean;
	reason?: string | null;
	state?: string | null;
	deviceId?: string | null;
	pendingCount?: number | null;
	lastReceiptAt?: string | null;
};

const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown): string | null {
	return typeof value === "string" && SAFE_TOKEN_RE.test(value) ? value : null;
}

function safeId(value: unknown, maxChars = 256): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars && !/[\u0000-\u001f]/.test(value) ? value : null;
}

function safeCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeState(value: unknown): SyncState | null {
	if (typeof value !== "string") return null;
	for (const state of SYNC_STATES) {
		if (state === value) return state;
	}
	return null;
}

/** 构造状态载荷：字段收窄、越界即 null，不把自由文本写进状态。 */
export function buildCloudMemoryStatus(input: StatusInput): CloudMemoryStatus {
	return {
		schema: STATUS_SCHEMA,
		version: STATUS_VERSION,
		kind: input.kind,
		status: safeToken(input.status) ?? "unknown",
		at: safeId(input.nowIso, 64) ?? new Date(0).toISOString(),
		sessionId: safeId(input.sessionId ?? null),
		account: safeId(input.account ?? null, 128),
		cloudInstanceId: safeId(input.cloudInstanceId ?? null, 128),
		personaRevision: safeId(input.personaRevision ?? null, 64),
		registered: safeCount(input.registered ?? null),
		failed: safeCount(input.failed ?? null),
		lineagePartial: input.lineagePartial === true,
		needsNewSession: input.needsNewSession === true,
		reason: safeToken(input.reason ?? null),
		state: safeState(input.state ?? null),
		deviceId: safeId(input.deviceId ?? null, 128),
		pendingCount: safeCount(input.pendingCount ?? null),
		lastReceiptAt: safeId(input.lastReceiptAt ?? null, 64),
	};
}

/**
 * 消息内容：保持空串。控制消息只服务宿主（details 里的结构化元信息），
 * 既不给模型当提示，也不在产品回答里暴露内部状态码。
 */
export function statusContent(_status: CloudMemoryStatus): string {
	return "";
}

export type StatusSender = {
	sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) => void;
};

/**
 * 经 Pi 原生通道发状态：display:false、triggerTurn:false（不触发模型回答，也不排队成下一轮）。
 * pi 1.1.0 的 sendMessage 只有 steer/followUp/nextTurn，没有 immediate；triggerTurn:false 时
 * streaming 中的消息会在回合末落为 custom_message（不进回答），空闲时立即落盘。
 * 发送失败只表现为状态缺席，绝不影响会话。
 */
export function sendCloudMemoryStatus(sender: StatusSender, status: CloudMemoryStatus): boolean {
	try {
		sender.sendMessage({ customType: STATUS_CUSTOM_TYPE, content: statusContent(status), display: false, details: status }, { triggerTurn: false });
		return true;
	} catch {
		return false;
	}
}

/** 模型上下文过滤器：只剔除本扩展的状态控制消息，其它 custom/工具结果原样保留。 */
export function isStatusControlMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === STATUS_CUSTOM_TYPE;
}
