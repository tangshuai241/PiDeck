/**
 * 云端记忆原生 RPC 状态投影（纯策略）。
 *
 * 数据来源：Pi 扩展 `pi-deck-cloud-memory-status` 经原生通道发的 custom message
 * （`display:false`、`triggerTurn:false`），宿主在既有 message_end 事件里读 `details`。
 * 本模块只做四件事：载荷收窄、运行时绑定校验（拒旧 generation / 跨会话 / 跨账号）、
 * 按 agent+kind 分槽保存、按账号作用域聚合。
 *
 * 为什么按 agent+kind 分槽（而不是每 agent 只留一条）：
 * sync / capture / persona 是三类独立事实，互相覆盖会让「队列快照」被后到的人格状态抹掉；
 * 同 kind 内才做替换，且以单调序号判新旧（queue 从 5 归零必须显示 0，不能拿旧会话的 max 冒充积压）。
 *
 * 边界：
 * - 不读队列文件、不读扩展日志、不走 GUI 桥、不轮询：状态只能来自原生消息；
 * - 不把自由文本写进摘要（reason 只透传固定 token 形态，界面按 code 走 i18n）；
 * - 无新鲜状态一律返回 null（未知 != 0），任一分组未知则总数保持未知（不得部分求和）。
 */

export const NATIVE_STATUS_SCHEMA = "pi-deck-cloud-memory-status";
/** custom message 类型（与 resources/extensions/pi-deck-cloud-memory-status.ts 的 STATUS_CUSTOM_TYPE 一致）。 */
export const NATIVE_STATUS_CUSTOM_TYPE = "pi-deck-cloud-memory-status";
export const NATIVE_STATUS_VERSION = 1;
/** 新鲜窗口：超过该时间没有新状态即视为未知（不拿旧回执当实时）。 */
export const NATIVE_STATUS_FRESH_MS = 10 * 60 * 1000;

/** 状态消息类型：capture/persona/profile 已冻结；sync 由同步线补齐。 */
export type NativeStatusKind = "capture" | "persona" | "profile" | "sync";

/**
 * sender 相位固定枚举（与 resources/extensions/pi-deck-cloud-memory-status.ts 的 SYNC_STATES 一致，
 * 由 tests/cloudMemoryIpcContract.test.mjs 守护）；非 sync 状态为 null，未知值一律落 null。
 */
export const NATIVE_SYNC_STATES = ["idle", "sending", "retrying", "disabled", "auth_blocked", "scope_mismatch", "owner_blocked", "oversized", "stopped"] as const;
export type NativeSyncState = (typeof NATIVE_SYNC_STATES)[number];

export type NativeStatus = {
	kind: NativeStatusKind;
	status: string;
	at: string;
	sessionId: string | null;
	account: string | null;
	cloudInstanceId: string | null;
	personaRevision: string | null;
	registered: number | null;
	failed: number | null;
	lineagePartial: boolean;
	needsNewSession: boolean;
	reason: string | null;
	/** 同步线字段（未到货时为 null，不猜测）：设备标识、待传计数与回执。 */
	deviceId: string | null;
	pendingCount: number | null;
	lastReceiptAt: string | null;
	/** sender 相位（仅 sync 状态有值）。 */
	state: NativeSyncState | null;
};

export type RuntimeBinding = {
	agentId: string;
	/** pi 原生 session id（扩展 ctx.sessionManager.getSessionId() 报的就是它）。 */
	sessionId: string;
	/** 稳定的 SessionRecord.id（扩展若报这个也属于同一 runtime，一并接受）。 */
	deckSessionId?: string;
	runtimeGeneration: number;
};

export type StatusScope = {
	account: string | null;
	cloudInstanceId: string | null;
};

type StatusSlot = {
	binding: RuntimeBinding;
	status: NativeStatus;
	receivedAt: number;
	/** 单调序号：同设备多会话比较新旧用（receivedAt 同毫秒也不歧义）。 */
	seq: number;
};

export type NativeStatusSummary = {
	/** 参与聚合的会话数（诊断用；不等于计数求和口径）。 */
	sessions: number;
	lastReceiptAt: string | null;
	personaRevision: string | null;
	registered: number | null;
	failed: number | null;
	lineagePartial: boolean;
	needsNewSession: boolean;
	/** 每个设备取最新 sync 快照后相加；未知设备按会话独立计；任一分组未知则 null。 */
	pendingCount: number | null;
	/** 去重后的 kind:status 集合（界面按 code 映射 i18n，不直接显示原始串）。 */
	statuses: readonly string[];
	/** 去重后的 sender 相位集合（暂停/受阻由界面按固定枚举映射 i18n）。 */
	syncStates: readonly string[];
};

function readObject(value: unknown): object | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function readToken(value: unknown, maxChars = 64): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
	return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}

function readId(value: unknown, maxChars = 256): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
	return /[\u0000-\u001f]/.test(value) ? null : value;
}

function readCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readIso(value: unknown): string | null {
	const raw = readId(value, 64);
	return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

function readKind(value: unknown): NativeStatusKind | null {
	return value === "capture" || value === "persona" || value === "profile" || value === "sync" ? value : null;
}

function readSyncState(value: unknown): NativeSyncState | null {
	return (NATIVE_SYNC_STATES as readonly unknown[]).includes(value) ? (value as NativeSyncState) : null;
}

/** 载荷收窄：schema/version/kind 不符即 null；其余字段越界落 null，绝不抛。 */
export function parseNativeStatus(payload: unknown): NativeStatus | null {
	const record = readObject(payload);
	if (!record) return null;
	if (Reflect.get(record, "schema") !== NATIVE_STATUS_SCHEMA) return null;
	if (Reflect.get(record, "version") !== NATIVE_STATUS_VERSION) return null;
	const kind = readKind(Reflect.get(record, "kind"));
	if (!kind) return null;
	return {
		kind,
		status: readToken(Reflect.get(record, "status")) ?? "unknown",
		at: readIso(Reflect.get(record, "at")) ?? new Date(0).toISOString(),
		sessionId: readId(Reflect.get(record, "sessionId")),
		account: readId(Reflect.get(record, "account"), 128),
		cloudInstanceId: readId(Reflect.get(record, "cloudInstanceId"), 128),
		personaRevision: readId(Reflect.get(record, "personaRevision"), 64),
		registered: readCount(Reflect.get(record, "registered")),
		failed: readCount(Reflect.get(record, "failed")),
		lineagePartial: Reflect.get(record, "lineagePartial") === true,
		needsNewSession: Reflect.get(record, "needsNewSession") === true,
		reason: readToken(Reflect.get(record, "reason")),
		deviceId: readId(Reflect.get(record, "deviceId"), 128),
		pendingCount: readCount(Reflect.get(record, "pendingCount")),
		lastReceiptAt: readIso(Reflect.get(record, "lastReceiptAt")),
		state: readSyncState(Reflect.get(record, "state")),
	};
}

function sameScope(status: NativeStatus, scope: StatusScope): boolean {
	if (!scope.account || !scope.cloudInstanceId) return false;
	return status.account === scope.account && status.cloudInstanceId === scope.cloudInstanceId;
}

/**
 * 运行时状态投影：每个 agent 按 kind 分槽保留最新；旧 generation、跨会话、跨账号一律拒绝。
 * 进程 stop/replace 时宿主按 agentId 整槽移除。
 */
export class CloudMemoryStatusProjection {
	/** agentId → (kind → slot)：不同 kind 互不覆盖。 */
	private readonly slots = new Map<string, Map<NativeStatusKind, StatusSlot>>();
	private seq = 0;

	/** 接受一条状态；返回是否被采纳（拒绝不报错，只是状态保持原样）。 */
	accept(binding: RuntimeBinding, payload: unknown, scope: StatusScope): boolean {
		const status = parseNativeStatus(payload);
		if (!status) return false;
		// 会话身份自证：报 pi id 或 deck id 都行，报别的（跨会话）一律拒
		if (status.sessionId && status.sessionId !== binding.sessionId && status.sessionId !== binding.deckSessionId) return false;
		if (!sameScope(status, scope)) return false;
		const byKind = this.slots.get(binding.agentId);
		// 同 agentId 复用为新一代 runtime 时，旧 generation 的迟到消息不得回写
		const highestGeneration = byKind ? Math.max(...[...byKind.values()].map((slot) => slot.binding.runtimeGeneration)) : -1;
		if (binding.runtimeGeneration < highestGeneration) return false;
		if (binding.runtimeGeneration === highestGeneration && byKind) {
			const sameGenerationSession = [...byKind.values()].every((slot) => slot.binding.sessionId === binding.sessionId && (slot.binding.deckSessionId ?? "") === (binding.deckSessionId ?? ""));
			if (!sameGenerationSession) return false;
		}
		const next = byKind ?? new Map<NativeStatusKind, StatusSlot>();
		next.set(status.kind, { binding, status, receivedAt: Date.now(), seq: (this.seq += 1) });
		this.slots.set(binding.agentId, next);
		return true;
	}

	/** 进程停止/被替换时移除该 agent 的全部槽位（没有新鲜状态就是未知，不留旧计数）。 */
	remove(agentId: string): void {
		this.slots.delete(agentId);
	}

	/** 换账号/换实例/登出：清掉全部状态（旧账号的计数不能留给新账号）。 */
	clear(): void {
		this.slots.clear();
	}

	/** 绑定校验用：当前 agent 某一 kind 的槽位（诊断/测试）。 */
	entry(agentId: string, kind: NativeStatusKind): StatusSlot | null {
		return this.slots.get(agentId)?.get(kind) ?? null;
	}

	/**
	 * 按账号作用域聚合。没有新鲜状态（窗口外的旧消息）返回 null —— 未知不显示成 0。
	 * 待传计数：同一设备取**最新** sync 快照（不是 max，避免队列归零后仍报旧积压），
	 * 不同设备相加；未知设备按会话独立计；任一分组未知则总数未知。
	 */
	snapshot(scope: StatusScope, nowMs: number, freshnessMs = NATIVE_STATUS_FRESH_MS): NativeStatusSummary | null {
		const fresh: StatusSlot[] = [];
		for (const byKind of this.slots.values()) {
			for (const slot of byKind.values()) {
				if (nowMs - slot.receivedAt <= freshnessMs && sameScope(slot.status, scope)) fresh.push(slot);
			}
		}
		if (fresh.length === 0) return null;
		// 每个设备（或没有 deviceId 的会话）只留最新一条 sync 快照
		const latestSyncByGroup = new Map<string, StatusSlot>();
		for (const slot of fresh) {
			if (slot.status.kind !== "sync") continue;
			const group = slot.status.deviceId ? `device:${slot.status.deviceId}` : `session:${slot.binding.agentId}`;
			const previous = latestSyncByGroup.get(group);
			if (!previous || slot.seq > previous.seq) latestSyncByGroup.set(group, slot);
		}
		let pendingKnown = latestSyncByGroup.size > 0;
		let pendingTotal = 0;
		for (const slot of latestSyncByGroup.values()) {
			if (slot.status.pendingCount === null) {
				pendingKnown = false;
				continue;
			}
			pendingTotal += slot.status.pendingCount;
		}

		let registered: number | null = null;
		let failed: number | null = null;
		let lastReceiptAt: string | null = null;
		let needsNewSession = false;
		let lineagePartial = false;
		const statuses = new Set<string>();
		const syncStates = new Set<string>();
		const sessions = new Set<string>();
		let personaRevision: string | null = null;
		let personaSeq = -1;
		for (const slot of fresh) {
			const status = slot.status;
			sessions.add(slot.binding.agentId);
			statuses.add(`${status.kind}:${status.status}`);
			registered = sumNullable(registered, status.registered);
			failed = sumNullable(failed, status.failed);
			needsNewSession ||= status.needsNewSession;
			lineagePartial ||= status.lineagePartial;
			lastReceiptAt = latestIso(lastReceiptAt, status.lastReceiptAt);
			if (status.personaRevision && slot.seq > personaSeq) {
				// 多槽都报过人格版本时取最新序号的那条（不按遍历顺序碰运气）
				personaRevision = status.personaRevision;
				personaSeq = slot.seq;
			}
		}
		// 相位是队列/设备的属性：只取每个分组最新的 sync 快照，避免旧会话的 sending 长期残留
		for (const slot of latestSyncByGroup.values()) {
			if (slot.status.state) syncStates.add(slot.status.state);
		}
		return {
			sessions: sessions.size,
			lastReceiptAt,
			personaRevision,
			registered,
			failed,
			lineagePartial,
			needsNewSession,
			pendingCount: pendingKnown ? pendingTotal : null,
			statuses: [...statuses].sort(),
			syncStates: [...syncStates].sort(),
		};
	}
}

function sumNullable(current: number | null, next: number | null): number | null {
	if (next === null) return current;
	return (current ?? 0) + next;
}

function latestIso(current: string | null, next: string | null): string | null {
	if (!next) return current;
	if (!current) return next;
	return Date.parse(next) > Date.parse(current) ? next : current;
}
