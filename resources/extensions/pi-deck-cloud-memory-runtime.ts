/**
 * pi-deck-cloud-memory-runtime —— profile / 人格 / 采集 / sender 的单一运行时域。
 *
 * 关键不变量（最终审阅修正后）：
 * - 连接快照**每次调用现读**（profileLoader + 合法绑定）；失败返回 null 让 sender 暂停，
 *   sender 慢 HTTP 前会再读一次（D 的 sender 在租约后复核 account/instance/enabled）。
 *   `readConnection` 只读文件，绝不调用 sender.ensure/stop（避免递归/死锁）。
 * - 一个 Pi session 的首次有效 profile 锁定 account/instance/baseUrl/stateDir：之后同 session
 *   换账号只报 needs_new_session 并停止该 session 的新人格应用、工具访问与采集（本地工作保留）；
 *   同 owner 的 token 刷新/sync 开关可更新，token 不进身份。
 * - sync 状态用独立的 sender owner+session（turn 在 session_start 时还没有、agent_settled 后又清空）。
 * - 状态去重只按内容变化；运行中的 sender 由 sender-host 低频心跳保持 freshness，停止即清 timer。
 */

import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCaptureView, createCaptureController, createDefaultCaptureFsPort, ensureDeviceId, type CaptureCompletion, type CaptureController, type CaptureFsPort, type CaptureTextBlock, type CaptureView, type CaptureViews } from "./pi-deck-cloud-memory-capture";
import { buildPersonaAppend, parsePersonaCache } from "./pi-deck-cloud-memory-persona";
import { buildCloudMemoryStatus, type CloudMemoryStatus, type CloudMemoryStatusKind } from "./pi-deck-cloud-memory-status";
import { captureGate, createRuntimeProfileLoader, deviceFile, MAX_PERSONA_READ_BYTES, type ProfileLoadResult, type ReadTextPort, type RuntimeProfile } from "./pi-deck-cloud-memory-runtime-config";
import { createCaptureRegistrar, type CaptureRegistrar, type CaptureScope } from "./pi-deck-cloud-memory-sync-bridge";
import type { createSyncSender, SyncConnectionSnapshot, SyncSenderStatus } from "./pi-deck-cloud-memory-sync-sender";
import { createSenderHost, type SenderTimerPort } from "./pi-deck-cloud-memory-sync-sender-host";
import { normalizeSyncTextBlocks } from "./pi-deck-cloud-memory-sync-identity";
import type { SyncScopeInput } from "./pi-deck-cloud-memory-sync-types";

/** 采集回合 owner：account/instance/device 在回合开始时固定，旧回合不写新档案。 */
export type CaptureOwner = {
	key: string;
	accountId: string;
	cloudInstanceId: string;
	deviceId: string;
	stateDir: string;
	sessionId: string;
	project: string | null;
};

export type TurnRuntime = {
	profileKey: string | null;
	logFile: string | null;
	sessionId: string | null;
	personaRevision: string | null;
	captureReason: string | null;
	captureOwner: CaptureOwner | null;
	startLeafId: string | null;
	/** 本回合因同一 session 换档案而封禁：不应用人格、不查记忆、不采集，只报 needs_new_session。 */
	blocked: boolean;
	blockReason: string | null;
};

export type CapturePhase = "turn_end" | "settled" | "session_start" | "shutdown";

export type CloudMemoryStatusInput = {
	kind: CloudMemoryStatusKind;
	status: string;
	reason?: string | null;
	sessionId?: string | null;
	owner?: CaptureOwner | null;
	account?: string | null;
	cloudInstanceId?: string | null;
	personaRevision?: string | null;
	registered?: number | null;
	failed?: number | null;
	lineagePartial?: boolean;
	needsNewSession?: boolean;
	state?: string | null;
	deviceId?: string | null;
	pendingCount?: number | null;
	lastReceiptAt?: string | null;
	onceKey?: string | null;
};

export type RuntimePorts = {
	homedir: string;
	env: Record<string, string | undefined>;
	readText: ReadTextPort;
	sendStatus: (status: CloudMemoryStatus) => void;
	fsPort?: CaptureFsPort;
	nowIso?: () => string;
	createSender?: typeof createSyncSender;
	/** sender 状态心跳间隔（保持 freshness）；停止时清 timer。 */
	syncHeartbeatMs?: number;
	timerPort?: SenderTimerPort;
};

export type CloudMemoryRuntime = {
	readProfile(): Promise<ProfileLoadResult | null>;
	profileKeyOf(profile: RuntimeProfile): string;
	beginTurn(ctx: ExtensionContext, event: { systemPromptOptions: { appendSystemPrompt?: string } }): Promise<TurnRuntime>;
	currentTurn(): TurnRuntime | null;
	turnBlocked(): boolean;
	clearTurn(): void;
	reconcile(ctx: ExtensionContext, phase: CapturePhase): Promise<void>;
	flushCapture(): Promise<void>;
	stopSender(reason: string): Promise<void>;
	syncStatus(): SyncSenderStatus | null;
	emitStatus(input: CloudMemoryStatusInput): void;
};

const MAX_STATUS_KEYS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLeafId(ctx: ExtensionContext): string | null {
	try {
		const value = ctx.sessionManager.getLeafId();
		return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
	} catch {
		return null;
	}
}

function readSessionId(ctx: ExtensionContext): string | null {
	try {
		const value = ctx.sessionManager.getSessionId();
		return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
	} catch {
		return null;
	}
}

/** 项目标签只用于资料分组：取会话 cwd 的末段，缺失即 null。 */
function readProjectLabel(ctx: ExtensionContext): string | null {
	try {
		const cwd = ctx.sessionManager.getCwd();
		if (typeof cwd !== "string" || cwd.length === 0) return null;
		const label = basename(cwd).trim();
		if (label.length === 0 || label.length > 64 || /[\u0000-\u001f]/.test(label)) return null;
		return label;
	} catch {
		return null;
	}
}

export function createCloudMemoryRuntime(ports: RuntimePorts): CloudMemoryRuntime {
	const nowIso = ports.nowIso ?? (() => new Date().toISOString());
	const fsPort = ports.fsPort ?? createDefaultCaptureFsPort();
	const profileLoader = createRuntimeProfileLoader({ input: { homedir: ports.homedir, env: ports.env }, readText: ports.readText });
	const registrar: CaptureRegistrar = createCaptureRegistrar();
	const statusKeys = new Set<string>();
	let turn: TurnRuntime | null = null;
	let binding: { sessionId: string; ownerKey: string; controller: CaptureController } | null = null;
	/** 本 Pi session 首次有效 profile 锁定的 owner（token/sync 不进这里）。 */
	let sessionLock: { sessionId: string; key: string; accountId: string; cloudInstanceId: string } | null = null;
	/** sender 自己的 owner+session（不借用 turn）。 */
	let senderSession: { accountId: string; cloudInstanceId: string; deviceId: string; sessionId: string } | null = null;
	const deviceByStateDir = new Map<string, string>();

	function profileKeyOf(profile: RuntimeProfile): string {
		return `${profile.configFile}|${profile.config.baseUrl}|${profile.stateDir}|${profile.config.account ?? ""}|${profile.config.cloudInstanceId ?? ""}`;
	}

	/** session owner 锁的 key：账号/实例/地址/状态目录；token 与 sync 开关不算 owner 变化。 */
	function ownerLockKey(profile: RuntimeProfile): string {
		return `${profile.config.account ?? ""}|${profile.config.cloudInstanceId ?? ""}|${profile.config.baseUrl}|${profile.stateDir}`;
	}

	function emitStatus(input: CloudMemoryStatusInput): void {
		const key = input.onceKey ? `${input.kind}:${input.onceKey}` : null;
		if (key) {
			if (statusKeys.has(key)) return;
			if (statusKeys.size > MAX_STATUS_KEYS) statusKeys.clear();
			statusKeys.add(key);
		}
		ports.sendStatus(
			buildCloudMemoryStatus({
				kind: input.kind,
				status: input.status,
				nowIso: nowIso(),
				sessionId: input.sessionId ?? null,
				account: input.owner?.accountId ?? input.account ?? null,
				cloudInstanceId: input.owner?.cloudInstanceId ?? input.cloudInstanceId ?? null,
				personaRevision: input.personaRevision ?? null,
				registered: input.registered ?? null,
				failed: input.failed ?? null,
				lineagePartial: input.lineagePartial === true,
				needsNewSession: input.needsNewSession === true,
				reason: input.reason ?? null,
				state: input.state ?? null,
				deviceId: input.deviceId ?? null,
				pendingCount: input.pendingCount ?? null,
				lastReceiptAt: input.lastReceiptAt ?? null,
			}),
		);
	}

	async function loadProfileOnce(): Promise<ProfileLoadResult | null> {
		try {
			return await profileLoader.load();
		} catch {
			return null;
		}
	}

	async function readProfile(): Promise<ProfileLoadResult | null> {
		return await loadProfileOnce();
	}

	/** 连接快照：每次现读 profile（含 auth↔config 绑定核对）；失败 null → sender 暂停。 */
	async function readConnectionSnapshot(): Promise<SyncConnectionSnapshot | null> {
		const loaded = await loadProfileOnce();
		if (!loaded || loaded.kind !== "ok") return null;
		const profile = loaded.profile;
		return {
			enabled: profile.config.enabled,
			syncEnabled: profile.config.syncEnabled,
			baseUrl: profile.config.baseUrl,
			token: profile.token,
			accountId: profile.config.account,
			cloudInstanceId: profile.config.cloudInstanceId,
		};
	}

	// -------------------------------------------------------------------------
	// sender：状态用独立 sender owner/session；心跳保持 freshness；start/stop 严格配对
	// -------------------------------------------------------------------------

	const senderHost = createSenderHost({
		queueFor: (scope) => registrar.queue(scope),
		readConnection: () => readConnectionSnapshot(),
		onStatus: (status, meta) => emitSyncStatus(status, meta.heartbeat),
		createSender: ports.createSender,
		heartbeatMs: ports.syncHeartbeatMs,
		timerPort: ports.timerPort,
	});

	let lastSyncKey = "";

	/** 仅内容变化去重；心跳消息（低频）始终上报以保持 freshness。 */
	function emitSyncStatus(status: SyncSenderStatus, heartbeat: boolean): void {
		const key = `${status.phase}|${status.pendingTotal}|${status.conflictCount}|${status.lastReceiptAt ?? ""}`;
		if (!heartbeat) {
			if (key === lastSyncKey) return;
			lastSyncKey = key;
		}
		emitStatus({
			kind: "sync",
			status: status.running ? status.phase : "stopped",
			state: status.phase,
			reason: status.lastError,
			deviceId: status.deviceId,
			pendingCount: status.pendingTotal,
			lastReceiptAt: status.lastReceiptAt,
			sessionId: senderSession?.sessionId ?? null,
			account: senderSession?.accountId ?? null,
			cloudInstanceId: senderSession?.cloudInstanceId ?? null,
		});
	}

	async function ensureSender(owner: CaptureOwner, profile: RuntimeProfile): Promise<void> {
		const result = await senderHost.ensure({
			key: `${profileKeyOf(profile)}|${owner.deviceId}`,
			scope: { accountId: owner.accountId, cloudInstanceId: owner.cloudInstanceId, deviceId: owner.deviceId },
			queueScope: { accountId: owner.accountId, cloudInstanceId: owner.cloudInstanceId, deviceId: owner.deviceId, stateDir: owner.stateDir, sessionId: owner.sessionId },
		});
		if (result === "failed") {
			emitStatus({ kind: "sync", status: "error", reason: "sender_start_failed", sessionId: owner.sessionId, owner });
			return;
		}
		senderSession = { accountId: owner.accountId, cloudInstanceId: owner.cloudInstanceId, deviceId: owner.deviceId, sessionId: owner.sessionId };
		if (result === "started") emitStatus({ kind: "sync", status: "started", state: "idle", deviceId: owner.deviceId, sessionId: owner.sessionId, owner, onceKey: `sync_started:${owner.sessionId}` });
	}

	async function stopSender(reason: string): Promise<void> {
		const stopped = await senderHost.stop(reason);
		const previous = senderSession;
		senderSession = null;
		if (stopped) emitStatus({ kind: "sync", status: "stopped", state: "stopped", reason, sessionId: previous?.sessionId ?? null, account: previous?.accountId ?? null, cloudInstanceId: previous?.cloudInstanceId ?? null, onceKey: `sync_stopped:${reason}` });
	}

	function wakeSender(): void {
		senderHost.wake();
	}

	// -------------------------------------------------------------------------
	// 采集 owner / 控制器 / 视图
	// -------------------------------------------------------------------------

	async function resolveCaptureOwner(profile: RuntimeProfile, gate: { accountId: string; cloudInstanceId: string; stateDir: string }, sessionId: string, project: string | null): Promise<{ kind: "ok"; owner: CaptureOwner } | { kind: "unavailable"; reason: string }> {
		let deviceId = deviceByStateDir.get(gate.stateDir) ?? null;
		if (!deviceId) {
			const device = await ensureDeviceId({ file: deviceFile(gate.stateDir), fsPort });
			if (device.kind !== "ok") return { kind: "unavailable", reason: device.reason };
			deviceId = device.deviceId;
			deviceByStateDir.set(gate.stateDir, deviceId);
		}
		return { kind: "ok", owner: { key: profileKeyOf(profile), accountId: gate.accountId, cloudInstanceId: gate.cloudInstanceId, deviceId, stateDir: gate.stateDir, sessionId, project } };
	}

	function ensureBinding(sessionId: string, owner: CaptureOwner): CaptureController {
		if (binding && binding.sessionId === sessionId && binding.ownerKey === owner.key) return binding.controller;
		const controller = createCaptureController({
			scope: { accountId: owner.accountId, cloudInstanceId: owner.cloudInstanceId, deviceId: owner.deviceId, stateDir: owner.stateDir },
			sessionId,
			register: (action) => registrar.register({ accountId: owner.accountId, cloudInstanceId: owner.cloudInstanceId, deviceId: owner.deviceId, stateDir: owner.stateDir, sessionId }, action),
			fsPort,
		});
		binding = { sessionId, ownerKey: owner.key, controller };
		return controller;
	}

	/**
	 * 只用 Pi public 读数（getLeafId/getBranch/buildSessionProjection/getEntries）；不写原生会话文件。
	 * getBranch() 内部 reverse 后返回 root → leaf：必须按原顺序遍历，否则基线之后的新条目会被漏采。
	 * changedAt 取该条目最新的 context_edit 原生时间戳（没有才退回条目时间戳），保证事件时间稳定。
	 */
	function buildViews(ctx: ExtensionContext, project: string | null): CaptureViews {
		const branch = ctx.sessionManager.getBranch();
		const projected = new Map<string, readonly { role?: unknown; content?: unknown }[]>();
		for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
			projected.set(entry.sourceEntry.id, entry.messages);
		}
		const edits = new Map<string, string>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "context_edit") continue;
			if (typeof entry.timestamp === "string" && entry.timestamp.length <= 64) edits.set(entry.targetId, entry.timestamp);
		}
		const views: CaptureView[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const role = message.role;
			if (role !== "user" && role !== "assistant") continue;
			const projectedMessages = projected.get(entry.id);
			let visible: boolean | null = projectedMessages === undefined ? null : projectedMessages.length > 0;
			let textBlocks: CaptureTextBlock[] = [];
			if (visible === true) {
				const first = projectedMessages?.[0];
				if (!first || first.role !== role) {
					visible = null; // 投影角色不符：按未知处理，不猜内容也不误报隐藏
				} else {
					textBlocks = normalizeSyncTextBlocks(first.content);
				}
			}
			const aborted = role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
			const completion: CaptureCompletion = aborted ? "incomplete" : "completed";
			const occurredAt = typeof entry.timestamp === "string" && entry.timestamp.length <= 64 ? entry.timestamp : nowIso();
			views.push(
				buildCaptureView({
					entryId: entry.id,
					parentEntryId: entry.parentId ?? null,
					role,
					textBlocks,
					occurredAt,
					changedAt: edits.get(entry.id) ?? occurredAt,
					completion,
					visible,
					project,
				}),
			);
		}
		return { views, leafId: readLeafId(ctx) };
	}

	// -------------------------------------------------------------------------
	// 用户回合：session 首次 profile 锁定；人格每回合固定；采集 owner 固定
	// -------------------------------------------------------------------------

	async function beginTurn(ctx: ExtensionContext, event: { systemPromptOptions: { appendSystemPrompt?: string } }): Promise<TurnRuntime> {
		const state: TurnRuntime = {
			profileKey: null,
			logFile: null,
			sessionId: readSessionId(ctx),
			personaRevision: null,
			captureReason: null,
			captureOwner: null,
			startLeafId: readLeafId(ctx),
			blocked: false,
			blockReason: null,
		};
		turn = state;

		const loaded = await readProfile();
		if (!loaded || loaded.kind !== "ok") {
			if (loaded) state.captureReason = loaded.kind === "missing" ? "config_missing" : loaded.reason;
			return state;
		}
		const profile = loaded.profile;
		state.profileKey = profileKeyOf(profile);
		state.logFile = profile.config.logFile;

		// 同一 Pi session 首次有效 profile 锁定 owner；之后换账号只报 needs_new_session，
		// 不再悄悄换账号（人格/工具/采集一起封禁，本地工作保留）。
		const lockKey = ownerLockKey(profile);
		if (!sessionLock || sessionLock.sessionId !== state.sessionId) {
			sessionLock = state.sessionId ? { sessionId: state.sessionId, key: lockKey, accountId: profile.config.account ?? "", cloudInstanceId: profile.config.cloudInstanceId ?? "" } : null;
		} else if (sessionLock.key !== lockKey) {
			state.blocked = true;
			state.blockReason = "profile_changed_needs_new_session";
			state.profileKey = sessionLock.key;
			emitStatus({ kind: "profile", status: "changed", reason: "session_owner_locked", sessionId: state.sessionId, account: sessionLock.accountId, cloudInstanceId: sessionLock.cloudInstanceId, needsNewSession: true });
			return state;
		}

		// 人格：每用户回合只读一次缓存，按 revision/raw_revision 校验后追加短稿（不替换系统提示）。
		if (profile.config.enabled === true) {
			const read = await fsPort.readText(profile.personaCacheFile, MAX_PERSONA_READ_BYTES);
			if (read.kind === "ok") {
				let raw: unknown = null;
				try {
					raw = JSON.parse(read.text);
				} catch {
					raw = null;
				}
				const parsed = parsePersonaCache(raw, { account: profile.config.account, cloudInstanceId: profile.config.cloudInstanceId });
				if (parsed.kind === "ok") {
					const append = buildPersonaAppend(parsed.persona);
					if (append) {
						const existing = event.systemPromptOptions.appendSystemPrompt ?? "";
						event.systemPromptOptions.appendSystemPrompt = existing ? `${existing}\n\n${append.text}` : append.text;
						state.personaRevision = parsed.persona.revision;
						emitStatus({ kind: "persona", status: append.truncated ? "applied_truncated" : "applied", personaRevision: parsed.persona.revision, sessionId: state.sessionId, account: profile.config.account, cloudInstanceId: profile.config.cloudInstanceId, onceKey: `persona:${parsed.persona.revision}` });
					} else {
						emitStatus({ kind: "persona", status: "default_rules", reason: "persona_empty", sessionId: state.sessionId, account: profile.config.account, cloudInstanceId: profile.config.cloudInstanceId, onceKey: `${state.sessionId}:persona_empty` });
					}
				} else {
					emitStatus({ kind: "persona", status: parsed.kind === "disabled" ? "disabled" : "default_rules", reason: parsed.reason, sessionId: state.sessionId, account: profile.config.account, cloudInstanceId: profile.config.cloudInstanceId, onceKey: `${state.sessionId}:${parsed.reason}` });
				}
			} else {
				emitStatus({ kind: "persona", status: "default_rules", reason: read.kind === "missing" ? "cache_missing" : read.reason, sessionId: state.sessionId, account: profile.config.account, cloudInstanceId: profile.config.cloudInstanceId, onceKey: `${state.sessionId}:${read.kind === "missing" ? "cache_missing" : read.reason}` });
			}
		}

		// 采集 owner：门禁通过才解析设备 id（默认关闭时不读任何采集文件）。
		const gate = captureGate(profile);
		if (gate.kind !== "ok") {
			state.captureReason = gate.reason;
			emitStatus({ kind: "capture", status: "unavailable", reason: gate.reason, sessionId: state.sessionId, onceKey: `${state.sessionId}:${gate.reason}` });
			await stopSender("sync_disabled");
			return state;
		}
		if (!state.sessionId) {
			state.captureReason = "session_id_missing";
			return state;
		}
		const resolved = await resolveCaptureOwner(profile, gate, state.sessionId, readProjectLabel(ctx));
		if (resolved.kind !== "ok") {
			state.captureReason = resolved.reason;
			emitStatus({ kind: "capture", status: "unavailable", reason: resolved.reason, sessionId: state.sessionId, onceKey: `${state.sessionId}:${resolved.reason}` });
			return state;
		}
		state.captureOwner = resolved.owner;
		return state;
	}

	async function reconcile(ctx: ExtensionContext, phase: CapturePhase): Promise<void> {
		const sessionId = readSessionId(ctx);
		if (!sessionId) return;
		// 回合被 owner 锁封禁（同 session 换账号）：不采集、不发送，只保留本地工作与状态。
		if (turn?.blocked) {
			await stopSender("profile_changed");
			return;
		}
		let owner = turn?.captureOwner ?? null;
		let profile: RuntimeProfile | null = null;
		if (owner) {
			const loaded = await readProfile();
			if (!loaded || loaded.kind !== "ok" || profileKeyOf(loaded.profile) !== owner.key) {
				emitStatus({ kind: "profile", status: "changed", reason: "profile_changed_mid_turn", sessionId, owner, needsNewSession: true });
				if (turn) {
					turn.captureReason = "profile_changed_mid_turn";
					turn = { ...turn, captureOwner: null };
				}
				await stopSender("profile_changed");
				return;
			}
			profile = loaded.profile;
		} else {
			const loaded = await readProfile();
			if (!loaded || loaded.kind !== "ok") {
				if (loaded) {
					emitStatus({ kind: "capture", status: loaded.kind === "missing" ? "unconfigured" : loaded.kind === "disabled" ? "disabled" : "config_invalid", reason: loaded.kind === "missing" ? "config_missing" : loaded.reason, sessionId, onceKey: `${sessionId}:${loaded.kind === "missing" ? "config_missing" : loaded.reason}` });
				}
				await stopSender(loaded && loaded.kind === "disabled" ? "sync_disabled" : "config_unavailable");
				return;
			}
			const gate = captureGate(loaded.profile);
			if (gate.kind !== "ok") {
				emitStatus({ kind: "capture", status: "unavailable", reason: gate.reason, sessionId, onceKey: `${sessionId}:${gate.reason}` });
				if (gate.reason === "sync_disabled") await stopSender("sync_disabled");
				return;
			}
			const resolved = await resolveCaptureOwner(loaded.profile, gate, sessionId, readProjectLabel(ctx));
			if (resolved.kind !== "ok") {
				emitStatus({ kind: "capture", status: "unavailable", reason: resolved.reason, sessionId, onceKey: `${sessionId}:${resolved.reason}` });
				return;
			}
			owner = resolved.owner;
			profile = loaded.profile;
		}

		const controller = ensureBinding(sessionId, owner);
		try {
			// 新基线用「回合起点叶」：中途开启采集时只把更早的当历史，不回补，也不吞掉本回合内容。
			const currentLeaf = readLeafId(ctx);
			const baselineLeaf = phase === "session_start" ? currentLeaf : (turn?.startLeafId ?? currentLeaf);
			const begun = await controller.beginSession({ leafId: baselineLeaf, hasHistoryBeforeBaseline: baselineLeaf !== null });
			if (begun.status === "blocked") {
				emitStatus({ kind: "capture", status: "error", reason: begun.reason ?? "capture_state_corrupt", sessionId, owner });
				return;
			}
			if (begun.status === "baseline_created" && begun.state) {
				emitStatus({ kind: "capture", status: begun.status, sessionId, owner, lineagePartial: begun.state.lineagePartial, onceKey: `${sessionId}:${begun.status}` });
			}
			if (begun.status === "migrated") {
				emitStatus({ kind: "capture", status: "migrated", sessionId, owner, onceKey: `${sessionId}:migrated` });
			}
			const result = await controller.reconcile(buildViews(ctx, owner.project));
			if (result.registered > 0) {
				// 中途开启同步也要能发：先确保 sender 存在（幂等），再唤醒。
				await ensureSender(owner, profile);
				wakeSender();
			}
			if (result.blocked) {
				emitStatus({ kind: "capture", status: "blocked", reason: result.blocked, sessionId, owner, registered: result.registered, failed: result.failed });
			} else if (result.registered > 0 || result.failed > 0 || result.truncated || !result.stateSaved) {
				emitStatus({
					kind: "capture",
					status: result.failed > 0 ? "error" : "registered",
					reason: result.reasons[0] ?? (result.truncated ? "scan_truncated" : result.stateSaved ? null : "state_save_failed"),
					sessionId,
					owner,
					registered: result.registered,
					failed: result.failed,
					lineagePartial: result.state?.lineagePartial === true,
					onceKey: result.failed > 0 ? null : `${sessionId}:registered_no_error`,
				});
			}
			// sender：session_start 启动（重启也主动发旧 pending）；退出先停自己再落盘。
			if (phase === "session_start") await ensureSender(owner, profile);
			if (phase === "shutdown") await stopSender("session_shutdown");
		} catch {
			emitStatus({ kind: "capture", status: "error", reason: "capture_failed", sessionId, owner });
		}
	}

	return {
		readProfile,
		profileKeyOf,
		beginTurn,
		currentTurn: () => turn,
		turnBlocked: () => turn?.blocked === true,
		clearTurn: () => {
			turn = null;
		},
		reconcile,
		async flushCapture() {
			if (binding) await binding.controller.save();
		},
		stopSender,
		syncStatus: () => senderHost.status(),
		emitStatus,
	};
}
