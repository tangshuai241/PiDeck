/**
 * pi-deck-cloud-memory-capture-plan —— 采集的纯策略层（游标结构、revision 编号、计划与重放）。
 *
 * 与 IO 完全分离：不读文件、不联网、不认识 D 的类型。硬规则：
 * - revision 编号**按条目**：首个事件固定 1，其后 = 上一条 revision + 1（不用全局 floor，避免夹在
 *   中间的成功项把失败项的下一次编号推走）；
 * - 事件时间稳定：优先用原生 event 时间（context_edit / 条目时间戳）随计划一起持久化到 pending，
 *   重试复用同一 occurredAt，失败重放不会换 hash；
 * - 失败/未知重放：pending 里保存计划身份（revision/occurredAt/kind/visibility/target），
 *   重试仍用同一身份，因此 sourceId 与 contentHash 稳定；
 * - 坏游标不在这里解释成「无历史」：解析失败返回 corrupt，由上层 fail-closed。
 */

import { createHash } from "node:crypto";

export const CAPTURE_CURSOR_VERSION = 2;
export const DEFAULT_MAX_SCAN_ENTRIES = 400;
export const DEFAULT_MAX_TRACKED_ENTRIES = 2000;

export type CaptureRole = "user" | "assistant";
export type CaptureCompletion = "completed" | "incomplete";
export type CaptureTextBlock = { readonly type: "text"; readonly text: string };

/** 采集 scope：账号 + 云端实例 + 设备（同一 Pi session id 在不同 scope 下必须互不复用）。 */
export type CaptureScopeKey = { readonly accountId: string; readonly cloudInstanceId: string; readonly deviceId: string };

export type CaptureView = {
	readonly entryId: string;
	readonly parentEntryId: string | null;
	readonly role: CaptureRole;
	readonly textBlocks: readonly CaptureTextBlock[];
	readonly visibleText: string;
	readonly textSha256: string;
	readonly occurredAt: string;
	/** 影响该条目的原生事件时间（context_edit / 条目时间戳），用于可见性与编辑事件的稳定 occurredAt。 */
	readonly changedAt: string;
	readonly completion: CaptureCompletion;
	/** true=可见；false=被 context_edit 显式移出；null=本次投影未覆盖（压缩裁剪），不改状态。 */
	readonly visible: boolean | null;
	readonly project: string | null;
};

export type CaptureViews = {
	/** 活动分支上的 message 条目，根 → 叶顺序（Pi getBranch 的原顺序；完整窗口，模块内部自行限扫）。 */
	readonly views: readonly CaptureView[];
	readonly leafId: string | null;
};

export type CaptureCursorEntry = {
	readonly revision: number;
	readonly sourceId: string;
	readonly textSha256: string;
	readonly visible: boolean;
	readonly updatedAt: string;
	/** 原记录超出写端上限或迁移失败：该条目不能再生成 revision 事件（显式，不猜内容）。 */
	readonly recordOmitted: boolean;
};

/** 计划身份：register 之前先落盘，失败重放同一身份（同 revision/occurredAt → 同 sourceId 与 hash）。 */
export type CapturePending = {
	readonly entryId: string;
	readonly kind: "message" | "revision";
	readonly revision: number;
	readonly occurredAt: string;
	readonly visibility: "visible" | "hidden";
	readonly role: CaptureRole;
	readonly parentEntryId: string | null;
	/** 首次尝试时解析出的父 sourceId：重放固定它，避免中间父条目被登记后 content_hash 变化。 */
	readonly parentSourceId: string | null;
	readonly targetSourceId: string | null;
};

export type CaptureCursor = {
	readonly version: typeof CAPTURE_CURSOR_VERSION;
	readonly scope: CaptureScopeKey;
	readonly sessionId: string;
	readonly baselineEntryId: string | null;
	readonly entries: Record<string, CaptureCursorEntry>;
	readonly pending: Record<string, CapturePending>;
	readonly lineagePartial: boolean;
	readonly trackedTruncated: boolean;
	/** 从初版（未发布）格式迁移时的来源版本；未迁移为 null。 */
	readonly migratedFrom: number | null;
	readonly updatedAt: string;
};

export type CaptureAction = {
	readonly kind: "message" | "revision";
	readonly entryId: string;
	readonly revision: number;
	readonly role: CaptureRole;
	readonly textBlocks: readonly CaptureTextBlock[];
	readonly visibleText: string;
	readonly occurredAt: string;
	readonly completion: CaptureCompletion;
	readonly project: string | null;
	readonly branch: string | null;
	readonly parentEntryId: string | null;
	readonly parentSourceId: string | null;
	readonly targetSourceId: string | null;
	readonly visibility: "visible" | "hidden";
	/** revision 事件的原记录；新条目录入时为 null。 */
	readonly previousRecord: unknown;
};

export type CaptureRegisterResult =
	| { ok: true; sourceId: string; revision: number; record: unknown }
	| { ok: false; reason: string; existingSourceId?: string | null };

export type CapturePlanBlock = "record_unavailable" | "pending_conflict";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 与 D 的 visibleTextFromBlocks 同口径：可见文本 = 各 text 块以 LF 连接。 */
export function visibleTextFromBlocks(blocks: readonly CaptureTextBlock[]): string {
	return blocks.map((block) => block.text).join("\n");
}

export function buildCaptureView(input: {
	entryId: string;
	parentEntryId: string | null;
	role: CaptureRole;
	textBlocks: readonly CaptureTextBlock[];
	occurredAt: string;
	changedAt?: string;
	completion: CaptureCompletion;
	visible: boolean | null;
	project: string | null;
}): CaptureView {
	const blocks = input.textBlocks.filter((block) => block.text.length > 0);
	const visibleText = visibleTextFromBlocks(blocks);
	return { ...input, changedAt: input.changedAt ?? input.occurredAt, textBlocks: blocks, visibleText, textSha256: sha256Hex(visibleText) };
}

export function createCaptureCursor(input: { scope: CaptureScopeKey; sessionId: string; baselineEntryId: string | null; lineagePartial: boolean; nowIso: string; migratedFrom?: number | null }): CaptureCursor {
	return {
		version: CAPTURE_CURSOR_VERSION,
		scope: input.scope,
		sessionId: input.sessionId,
		baselineEntryId: input.baselineEntryId,
		entries: {},
		pending: {},
		lineagePartial: input.lineagePartial,
		trackedTruncated: false,
		migratedFrom: input.migratedFrom ?? null,
		updatedAt: input.nowIso,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScopeKey(value: unknown): value is CaptureScopeKey {
	return isRecord(value) && typeof value.accountId === "string" && value.accountId.length > 0 && typeof value.cloudInstanceId === "string" && value.cloudInstanceId.length > 0 && typeof value.deviceId === "string" && value.deviceId.length > 0;
}

function parseCursorEntry(value: unknown): CaptureCursorEntry | null {
	if (!isRecord(value)) return null;
	const revision = value.revision;
	const sourceId = value.sourceId;
	const textSha256 = value.textSha256;
	const visible = value.visible;
	const updatedAt = value.updatedAt;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
	if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 256) return null;
	if (typeof textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(textSha256)) return null;
	if (typeof visible !== "boolean") return null;
	if (typeof updatedAt !== "string" || updatedAt.length === 0 || updatedAt.length > 64) return null;
	return { revision, sourceId, textSha256, visible, updatedAt, recordOmitted: value.recordOmitted === true };
}

function parsePending(value: unknown): CapturePending | null {
	if (!isRecord(value)) return null;
	const kind = value.kind;
	const revision = value.revision;
	const occurredAt = value.occurredAt;
	const visibility = value.visibility;
	const role = value.role;
	const entryId = value.entryId;
	if (kind !== "message" && kind !== "revision") return null;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
	if (typeof occurredAt !== "string" || occurredAt.length === 0 || occurredAt.length > 64) return null;
	if (visibility !== "visible" && visibility !== "hidden") return null;
	if (role !== "user" && role !== "assistant") return null;
	if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 256) return null;
	const parentEntryId = value.parentEntryId === null ? null : typeof value.parentEntryId === "string" && value.parentEntryId.length <= 256 ? value.parentEntryId : null;
	const targetSourceId = value.targetSourceId === null ? null : typeof value.targetSourceId === "string" && value.targetSourceId.length <= 256 ? value.targetSourceId : null;
	const parentSourceId = value.parentSourceId === null || value.parentSourceId === undefined ? null : typeof value.parentSourceId === "string" && value.parentSourceId.length <= 256 ? value.parentSourceId : null;
	return { entryId, kind, revision, occurredAt, visibility, role, parentEntryId, parentSourceId, targetSourceId };
}

export type CaptureCursorParse = { kind: "ok"; cursor: CaptureCursor; legacyRecords: null } | { kind: "legacy"; cursor: CaptureCursor; legacyRecords: Record<string, unknown> } | { kind: "corrupt"; reason: string };

/**
 * 解析游标：形状不符一律 corrupt（上层 fail-closed，绝不当成「无历史」重建基线）。
 * version 1（已实现未发布）保守迁移：条目/基线/lineage 保留，revision 编号沿用原值，
 * 原文件内嵌的 record 交给上层写入独立记录文件。
 */
export function parseCaptureCursor(raw: unknown, expected: { scope: CaptureScopeKey; sessionId: string }): CaptureCursorParse {
	if (!isRecord(raw)) return { kind: "corrupt", reason: "cursor_not_object" };
	if (raw.version === 1) return parseLegacyCursor(raw, expected);
	if (raw.version !== CAPTURE_CURSOR_VERSION) return { kind: "corrupt", reason: "cursor_version_unsupported" };
	if (!isScopeKey(raw.scope)) return { kind: "corrupt", reason: "cursor_scope_invalid" };
	if (raw.scope.accountId !== expected.scope.accountId || raw.scope.cloudInstanceId !== expected.scope.cloudInstanceId || raw.scope.deviceId !== expected.scope.deviceId) return { kind: "corrupt", reason: "scope_mismatch" };
	if (raw.sessionId !== expected.sessionId) return { kind: "corrupt", reason: "cursor_session_mismatch" };
	const baselineEntryId = raw.baselineEntryId;
	if (baselineEntryId !== null && (typeof baselineEntryId !== "string" || baselineEntryId.length > 256)) return { kind: "corrupt", reason: "cursor_baseline_invalid" };
	if (!isRecord(raw.entries)) return { kind: "corrupt", reason: "cursor_entries_invalid" };
	const entries: Record<string, CaptureCursorEntry> = {};
	for (const [entryId, value] of Object.entries(raw.entries)) {
		if (entryId.length === 0 || entryId.length > 256) return { kind: "corrupt", reason: "cursor_entry_id_invalid" };
		const entry = parseCursorEntry(value);
		if (!entry) return { kind: "corrupt", reason: "cursor_entry_invalid" };
		entries[entryId] = entry;
	}
	const pending: Record<string, CapturePending> = {};
	if (raw.pending !== undefined) {
		if (!isRecord(raw.pending)) return { kind: "corrupt", reason: "cursor_pending_invalid" };
		for (const [entryId, value] of Object.entries(raw.pending)) {
			const item = parsePending(value);
			if (!item || item.entryId !== entryId) return { kind: "corrupt", reason: "cursor_pending_invalid" };
			pending[entryId] = item;
		}
	}
	const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.length > 0 && raw.updatedAt.length <= 64 ? raw.updatedAt : null;
	if (!updatedAt) return { kind: "corrupt", reason: "cursor_updated_at_invalid" };
	return {
		kind: "ok",
		legacyRecords: null,
		cursor: {
			version: CAPTURE_CURSOR_VERSION,
			scope: { accountId: raw.scope.accountId, cloudInstanceId: raw.scope.cloudInstanceId, deviceId: raw.scope.deviceId },
			sessionId: expected.sessionId,
			baselineEntryId,
			entries,
			pending,
			lineagePartial: raw.lineagePartial === true,
			trackedTruncated: raw.trackedTruncated === true,
			migratedFrom: typeof raw.migratedFrom === "number" ? raw.migratedFrom : null,
			updatedAt,
		},
	};
}

function parseLegacyCursor(raw: Record<string, unknown>, expected: { scope: CaptureScopeKey; sessionId: string }): CaptureCursorParse {
	if (raw.sessionId !== expected.sessionId) return { kind: "corrupt", reason: "cursor_session_mismatch" };
	const baselineEntryId = raw.baselineEntryId;
	if (baselineEntryId !== null && (typeof baselineEntryId !== "string" || baselineEntryId.length > 256)) return { kind: "corrupt", reason: "cursor_baseline_invalid" };
	if (!isRecord(raw.entries)) return { kind: "corrupt", reason: "cursor_entries_invalid" };
	const entries: Record<string, CaptureCursorEntry> = {};
	const legacyRecords: Record<string, unknown> = {};
	for (const [entryId, value] of Object.entries(raw.entries)) {
		const entry = parseCursorEntry(value);
		if (!entry) return { kind: "corrupt", reason: "cursor_entry_invalid" };
		entries[entryId] = entry;
		if (isRecord(value) && value.record !== undefined && value.record !== null) legacyRecords[entryId] = value.record;
	}
	return {
		kind: "legacy",
		legacyRecords,
		cursor: {
			version: CAPTURE_CURSOR_VERSION,
			scope: { accountId: expected.scope.accountId, cloudInstanceId: expected.scope.cloudInstanceId, deviceId: expected.scope.deviceId },
			sessionId: expected.sessionId,
			baselineEntryId,
			entries,
			pending: {},
			lineagePartial: raw.lineagePartial === true,
			trackedTruncated: raw.trackedTruncated === true,
			migratedFrom: 1,
			updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.length <= 64 ? raw.updatedAt : new Date(0).toISOString(),
		},
	};
}

/** 最近一个已采集祖先的 sourceId（用于 parent_source_id）；最多回溯 20 跳。 */
export function resolveParentSourceId(resolved: ReadonlyMap<string, string>, byId: ReadonlyMap<string, CaptureView>, parentEntryId: string | null): string | null {
	let cursor = parentEntryId;
	for (let hop = 0; hop < 20 && cursor; hop += 1) {
		const captured = resolved.get(cursor);
		if (captured) return captured;
		const parent = byId.get(cursor);
		cursor = parent?.parentEntryId ?? null;
	}
	return null;
}

/** 原记录里的文本块（可见性事件保留原文；取不到时退回视图文本）。 */
function recordBlocks(record: unknown, view: CaptureView): readonly CaptureTextBlock[] {
	if (isRecord(record) && Array.isArray(record.textBlocks)) {
		const blocks: CaptureTextBlock[] = [];
		for (const raw of record.textBlocks) {
			if (isRecord(raw) && raw.type === "text" && typeof raw.text === "string" && raw.text.length > 0) blocks.push({ type: "text", text: raw.text });
		}
		if (blocks.length > 0) return blocks;
	}
	return view.textBlocks;
}

export type CapturePlanInput = {
	cursor: CaptureCursor;
	views: CaptureViews;
	/** 按 sourceId 读取原记录（revision 事件需要）；返回 null 表示记录不可用。 */
	readRecord: (sourceId: string) => Promise<unknown | null> | unknown | null;
	maxScanEntries?: number;
	/** 分支整体切换时间戳（换支导致的 hidden 事件用；缺失时退回条目时间戳）。 */
	branchChangedAt?: string | null;
};

export type CapturePlan = {
	actions: CaptureAction[];
	/** 需要显式上报的阻塞（记录不可用等），不是静默跳过。 */
	blocks: CapturePlanBlock[];
	truncated: boolean;
};

/**
 * 纯策略：由游标 + 当前分支视图算出要登记的动作。
 * - pending 优先：已有计划身份就按同一身份重放（同 revision/occurredAt → 同 sourceId 与 hash）；
 * - 新条目：revision 固定 1；revision 事件：revision = 上一条 + 1；
 * - 事件时间用视图的 changedAt（原生事件时间），不再用「每次观察的 now」。
 */
export async function planCapture(input: CapturePlanInput): Promise<CapturePlan> {
	const { cursor, views } = input;
	const maxScan = Math.max(1, input.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES);
	const indexOf = new Map<string, number>();
	views.views.forEach((view, index) => indexOf.set(view.entryId, index));
	const byId = new Map(views.views.map((view) => [view.entryId, view]));
	const baselineIndex = cursor.baselineEntryId === null ? -1 : (indexOf.get(cursor.baselineEntryId) ?? null);
	const newestCaptured = (() => {
		let newest = -1;
		for (const entryId of Object.keys(cursor.entries)) {
			const index = indexOf.get(entryId);
			if (typeof index === "number" && index > newest) newest = index;
		}
		return newest;
	})();
	const actions: CaptureAction[] = [];
	const blocks: CapturePlanBlock[] = [];
	let truncated = false;
	const windowStart = Math.max(0, views.views.length - maxScan);

	function inScope(index: number): boolean {
		if (cursor.baselineEntryId === null) return true;
		if (baselineIndex === null) return index > newestCaptured;
		return index > baselineIndex;
	}

	if (views.views.length > maxScan) {
		for (let index = 0; index < windowStart; index += 1) {
			const view = views.views[index];
			if (view && cursor.entries[view.entryId] === undefined && inScope(index)) {
				truncated = true;
				break;
			}
		}
	}

	/** 记录不可用时禁止生成 revision（否则会拿错内容或换 hash），显式上报。 */
	async function recordFor(captured: CaptureCursorEntry): Promise<unknown | null> {
		if (captured.recordOmitted) {
			if (!blocks.includes("record_unavailable")) blocks.push("record_unavailable");
			return null;
		}
		return await input.readRecord(captured.sourceId);
	}

	for (let index = windowStart; index < views.views.length; index += 1) {
		const view = views.views[index];
		if (!view) continue;
		const captured = cursor.entries[view.entryId];
		const pending = cursor.pending[view.entryId] ?? null;

		// 1) 有 pending：按同一身份重放（内容取当前视图；冲突由上层按 register 结果标记）。
		if (pending) {
			const previousRecord = pending.targetSourceId === null ? null : await recordFor(captured ?? { revision: 0, sourceId: pending.targetSourceId, textSha256: "", visible: true, updatedAt: "", recordOmitted: false });
			if (pending.targetSourceId !== null && previousRecord === null) continue;
			actions.push({
				kind: pending.kind,
				entryId: view.entryId,
				revision: pending.revision,
				role: view.role,
				textBlocks: pending.visibility === "hidden" ? recordBlocks(previousRecord, view) : view.textBlocks,
				visibleText: pending.visibility === "hidden" ? "" : view.visibleText,
				occurredAt: pending.occurredAt,
				completion: view.completion,
				project: view.project,
				branch: views.leafId,
				parentEntryId: pending.parentEntryId,
				parentSourceId: pending.parentSourceId,
				targetSourceId: pending.targetSourceId,
				visibility: pending.visibility,
				previousRecord,
			});
			continue;
		}

		// 2) 未采集条目：基线之后、可见且有文本块才采；首 revision 固定 1。
		if (!captured) {
			if (!inScope(index)) continue;
			if (view.visible === false) continue;
			if (view.textBlocks.length === 0) continue;
			actions.push({
				kind: "message",
				entryId: view.entryId,
				revision: 1,
				role: view.role,
				textBlocks: view.textBlocks,
				visibleText: view.visibleText,
				occurredAt: view.occurredAt,
				completion: view.completion,
				project: view.project,
				branch: views.leafId,
				parentEntryId: view.parentEntryId,
				parentSourceId: resolveParentSourceId(new Map(Object.entries(cursor.entries).map(([id, entry]) => [id, entry.sourceId])), byId, view.parentEntryId),
				targetSourceId: null,
				visibility: "visible",
				previousRecord: null,
			});
			continue;
		}

		// 3) 已采集：显式移出 → hidden；恢复可见 → 可见性（内容也变则为 message）；内容变化 → message。
		if (view.visible === false) {
			if (!captured.visible) continue;
			const previousRecord = await recordFor(captured);
			if (previousRecord === null) continue;
			actions.push({ kind: "revision", entryId: view.entryId, revision: captured.revision + 1, role: view.role, textBlocks: recordBlocks(previousRecord, view), visibleText: "", occurredAt: view.changedAt, completion: view.completion, project: view.project, branch: views.leafId, parentEntryId: view.parentEntryId, parentSourceId: null, targetSourceId: captured.sourceId, visibility: "hidden", previousRecord });
			continue;
		}
		if (view.visible === null) continue;
		const contentChanged = view.textBlocks.length > 0 && view.textSha256 !== captured.textSha256;
		if (contentChanged || !captured.visible) {
			const previousRecord = await recordFor(captured);
			if (previousRecord === null) continue;
			actions.push({
				kind: contentChanged ? "message" : "revision",
				entryId: view.entryId,
				revision: captured.revision + 1,
				role: view.role,
				textBlocks: contentChanged ? view.textBlocks : recordBlocks(previousRecord, view),
				visibleText: contentChanged ? view.visibleText : "",
				occurredAt: view.changedAt,
				completion: view.completion,
				project: view.project,
				branch: views.leafId,
				parentEntryId: view.parentEntryId,
				parentSourceId: null,
				targetSourceId: captured.sourceId,
				visibility: "visible",
				previousRecord,
			});
		}
	}

	// 4) 已采集但整条不在活动分支（换支/回退）：补 hidden 事件（不看窗口）。
	const viewIds = new Set(views.views.map((view) => view.entryId));
	for (const [entryId, captured] of Object.entries(cursor.entries)) {
		if (viewIds.has(entryId) || !captured.visible) continue;
		if (cursor.pending[entryId]) continue;
		const previousRecord = await recordFor(captured);
		if (previousRecord === null) continue;
		actions.push({ kind: "revision", entryId, revision: captured.revision + 1, role: "user", textBlocks: recordBlocks(previousRecord, views.views[0] ?? { entryId, parentEntryId: null, role: "user", textBlocks: [], visibleText: "", textSha256: "", occurredAt: "", changedAt: "", completion: "completed", visible: true, project: null }), visibleText: "", occurredAt: input.branchChangedAt ?? cursor.updatedAt, completion: "completed", project: null, branch: views.leafId, parentEntryId: null, parentSourceId: null, targetSourceId: captured.sourceId, visibility: "hidden", previousRecord });
	}

	return { actions, blocks, truncated };
}

export function pendingFromAction(action: CaptureAction): CapturePending {
	return {
		entryId: action.entryId,
		kind: action.kind,
		revision: action.revision,
		occurredAt: action.occurredAt,
		visibility: action.visibility,
		role: action.role,
		parentEntryId: action.parentEntryId,
		parentSourceId: action.parentSourceId,
		targetSourceId: action.targetSourceId,
	};
}

/** 登记成功：写条目并清 pending（成功才推进游标）。 */
export function applyCaptureSuccess(cursor: CaptureCursor, action: CaptureAction, result: { sourceId: string; revision: number; record: unknown; recordOmitted: boolean }, nowIso: string): CaptureCursor {
	const previous = cursor.entries[action.entryId];
	const nextHash = action.kind === "message" ? sha256Hex(action.visibleText) : (previous?.textSha256 ?? sha256Hex(action.visibleText));
	const pending = { ...cursor.pending };
	delete pending[action.entryId];
	return {
		...cursor,
		entries: {
			...cursor.entries,
			[action.entryId]: { revision: result.revision, sourceId: result.sourceId, textSha256: nextHash, visible: action.visibility === "visible", updatedAt: nowIso, recordOmitted: result.recordOmitted },
		},
		pending,
		updatedAt: nowIso,
	};
}

/** 登记失败/冲突：保留 pending（同身份重放），冲突时显式标记供上层上报。 */
export function markCapturePending(cursor: CaptureCursor, action: CaptureAction, nowIso: string): CaptureCursor {
	return { ...cursor, pending: { ...cursor.pending, [action.entryId]: pendingFromAction(action) }, updatedAt: nowIso };
}

export function clearCapturePending(cursor: CaptureCursor, entryId: string, nowIso: string): CaptureCursor {
	if (!cursor.pending[entryId]) return cursor;
	const pending = { ...cursor.pending };
	delete pending[entryId];
	return { ...cursor, pending, updatedAt: nowIso };
}

export function trimCaptureCursor(cursor: CaptureCursor, maxTrackedEntries: number): CaptureCursor {
	const ids = Object.keys(cursor.entries);
	if (ids.length <= maxTrackedEntries) return cursor;
	const keep = new Set(ids.slice(ids.length - maxTrackedEntries));
	const entries: Record<string, CaptureCursorEntry> = {};
	for (const [entryId, entry] of Object.entries(cursor.entries)) {
		if (keep.has(entryId)) entries[entryId] = entry;
	}
	const pending: Record<string, CapturePending> = {};
	for (const [entryId, item] of Object.entries(cursor.pending)) {
		if (entries[entryId]) pending[entryId] = item;
	}
	return { ...cursor, entries, pending, trackedTruncated: true };
}
