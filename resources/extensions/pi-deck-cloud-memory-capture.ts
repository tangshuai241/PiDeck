/**
 * pi-deck-cloud-memory-capture —— 采集控制器（游标对账 + 失败重放 + 落盘编排）。
 *
 * 职责边界：
 * - 纯策略在 `-capture-plan.ts`（revision 编号、计划、pending 重放、游标结构）；
 * - 持久化在 `-capture-store.ts`（有界读写、fsync、scope 路径、记录文件）；
 * - 这里只做：加载（坏文件 fail-closed）、基线、按计划 register、成功才推进游标、
 *   计划身份先落盘再 register（失败/中断重放同一身份）、每次对账立即落盘。
 *
 * 只用 Pi public 读数（wrapper 提供视图）；不写任何 Pi 原生会话文件。
 */

import type { CaptureCursor, CaptureCursorEntry, CapturePlanBlock, CaptureRegisterResult, CaptureScopeKey, CaptureView, CaptureViews } from "./pi-deck-cloud-memory-capture-plan";
import { createCaptureCursor, markCapturePending, applyCaptureSuccess, planCapture, resolveParentSourceId, trimCaptureCursor } from "./pi-deck-cloud-memory-capture-plan";
import type { CaptureFsPort, CaptureLoadResult, CaptureStore } from "./pi-deck-cloud-memory-capture-store";
import { createCaptureStore } from "./pi-deck-cloud-memory-capture-store";
import type { CaptureAction } from "./pi-deck-cloud-memory-capture-plan";

export type CaptureControllerOptions = {
	/** scope：account/instance/device（device 进路径与游标复核）+ 本地 stateDir。 */
	scope: CaptureScopeKey & { stateDir: string };
	sessionId: string;
	register: (action: CaptureAction) => Promise<CaptureRegisterResult>;
	fsPort?: CaptureFsPort;
	nowIso?: () => string;
	maxScanEntries?: number;
	maxTrackedEntries?: number;
};

export type CaptureBeginResult = {
	status: "baseline_created" | "restored" | "migrated" | "blocked";
	reason: string | null;
	state: CaptureCursor | null;
};

export type CaptureReconcileResult = {
	state: CaptureCursor | null;
	planned: number;
	registered: number;
	failed: number;
	reasons: string[];
	/** 需要显式上报的阻塞（记录不可用、内容冲突、游标损坏等），不是静默跳过。 */
	blocked: string | null;
	truncated: boolean;
	stateSaved: boolean;
};

export type CaptureController = {
	beginSession(input: { leafId: string | null; hasHistoryBeforeBaseline: boolean }): Promise<CaptureBeginResult>;
	reconcile(views: CaptureViews, options?: { branchChangedAt?: string | null }): Promise<CaptureReconcileResult>;
	current(): CaptureCursor | null;
	save(): Promise<boolean>;
};

export function createCaptureController(options: CaptureControllerOptions): CaptureController {
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	const maxTracked = Math.max(1, options.maxTrackedEntries ?? 2000);
	const store: CaptureStore = createCaptureStore({ stateDir: options.scope.stateDir, scope: options.scope, sessionId: options.sessionId, fsPort: options.fsPort });
	let loaded: CaptureLoadResult | null = null;
	let cursor: CaptureCursor | null = null;
	let blockedReason: string | null = null;

	async function loadOnce(): Promise<CaptureLoadResult> {
		if (loaded) return loaded;
		loaded = await store.load();
		if (loaded.kind === "ok") cursor = loaded.cursor;
		// 坏游标 fail-closed：绝不当作「无历史」重建基线（否则会静默跳过未采内容）。
		if (loaded.kind === "corrupt") blockedReason = loaded.reason;
		return loaded;
	}

	async function persist(): Promise<boolean> {
		if (!cursor) return true;
		cursor = trimCaptureCursor({ ...cursor, updatedAt: nowIso() }, maxTracked);
		return await store.saveCursor(cursor);
	}

	return {
		async beginSession(input) {
			const result = await loadOnce();
			if (result.kind === "corrupt") return { status: "blocked", reason: result.reason, state: null };
			if (cursor) {
				// 已存在：只补 lineage 标记，不动基线（重启/恢复都不回补历史）；无变化不落盘。
				if (input.hasHistoryBeforeBaseline && !cursor.lineagePartial) {
					cursor = { ...cursor, lineagePartial: true };
					await persist();
				}
				return { status: result.kind === "ok" && result.migratedFrom !== null ? "migrated" : "restored", reason: null, state: cursor };
			}
			cursor = createCaptureCursor({ scope: { accountId: options.scope.accountId, cloudInstanceId: options.scope.cloudInstanceId, deviceId: options.scope.deviceId }, sessionId: options.sessionId, baselineEntryId: input.leafId, lineagePartial: input.hasHistoryBeforeBaseline, nowIso: nowIso() });
			const saved = await persist();
			return { status: saved ? "baseline_created" : "baseline_created", reason: saved ? null : "state_save_failed", state: cursor };
		},

		async reconcile(views, reconcileOptions) {
			const result = await loadOnce();
			if (result.kind === "corrupt" || !cursor) {
				if (result.kind === "corrupt") return { state: null, planned: 0, registered: 0, failed: 0, reasons: [result.reason], blocked: result.reason, truncated: false, stateSaved: false };
				// 没有游标（首次对账）：以当前叶建基线，避免把历史当新增。
				const historyExists = views.views.some((view) => view.entryId !== views.leafId);
				cursor = createCaptureCursor({ scope: { accountId: options.scope.accountId, cloudInstanceId: options.scope.cloudInstanceId, deviceId: options.scope.deviceId }, sessionId: options.sessionId, baselineEntryId: views.leafId, lineagePartial: historyExists, nowIso: nowIso() });
				const saved = await persist();
				return { state: cursor, planned: 0, registered: 0, failed: 0, reasons: [], blocked: null, truncated: false, stateSaved: saved };
			}

			const plan = await planCapture({
				cursor,
				views,
				readRecord: (sourceId) => store.readRecord(sourceId),
				maxScanEntries: options.maxScanEntries,
				branchChangedAt: reconcileOptions?.branchChangedAt ?? null,
			});

			// 计划身份先落盘：register 之前固定 revision/occurredAt，失败或中断后重放同一身份。
			if (plan.actions.length > 0) {
				cursor = plan.actions.reduce((current, action) => markCapturePending(current, action, nowIso()), cursor);
				await persist();
			}

			let registered = 0;
			let failed = 0;
			const reasons: string[] = [];
			const blocks: CapturePlanBlock[] = [...plan.blocks];
			// 父条目可能在同一批里刚刚登记：新消息的 parent_source_id 在登记时刻按最新游标解析。
			const resolved = new Map(Object.entries(cursor.entries).map(([entryId, entry]) => [entryId, entry.sourceId]));
			const byId = new Map(views.views.map((entry) => [entry.entryId, entry]));
			for (const planned of plan.actions) {
				const action = planned.kind === "message" && planned.previousRecord === null ? { ...planned, parentSourceId: resolved.get(planned.parentEntryId ?? "") ?? resolveParentSourceId(resolved, byId, planned.parentEntryId) } : planned;
				let outcome: CaptureRegisterResult;
				try {
					outcome = await options.register(action);
				} catch {
					outcome = { ok: false, reason: "register_threw" };
				}
				if (outcome.ok) {
					const written = await store.writeRecord(outcome.sourceId, outcome.record);
					cursor = applyCaptureSuccess(cursor, action, { sourceId: outcome.sourceId, revision: outcome.revision, record: outcome.record, recordOmitted: written !== "ok" }, nowIso());
					resolved.set(action.entryId, outcome.sourceId);
					registered += 1;
					if (written === "too_large") blocks.push("record_unavailable");
					continue;
				}
				failed += 1;
				if (reasons.length < 5 && !reasons.includes(outcome.reason)) reasons.push(outcome.reason);
				// 冲突：同身份异内容，重放不可能自愈；用队列已知的旧 sourceId 收口并显式上报，不无限重试。
				if (outcome.reason === "content_conflict") {
					const existing = "existingSourceId" in outcome && typeof outcome.existingSourceId === "string" ? outcome.existingSourceId : null;
					if (existing) {
						cursor = applyCaptureSuccess(cursor, { ...action, visibility: "visible" }, { sourceId: existing, revision: action.revision, record: null, recordOmitted: true }, nowIso());
					} else {
						cursor = markCapturePending(cursor, action, nowIso());
					}
					if (!blocks.includes("record_unavailable")) blocks.push("record_unavailable");
				}
			}

			const stateSaved = await persist();
			const blocked = blocks.length > 0 ? blocks[0] : null;
			return { state: cursor, planned: plan.actions.length, registered, failed, reasons, blocked, truncated: plan.truncated, stateSaved };
		},

		current() {
			return cursor;
		},

		async save() {
			return await persist();
		},
	};
}

export { createCaptureStore, captureScopeDir, captureCursorPath, captureStateFile, ensureDeviceId, createDefaultCaptureFsPort, CURSOR_READ_BYTES, RECORD_READ_BYTES, RECORD_WRITE_BYTES, DEVICE_READ_BYTES, CAPTURE_STATE_VERSION } from "./pi-deck-cloud-memory-capture-store";
export {
	CAPTURE_CURSOR_VERSION,
	DEFAULT_MAX_SCAN_ENTRIES,
	DEFAULT_MAX_TRACKED_ENTRIES,
	sha256Hex,
	visibleTextFromBlocks,
	buildCaptureView,
	createCaptureCursor,
	parseCaptureCursor,
	planCapture,
	applyCaptureSuccess,
	markCapturePending,
	clearCapturePending,
	trimCaptureCursor,
	pendingFromAction,
} from "./pi-deck-cloud-memory-capture-plan";
export type {
	CaptureAction,
	CaptureCompletion,
	CaptureCursor,
	CaptureCursorEntry,
	CaptureCursorParse,
	CapturePending,
	CapturePlan,
	CapturePlanBlock,
	CaptureRegisterResult,
	CaptureRole,
	CaptureScopeKey,
	CaptureTextBlock,
	CaptureView,
	CaptureViews,
} from "./pi-deck-cloud-memory-capture-plan";
export type { CaptureFsPort, CaptureLoadResult, CaptureReadResult, CaptureStore, EnsureDeviceResult } from "./pi-deck-cloud-memory-capture-store";
