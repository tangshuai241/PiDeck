/**
 * 云端记忆 Service（N04）：连接、受保护凭据、人格缓存、原生 RPC 状态与状态机。
 *
 * 职责边界：
 * - 编排 store（连接状态 + 加密凭据）、client（HTTP）、files（投影给 Pi 的文件）、
 *   statusProjection（原生 RPC 状态聚合）；
 * - 连接顺序固定为 URL 校验 → login → whoami（账号/主体/作用域）→ 投影写成功 → 才允许声称可用；
 * - 认证过期只按「已授权记住登录」的加密密码重登一次；失败标需重连，不做无限重试；
 * - 人格只读云端已发布版本（GET），写盘前回算 revision/raw_revision 哈希，按账号与实例隔离。
 *
 * 并发与持久化规则（审阅修正后，全模块统一）：
 * - `intentEpoch` 在**用户意图开始**时自增，所有敏感磁盘提交都经 `commit()`：
 *   串行队列内先复核 epoch、任务结束（含异步写盘）后再复核一次；过期任务既不落盘也不写内存；
 * - 失败一律如实：写失败 → `status.lastError` + `state=error`，不伪 logout/connected/enable；
 *   `setEnabled` 持久化失败时不改扩展开关；自动重登的存储/投影失败不声称会话可用；
 * - 旧账号/旧 generation 的迟到结果不能覆盖新 cache/config/auth；人格请求另有单调序号。
 *
 * 不做什么：
 * - 不建第二个人格真源、不做人格编辑器/发布入口（发布走现有云端用户确认入口）；
 * - 不读队列文件/扩展日志/GUI 桥当状态来源：原生状态只来自 Pi custom message（见 statusProjection）；
 * - 不管理工具目录、不动态注册工具。
 */

import { clearInterval, setInterval } from "node:timers";
import type { CloudMemoryErrorInfo, CloudMemoryNativeSummary, CloudMemoryPersonaSnapshot, CloudMemoryPersonaView, CloudMemoryStatus } from "../../shared/types/cloudMemory";
import type { CloudMemoryPaths } from "./cloudMemoryPaths";
import type { CloudMemoryClient } from "./cloudMemoryClient";
import { clearCloudMemoryPersonaCache, disableCloudMemoryProjection, readCloudMemoryPersonaCache, writeCloudMemoryPersonaCache, writeCloudMemoryProjection } from "./cloudMemoryFiles";
import type { CloudMemoryPersistedSettings, CloudMemoryStore } from "./cloudMemoryStore";
import { createDefaultCloudMemorySettings } from "./cloudMemoryStore";
import { CloudMemoryNativeStatus } from "./cloudMemoryNativeStatus";
import { errorInfo, type CloudMemoryConnectOutcome, type CloudMemoryServiceDeps, type CloudMemorySpawnProfile, type CommitFailure, type CommitOutcome, type CommitSuccess } from "./cloudMemoryServiceTypes";
import { sameCloudMemoryAuthIdentity, type CloudMemoryAuthLeaseResult, type CloudMemoryAuthSnapshot } from "./cloudMemoryAuthSeam";
import type { RuntimeBinding } from "./cloudMemoryStatusProjection";
import { parsePersonaPayload } from "./cloudMemoryPersona";
import { cloudInstanceIdFromOrigin, parseCloudMemoryConnectInput, verifyPersonaSnapshot, validateCloudPrincipal } from "./cloudMemoryValidation";

/** 后台人格刷新周期（默认 5 分钟）；同时充当状态查询触发的刷新节流窗口。 */
const DEFAULT_PERSONA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class CloudMemoryService {
	private readonly deps: CloudMemoryServiceDeps;
	private settings: CloudMemoryPersistedSettings = createDefaultCloudMemorySettings();
	private persona: CloudMemoryPersonaSnapshot | null = null;
	private lastError: CloudMemoryErrorInfo | null = null;
	/** 本进程内是否已用当前令牌通过 whoami；重启后需重新确认（启动时会异步确认）。 */
	private sessionValid = false;
	private restartRequired = false;
	/** 本次进程内是否成功取过云端人格：区分「刚取回」与「启动时读到的缓存」。 */
	private fetchedThisRun = false;
	private initialized = false;
	private disposed = false;

	/** 用户意图版本：意图开始即自增，任何更早的在飞结果都不再被接受。 */
	private intentEpoch = 0;
	/** 磁盘写入串行队列：并发 connect/logout 不会交叉写同一份投影。 */
	private writeChain: Promise<void> = Promise.resolve();
	/** 人格刷新去重：同一时刻只有一个请求；并发调用共享同一个 promise。 */
	private personaRefreshInFlight: Promise<CloudMemoryPersonaView | null> | null = null;
	/** 人格请求单调序号：旧请求不得覆盖新版本。 */
	private personaFetchSeq = 0;
	private personaAppliedSeq = 0;
	private lastFetchAttemptAt = 0;
	private refreshTimer: NodeJS.Timeout | null = null;
	/** 原生状态适配（作用域过滤在 domain 模块，投影策略在纯策略模块）。 */
	private readonly nativeStatus = new CloudMemoryNativeStatus({
		getScope: () => (this.settings.enabled && this.settings.account && this.settings.cloudInstanceId ? { account: this.settings.account, cloudInstanceId: this.settings.cloudInstanceId } : null),
	});

	constructor(deps: CloudMemoryServiceDeps) {
		this.deps = deps;
	}

	/** 启动装载：读连接状态与缓存；已启用且记住登录时后台确认会话并刷新人格（不阻塞启动）。 */
	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		this.settings = await this.deps.store.read();
		this.persona = await readCloudMemoryPersonaCache(this.deps.paths);
		if (this.persona && !this.sameIdentity(this.persona.account, this.persona.cloudInstanceId)) this.persona = null;
		if (!this.settings.enabled || !this.settings.baseUrl || !this.settings.account) return;
		if (!this.deps.store.readSecret(this.settings, "token") && !this.deps.store.readSecret(this.settings, "password")) return;
		this.ensureRefreshTimer();
		void this.refreshPersona({ force: true }).catch(() => undefined);
	}

	/** 退出清理：停后台刷新并拒绝迟到的在飞结果（不阻塞退出）。 */
	dispose(): void {
		this.disposed = true;
		this.stopRefreshTimer();
		this.nativeStatus.clear();
		this.intentEpoch += 1;
	}

	// ── 并发原语 ────────────────────────────────────────────────────────────────

	/** 开启一次用户意图：立刻作废所有更早的在飞异步结果。 */
	private beginIntent(): number {
		this.intentEpoch += 1;
		return this.intentEpoch;
	}

	private epochGuard(epoch: number): CommitSuccess<null> | (CommitFailure & { stale: boolean }) {
		if (this.disposed) return { ok: false, stale: true, error: errorInfo("internalError", "云端记忆服务已停止") };
		if (epoch !== this.intentEpoch) return { ok: false, stale: true, error: this.staleError() };
		return { ok: true, value: null };
	}

	private staleError(): CloudMemoryErrorInfo {
		return errorInfo("internalError", "连接状态已变化，本次结果作废");
	}

	/** 串行执行一次磁盘 commit；队列内与任务结束后各复核一次 epoch。 */
	private async commit<T>(epoch: number, task: () => Promise<CommitSuccess<T> | CommitFailure>): Promise<CommitOutcome<T>> {
		return this.runSerialized(async () => {
			const before = this.epochGuard(epoch);
			if (!before.ok) return before;
			const result = await task();
			const after = this.epochGuard(epoch);
			if (!after.ok) return after;
			return result.ok ? result : { ...result, stale: false };
		});
	}

	/** 串行队列本体：前一个任务失败不影响后一个。 */
	private runSerialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writeChain.then(task, task);
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// ── 投影与状态 ──────────────────────────────────────────────────────────────

	private projectionSnapshotOf(settings: CloudMemoryPersistedSettings): { baseUrl: string; account: string; cloudInstanceId: string; syncMode: CloudMemoryPersistedSettings["syncMode"]; syncEnabled: boolean } | null {
		if (!settings.baseUrl || !settings.account || !settings.cloudInstanceId) return null;
		return { baseUrl: settings.baseUrl, account: settings.account, cloudInstanceId: settings.cloudInstanceId, syncMode: settings.syncMode, syncEnabled: settings.syncEnabled };
	}

	/** 只落盘，不改内存：内存状态只在 commit 通过写后复核后应用。 */
	private async rawWrite(next: CloudMemoryPersistedSettings): Promise<boolean> {
		const result = await this.deps.store.write(next);
		return result.ok;
	}

	/** 投影 config+auth（按待提交的 settings，而不是当前内存态），失败如实回传。 */
	private async projectFor(settings: CloudMemoryPersistedSettings, enabled: boolean, token: string | null): Promise<CommitSuccess<null> | CommitFailure> {
		const snapshot = this.projectionSnapshotOf(settings);
		if (!snapshot) return { ok: true, value: null };
		if (enabled && token) {
			const written = await writeCloudMemoryProjection(this.deps.paths, snapshot, token);
			if (!written.ok) return { ok: false, error: errorInfo("internalError", written.reason === "auth" ? "运行时令牌写入失败，扩展无法读取连接" : "扩展配置写入失败，扩展无法启用") };
			return { ok: true, value: null };
		}
		const disabled = await disableCloudMemoryProjection(this.deps.paths, snapshot);
		if (!disabled.ok) return { ok: false, error: errorInfo("internalError", disabled.reason === "auth" ? "运行时令牌删除失败，扩展仍可能读到旧凭据" : "扩展配置写入失败") };
		return { ok: true, value: null };
	}

	private async applyExtensionSwitch(enabled: boolean): Promise<void> {
		try {
			if (this.deps.isPiExtensionEnabled() !== enabled) await this.deps.setPiExtensionEnabled(enabled);
			if (enabled) this.restartRequired = true;
		} catch {
			this.deps.log?.("extension switch update failed", { enabled });
		}
	}

	private sameIdentity(account: string | null, cloudInstanceId: string | null): boolean {
		return Boolean(account && cloudInstanceId && this.settings.account === account && this.settings.cloudInstanceId === cloudInstanceId);
	}

	/** 可见状态变化：通知渲染层重拉（推送不带状态内容，避免第二条事实通道）。 */
	private notifyStatusChanged(): void {
		try {
			this.deps.onStatusChanged?.();
		} catch {
			this.deps.log?.("status change notification failed", {});
		}
	}

	private nowIso(): string {
		return (this.deps.now?.() ?? new Date()).toISOString();
	}

	/** 失败收敛：写入 lastError（stale 不写，避免把「意图已变」显示成错误）。 */
	private fail(error: CloudMemoryErrorInfo, stale: boolean): null {
		if (!stale) this.lastError = error;
		return null;
	}

	// ── 后台刷新 ────────────────────────────────────────────────────────────────

	private refreshIntervalMs(): number {
		const configured = this.deps.personaRefreshIntervalMs;
		return configured && configured > 0 ? configured : DEFAULT_PERSONA_REFRESH_INTERVAL_MS;
	}

	/** 每 5 分钟检查一次人格版本（同一时刻只会有一个请求，见 refreshPersona 去重）。 */
	private ensureRefreshTimer(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			void this.refreshPersona().catch(() => undefined);
		}, this.refreshIntervalMs());
	}

	private stopRefreshTimer(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}

	// ── 连接 / 登出 / 开关 ──────────────────────────────────────────────────────

	/** 连接：校验输入 → 登录 → whoami 校验 → 投影写成功 → 才允许声称可用。 */
	async connect(rawInput: unknown): Promise<CloudMemoryConnectOutcome> {
		const parsed = parseCloudMemoryConnectInput(rawInput);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		const input = parsed.input;
		const epoch = this.beginIntent();
		const session = await this.deps.client.login(input.baseUrl, input.account, input.password);
		if (this.stale(epoch)) return { ok: false, error: this.staleError() };
		if (!session.ok) {
			this.lastError = session.error;
			return { ok: false, error: session.error };
		}
		const whoami = await this.deps.client.whoami(input.baseUrl, session.session.token);
		if (this.stale(epoch)) return { ok: false, error: this.staleError() };
		if (!whoami.ok) {
			this.lastError = whoami.error;
			return { ok: false, error: whoami.error };
		}
		const principal = validateCloudPrincipal(whoami.payload, input.account);
		if (!principal.ok) {
			this.lastError = principal.error;
			return { ok: false, error: principal.error };
		}
		const protectedToken = this.deps.store.protectSecret(session.session.token);
		if (!protectedToken) {
			const error = errorInfo("secureStorageUnavailable", "系统安全存储不可用，无法保存登录状态");
			this.lastError = error;
			return { ok: false, error };
		}
		let protectedPassword: string | undefined;
		if (input.rememberSignIn) {
			const guarded = this.deps.store.protectSecret(input.password);
			if (!guarded) {
				const error = errorInfo("secureStorageUnavailable", "系统安全存储不可用，无法记住登录");
				this.lastError = error;
				return { ok: false, error };
			}
			protectedPassword = guarded;
		}
		const cloudInstanceId = cloudInstanceIdFromOrigin(input.baseUrl);
		const committed = await this.commit(epoch, async () => {
			const previous = this.settings;
			const identityChanged = previous.account !== principal.account || previous.cloudInstanceId !== cloudInstanceId;
			const next: CloudMemoryPersistedSettings = {
				...previous,
				enabled: true,
				baseUrl: input.baseUrl,
				account: principal.account,
				cloudInstanceId,
				syncMode: input.syncMode,
				rememberSignIn: input.rememberSignIn,
				lastConnectedAt: this.nowIso(),
				configEpoch: previous.configEpoch + 1,
				protectedToken,
			};
			if (protectedPassword) next.protectedPassword = protectedPassword;
			else delete next.protectedPassword;
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			if (identityChanged) {
				const cleared = await clearCloudMemoryPersonaCache(this.deps.paths);
				if (!cleared.ok) return { ok: false, error: errorInfo("internalError", "旧账号人格缓存清理失败") };
			}
			const projected = await this.projectFor(next, true, session.session.token);
			if (!projected.ok) return projected;
			return { ok: true, value: { next, identityChanged } };
		});
		if (!committed.ok) {
			this.sessionValid = false;
			this.fail(committed.error, committed.stale);
			this.notifyStatusChanged();
			return { ok: false, error: committed.error };
		}
		const { next, identityChanged } = committed.value;
		this.settings = next;
		if (identityChanged) {
			// 换账号/换实例：旧账号的个人内容与状态一律不留给新账号
			this.persona = null;
			this.fetchedThisRun = false;
			this.nativeStatus.clear();
		}
		this.sessionValid = true;
		this.lastError = null;
		this.ensureRefreshTimer();
		this.notifyStatusChanged();
		void this.refreshPersona({ force: true }).catch(() => undefined);
		this.deps.log?.("connection saved", { origin: input.baseUrl, mode: input.syncMode, rememberSignIn: input.rememberSignIn });
		await this.applyExtensionSwitch(true);
		return { ok: true, status: await this.getStatus() };
	}

	/** 登出：先清本地（令牌/缓存/凭据），再用不阻塞的 best-effort 撤销服务端会话。 */
	async logout(): Promise<CloudMemoryStatus> {
		const epoch = this.beginIntent();
		const revoke = { origin: this.settings.baseUrl, token: this.deps.store.readSecret(this.settings, "token") };
		// 意图已表达：立刻停止后台刷新与会话可用性声明（真正的磁盘清理在下面的 commit 里）
		this.sessionValid = false;
		this.stopRefreshTimer();
		const committed = await this.commit(epoch, async () => {
			const next = { ...this.settings, configEpoch: this.settings.configEpoch + 1 };
			delete next.protectedToken;
			delete next.protectedPassword;
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			// 先停用扩展（config enabled:false + 删令牌），再做缓存清理：失败也不会让扩展继续工作
			const disabled = await this.projectFor(next, false, null);
			if (!disabled.ok) return disabled;
			const cleared = await clearCloudMemoryPersonaCache(this.deps.paths);
			if (!cleared.ok) return { ok: false, error: errorInfo("internalError", "人格缓存清理失败") };
			return { ok: true, value: next };
		});
		if (!committed.ok) {
			// 写失败不能伪称已登出：保留 lastError（status.state=error），下一次操作可重试
			this.fail(committed.error, committed.stale);
			this.notifyStatusChanged();
			return this.getStatus();
		}
		this.settings = committed.value;
		this.persona = null;
		this.fetchedThisRun = false;
		this.nativeStatus.clear();
		this.lastError = null;
		// 本地凭据已删除，网络撤销不阻塞返回（离线也不会留着活动令牌等 10s）
		if (revoke.origin && revoke.token) void this.deps.client.logout(revoke.origin, revoke.token).catch(() => undefined);
		this.notifyStatusChanged();
		this.deps.log?.("logged out", {});
		return this.getStatus();
	}

	/** 总开关：只在用户明确操作时改；登记/撤销 enabledBuiltInExtensions，不自动终止会话。 */
	async setEnabled(enabled: boolean): Promise<CloudMemoryStatus> {
		// 上一次失败（如投影写失败）时允许重试，即便开关值没变
		if (this.settings.enabled === enabled && !this.lastError) return this.getStatus();
		const epoch = this.beginIntent();
		const token = enabled ? this.deps.store.readSecret(this.settings, "token") : null;
		const committed = await this.commit(epoch, async () => {
			const next = { ...this.settings, enabled, configEpoch: this.settings.configEpoch + 1 };
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			const projected = await this.projectFor(next, enabled, token);
			if (!projected.ok) return projected;
			return { ok: true, value: next };
		});
		if (!committed.ok) {
			// 持久化/投影失败：不改扩展开关，也不声称已启用/已关闭
			this.fail(committed.error, committed.stale);
			this.notifyStatusChanged();
			return this.getStatus();
		}
		this.settings = committed.value;
		this.restartRequired = true;
		this.lastError = null;
		if (enabled) {
			await this.applyExtensionSwitch(true);
			this.ensureRefreshTimer();
			void this.refreshPersona({ force: true }).catch(() => undefined);
		} else {
			this.stopRefreshTimer();
			this.nativeStatus.clear();
			await this.applyExtensionSwitch(false);
		}
		this.notifyStatusChanged();
		return this.getStatus();
	}

	async setSyncEnabled(syncEnabled: boolean): Promise<CloudMemoryStatus> {
		const epoch = this.beginIntent();
		const token = this.deps.store.readSecret(this.settings, "token");
		const committed = await this.commit(epoch, async () => {
			const next = { ...this.settings, syncEnabled, configEpoch: this.settings.configEpoch + 1 };
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			const projected = await this.projectFor(next, next.enabled && Boolean(token), token);
			if (!projected.ok) return projected;
			return { ok: true, value: next };
		});
		if (!committed.ok) {
			this.fail(committed.error, committed.stale);
			this.notifyStatusChanged();
			return this.getStatus();
		}
		this.settings = committed.value;
		this.lastError = null;
		this.notifyStatusChanged();
		return this.getStatus();
	}

	// ── 人格缓存 ────────────────────────────────────────────────────────────────

	/** 刷新人格缓存：并发去重；需要时先确认会话（只重登一次）；离线保留缓存并标记。 */
	async refreshPersona(options: { force?: boolean } = {}): Promise<CloudMemoryPersonaView | null> {
		if (this.personaRefreshInFlight) return this.personaRefreshInFlight;
		const task = this.runPersonaRefresh(options);
		this.personaRefreshInFlight = task;
		try {
			return await task;
		} finally {
			if (this.personaRefreshInFlight === task) this.personaRefreshInFlight = null;
		}
	}

	private async runPersonaRefresh(options: { force?: boolean }): Promise<CloudMemoryPersonaView | null> {
		if (!this.settings.enabled || !this.settings.baseUrl || !this.settings.account || !this.settings.cloudInstanceId) return this.getPersonaView();
		const nowMs = Date.now();
		if (!options.force && nowMs - this.lastFetchAttemptAt < this.refreshIntervalMs()) return this.getPersonaView();
		this.lastFetchAttemptAt = nowMs;
		const epoch = this.intentEpoch;
		const seq = ++this.personaFetchSeq;
		const session = await this.ensureSession(epoch);
		if (!session.ok) return this.getPersonaView();
		const response = await this.deps.client.persona(this.settings.baseUrl, session.value.token);
		if (this.stale(epoch)) return this.getPersonaView();
		if (!response.ok) {
			this.lastError = response.error;
			return this.getPersonaView();
		}
		const snapshot = parsePersonaPayload(response.payload, this.settings.account, this.settings.cloudInstanceId, this.nowIso());
		if (!snapshot) {
			this.lastError = errorInfo("personaUnverified", "云端人格版本校验失败，保留本地缓存");
			this.deps.log?.("persona payload failed revision verification", {});
			return this.getPersonaView();
		}
		// 缓存写与时间戳持久化走同一串行 commit：旧请求在队列内就会被序号拦下，不会后写覆盖新版本
		const applied = await this.commit(epoch, async () => {
			if (seq < this.personaAppliedSeq) return { ok: false, error: this.staleError() };
			const written = await writeCloudMemoryPersonaCache(this.deps.paths, snapshot);
			if (!written.ok) return { ok: false, error: errorInfo("internalError", written.reason === "unverified" ? "人格版本校验失败" : "人格缓存写入失败") };
			const next = { ...this.settings, lastPersonaFetchAt: snapshot.fetchedAt, configEpoch: this.settings.configEpoch + 1 };
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			return { ok: true, value: { snapshot, next, seq } };
		});
		if (!applied.ok) {
			this.fail(applied.error, applied.stale);
			return this.getPersonaView();
		}
		this.personaAppliedSeq = applied.value.seq;
		this.persona = applied.value.snapshot;
		this.settings = applied.value.next;
		this.fetchedThisRun = true;
		this.lastError = null;
		this.notifyStatusChanged();
		return this.getPersonaView();
	}

	/** 会话确认：优先已存令牌（whoami 验一次），失效则按记住登录的密码重登一次，不循环重试。 */
	private async ensureSession(epoch: number): Promise<CommitSuccess<{ token: string }> | CommitFailure> {
		const origin = this.settings.baseUrl;
		const account = this.settings.account;
		if (!origin || !account) return { ok: false, error: errorInfo("notConfigured", "尚未配置云端连接") };
		const existing = this.deps.store.readSecret(this.settings, "token");
		if (existing) {
			const whoami = await this.deps.client.whoami(origin, existing);
			if (this.stale(epoch)) return { ok: false, error: this.staleError() };
			if (whoami.ok && validateCloudPrincipal(whoami.payload, account).ok) {
				this.sessionValid = true;
				this.lastError = null;
				return { ok: true, value: { token: existing } };
			}
			if (!whoami.ok && whoami.error.code !== "unauthorized") {
				this.sessionValid = false;
				this.lastError = whoami.error;
				return { ok: false, error: whoami.error };
			}
		}
		const password = this.deps.store.readSecret(this.settings, "password");
		if (!password) {
			const error = errorInfo("unauthorized", "登录状态已失效，请重新连接");
			this.sessionValid = false;
			this.lastError = error;
			return { ok: false, error };
		}
		const login = await this.deps.client.login(origin, account, password);
		if (this.stale(epoch)) return { ok: false, error: this.staleError() };
		if (!login.ok) {
			this.sessionValid = false;
			this.lastError = login.error;
			return { ok: false, error: login.error };
		}
		const whoami = await this.deps.client.whoami(origin, login.session.token);
		if (this.stale(epoch)) return { ok: false, error: this.staleError() };
		const principal = whoami.ok ? validateCloudPrincipal(whoami.payload, account) : { ok: false as const, error: whoami.error };
		if (!principal.ok) {
			this.sessionValid = false;
			this.lastError = principal.error;
			return { ok: false, error: principal.error };
		}
		// 令牌落盘 + 投影在同一 commit 内完成：任一失败都不得声称会话可用
		const committed = await this.commit(epoch, async () => {
			const protectedToken = this.deps.store.protectSecret(login.session.token);
			if (!protectedToken) return { ok: false, error: errorInfo("secureStorageUnavailable", "系统安全存储不可用，无法保存登录状态") };
			const next = { ...this.settings, protectedToken, lastConnectedAt: this.nowIso(), configEpoch: this.settings.configEpoch + 1 };
			if (!(await this.rawWrite(next))) return { ok: false, error: errorInfo("internalError", "本地连接状态写入失败") };
			const projected = await this.projectFor(next, true, login.session.token);
			if (!projected.ok) return projected;
			return { ok: true, value: next };
		});
		if (!committed.ok) {
			this.sessionValid = false;
			this.fail(committed.error, committed.stale);
			return { ok: false, error: committed.error };
		}
		this.settings = committed.value;
		this.sessionValid = true;
		this.lastError = null;
		return { ok: true, value: { token: login.session.token } };
	}

	getPersonaView(): CloudMemoryPersonaView | null {
		if (!this.persona) return null;
		if (!this.sameIdentity(this.persona.account, this.persona.cloudInstanceId)) return null;
		return { ...this.persona, stale: !this.fetchedThisRun };
	}

	// ── 认证复用 seam（P02 待办等主进程域）──────────────────────────────────────

	/**
	 * 当前连接身份（不含凭据）。与记忆总开关无关：记忆被关闭、或登出只删令牌保留地址/账号时，
	 * 快照仍返回身份；是否真的能换到令牌由 acquireAuthLease 判定。
	 */
	getAuthSnapshot(): CloudMemoryAuthSnapshot | null {
		const { baseUrl, account, cloudInstanceId } = this.settings;
		if (!baseUrl || !account || !cloudInstanceId) return null;
		return { origin: baseUrl, account, cloudInstanceId, configEpoch: this.settings.configEpoch };
	}

	/**
	 * 换取一次会话令牌：先复核调用方持有的身份未被替换（防旧账号请求发到新账号），
	 * 再走既有 ensureSession（令牌验一次，失效且记住登录时重登一次，不循环重试）。
	 * `stale=true` 表示身份已切换，调用方不得展示为用户可见错误。
	 */
	async acquireAuthLease(expected: CloudMemoryAuthSnapshot): Promise<CloudMemoryAuthLeaseResult> {
		const current = this.getAuthSnapshot();
		if (!current || !sameCloudMemoryAuthIdentity(current, expected)) return { ok: false, stale: true, error: this.staleError() };
		const epoch = this.intentEpoch;
		const session = await this.ensureSession(epoch);
		if (!session.ok) return { ok: false, stale: this.disposed || epoch !== this.intentEpoch, error: session.error };
		const after = this.getAuthSnapshot();
		if (this.disposed || epoch !== this.intentEpoch || !after || !sameCloudMemoryAuthIdentity(after, expected)) return { ok: false, stale: true, error: this.staleError() };
		return { ok: true, lease: { ...after, token: session.value.token } };
	}

	// ── 原生 RPC 状态（N08 消费端）───────────────────────────────────────────────

	/**
	 * 消费一条 Pi 原生状态消息（custom message details）。
	 * 只接受绑定匹配（agentId + sessionId + runtimeGeneration）且账号/实例与本机当前连接一致的条目。
	 */
	ingestNativeStatus(binding: RuntimeBinding, payload: unknown): boolean {
		const accepted = this.nativeStatus.ingest(binding, payload);
		// 采纳即推送：设置页开着时 pending/回执/相位才能自己刷新（扩展侧已按变化去重，频率有界）
		if (accepted) this.notifyStatusChanged();
		return accepted;
	}

	/** 进程停止/被替换：移除该 agent 的状态（没有新鲜状态就是未知，不留旧计数）。 */
	forgetNativeStatus(agentId: string): void {
		this.nativeStatus.forget(agentId);
	}

	/** 当前账号作用域的聚合摘要；没有新鲜状态或未连接时返回 null（未知 != 0）。 */
	getNativeSummary(): CloudMemoryNativeSummary | null {
		return this.nativeStatus.summary();
	}

	// ── 状态 ────────────────────────────────────────────────────────────────────

	/**
	 * 投影给 pi 子进程的 spawn 输入。identity 覆盖「账号/实例/启用/范围」——
	 * 路径不变但账号换了时，standby 池里的旧进程必须作废（旧 runtime 不能悄悄换账号）。
	 */
	getSpawnProfile(): CloudMemorySpawnProfile {
		const identity = ["v1", `enabled:${this.settings.enabled ? 1 : 0}`, `account:${this.settings.account ?? ""}`, `instance:${this.settings.cloudInstanceId ?? ""}`, `mode:${this.settings.syncMode}`, `sync:${this.settings.syncEnabled ? 1 : 0}`].join("|");
		return { configPath: this.deps.paths.configFile, dataDir: this.deps.paths.dataDir, identity };
	}

	async getStatus(): Promise<CloudMemoryStatus> {
		const secureStorageAvailable = this.deps.store.isSecureStorageAvailable();
		const credentialStored = Boolean(this.settings.protectedToken || this.settings.protectedPassword);
		return {
			enabled: this.settings.enabled,
			state: this.resolveState(credentialStored),
			baseUrl: this.settings.baseUrl,
			account: this.settings.account,
			cloudInstanceId: this.settings.cloudInstanceId,
			syncMode: this.settings.syncMode,
			syncEnabled: this.settings.syncEnabled,
			rememberSignIn: this.settings.rememberSignIn,
			credentialStored,
			secureStorageAvailable,
			lastError: this.lastError,
			lastConnectedAt: this.settings.lastConnectedAt,
			lastPersonaFetchAt: this.settings.lastPersonaFetchAt,
			extensionEnabled: this.deps.isPiExtensionEnabled(),
			restartRequired: this.restartRequired,
			persona: this.getPersonaView(),
			native: this.getNativeSummary(),
			paths: {
				dataDir: this.deps.paths.dataDir,
				configFile: this.deps.paths.configFile,
				authFile: this.deps.paths.authFile,
				logFile: this.deps.paths.logFile,
				personaCacheFile: this.deps.paths.personaCacheFile,
			},
		};
	}

	private resolveState(credentialStored: boolean): CloudMemoryStatus["state"] {
		// 任何未消解的失败都如实显示 error（含登出/开关/投影写失败）；认证类失败引导重新连接
		if (this.lastError) return this.lastError.code === "unauthorized" ? "needsReconnect" : "error";
		if (!this.settings.enabled) return "disabled";
		if (!this.settings.baseUrl || !this.settings.account) return "notConfigured";
		if (this.sessionValid) return "connected";
		return credentialStored ? "needsReconnect" : "needsReconnect";
	}

	private stale(epoch: number): boolean {
		return this.disposed || epoch !== this.intentEpoch;
	}
}

// 兼容既有调用方：人格解析实现在 cloudMemoryPersona，注入契约在 cloudMemoryServiceTypes
export { parsePersonaPayload };
export type { CloudMemoryConnectOutcome, CloudMemoryServiceDeps, CloudMemorySpawnProfile };
