/**
 * 待办队列纯策略（P02）：入队顺序、串行选择、确认后重映射与缓存合并。
 *
 * 为什么独立：这些规则决定「同一事项串行、旧新账号不串写、确认后不重复创建」，
 * 必须能脱离 fs/HTTP 单测；服务层只按返回结果落盘与发事件。
 *
 * 边界：
 * - 选择规则：按 itemId 分组，取每组队首；队首 not pending/unknown 时整组跳过
 *   （冲突/失败/未知未消解前，后续操作不得越过它执行）；
 * - 确认重映射：create 确认后，同 itemId 的后继操作要改为服务端 id；
 *   只有拿到可证明的 post-op revision 才自动重基线，否则保留冲突（详见 remapQueuedChain）；
 * - 缓存合并：第一页替换窗口，游标页追加去重；不按标题合并、不做「本地覆盖云端」。
 */

import type { PersonalTodo } from "../../shared/types/personalTodo";
import type { PersonalTodoQueuedOperation } from "./personalTodoStore";

/** 启动装载：进程中途死亡留下的 sending 视为未知（有尝试记录）或待传（未尝试）；
 * 非 create 操作的 expectedRevision 与 baseRevision 可能因旧版本文件不一致，一律以 baseRevision 为准。 */
export function normalizeLoadedOperations(operations: PersonalTodoQueuedOperation[]): PersonalTodoQueuedOperation[] {
	return operations.map((operation) => {
		const normalized = operation.phase === "sending" ? { ...operation, phase: operation.attempts > 0 ? ("unknown" as const) : ("pending" as const) } : operation;
		if (normalized.operation.kind === "create" || !normalized.baseRevision) return normalized;
		return withBaseRevision(normalized, normalized.baseRevision);
	});
}

/** 队首优先：每个 itemId 只返回队首操作；队首未消解（conflict/error/sending）时不返回该组。 */
export function pickEligibleOperation(operations: PersonalTodoQueuedOperation[]): PersonalTodoQueuedOperation | null {
	const seen = new Set<string>();
	for (const operation of operations) {
		if (seen.has(operation.itemId)) continue;
		seen.add(operation.itemId);
		if (operation.phase === "pending" || operation.phase === "unknown") return operation;
	}
	return null;
}

export function hasQueuedOperations(operations: PersonalTodoQueuedOperation[]): boolean {
	return operations.some((operation) => operation.phase === "pending" || operation.phase === "unknown");
}

/** 用新的 CAS 基准重写一条排队操作（队列内的 expectedRevision 也必须同步，否则重基线只改了一半）。 */
export function withBaseRevision(queued: PersonalTodoQueuedOperation, revision: string): PersonalTodoQueuedOperation {
	const operation = queued.operation;
	return { ...queued, baseRevision: revision, operation: operation.kind === "create" ? operation : { ...operation, expectedRevision: revision } };
}

export function updateOperation(operations: PersonalTodoQueuedOperation[], opId: string, patch: Partial<PersonalTodoQueuedOperation>): PersonalTodoQueuedOperation[] {
	return operations.map((operation) => (operation.opId === opId ? { ...operation, ...patch } : operation));
}

/** 放弃某个事项的全部未确认操作（冲突「采用云端」或用户丢弃草稿）。 */
export function removeOperationsForItem(operations: PersonalTodoQueuedOperation[], itemId: string): PersonalTodoQueuedOperation[] {
	return operations.filter((operation) => operation.itemId !== itemId);
}

/** 该事项的队首（用于冲突处理与草稿展示）。 */
export function headOperationForItem(operations: PersonalTodoQueuedOperation[], itemId: string): PersonalTodoQueuedOperation | null {
	return operations.find((operation) => operation.itemId === itemId) ?? null;
}

/** 该事项的未确认操作（保持入队顺序）。 */
export function operationsForItem(operations: PersonalTodoQueuedOperation[], itemId: string): PersonalTodoQueuedOperation[] {
	return operations.filter((operation) => operation.itemId === itemId);
}

export type SubtodoIdRemap = { localId: string; serverId: string } | null;

/**
 * 确认后的链重映射：create 的本地 id → 服务端 id；子项新增确认后，后续指向本地子项 id 的操作改指服务端 sub_id。
 *
 * `revision` 是「已证实的当次提交后整族 revision」：
 * - 直接 ACK（mutate 200）路径：响应里的 root revision 就是该次提交的产物，可以作证据；
 * - 回执恢复路径：只有耐久回执记录的 post-op revision 与当前云端整族 revision 相等时才算证据
 *   （相等 = 本机这次写之后无人再写）；否则传 null。
 *
 * `revision === null` 时不自动重基线：后续操作保留原 expectedRevision，由云端 409 把冲突
 * 交给用户；其中以「本地空基准」排队（离线 create 链）的操作直接标为 conflict，
 * 绝不把空/假 revision 发到云端。
 */
export type QueuedChainRemap = {
	oldItemId: string;
	newItemId: string;
	revision: string | null;
	subtodoRemap: SubtodoIdRemap;
	/** 证据不足时用于冲突展示与人工重放的当前整族 revision。 */
	conflictRevision: string;
};

export function remapQueuedChain(operations: PersonalTodoQueuedOperation[], remap: QueuedChainRemap): PersonalTodoQueuedOperation[] {
	return operations.map((operation) => {
		if (operation.itemId !== remap.oldItemId) return operation;
		const rebased: PersonalTodoQueuedOperation = remap.revision === null ? { ...operation } : withBaseRevision(operation, remap.revision);
		// 载荷里的 id 也要跟着换：只换队列项的 itemId 会让 buildMutateBody 把本地 id 发出去
		const payload = rebased.operation.kind === "create" ? rebased.operation : { ...rebased.operation, id: remap.newItemId };
		let next: PersonalTodoQueuedOperation = { ...rebased, itemId: remap.newItemId, operation: payload };
		if (remap.subtodoRemap) {
			const { localId, serverId } = remap.subtodoRemap;
			const op = next.operation;
			if ((op.kind === "subtodoPatch" || op.kind === "subtodoStatus") && op.subtodoId === localId) {
				next = { ...next, operation: { ...op, subtodoId: serverId } };
			}
		}
		// 无证据 + 本地空基准：不能把空/假 revision 发出去，标为冲突等用户比较后重放
		if (remap.revision === null && !next.baseRevision) {
			return { ...next, phase: "conflict" as const, conflictRevision: remap.conflictRevision, lastError: { code: "conflict" as const, message: "云端确认后缺少可比对的版本证据，请比较后确认" } };
		}
		return next;
	});
}

/** 兼容入口：已证实 revision 的链重映射（等价于 remapQueuedChain 且证据充分）。 */
export function rebaseQueuedOperations(operations: PersonalTodoQueuedOperation[], oldItemId: string, newItemId: string, revision: string, subtodoRemap: SubtodoIdRemap): PersonalTodoQueuedOperation[] {
	return remapQueuedChain(operations, { oldItemId, newItemId, revision, subtodoRemap, conflictRevision: revision });
}

/** 游标页合并：首页替换窗口；后续页追加去重；本地比本次列表请求更新的记录（`isNewerLocally`）不被旧快照覆盖。
 * 首页还保留服务端未返回的本地已知记录（分页窗口不因刷新而缩水；v1 不做硬删除）。 */
export function mergePageItems(existing: PersonalTodo[], page: PersonalTodo[], append: boolean, isNewerLocally?: (id: string) => boolean): PersonalTodo[] {
	const localById = new Map(existing.map((item) => [item.id, item]));
	const newer = isNewerLocally ?? (() => false);
	const merged: PersonalTodo[] = [];
	const seen = new Set<string>();
	for (const item of page) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		const local = localById.get(item.id);
		merged.push(local && newer(item.id) ? local : item);
	}
	for (const item of existing) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		merged.push(item);
	}
	if (!append) return merged;
	// 游标页：保持原窗口顺序，只把新条目/未覆盖条目补在后
	const pageById = new Map(merged.map((item) => [item.id, item]));
	const out: PersonalTodo[] = [];
	for (const item of existing) {
		out.push(pageById.get(item.id) ?? item);
		pageById.delete(item.id);
	}
	for (const item of pageById.values()) out.push(item);
	return out;
}

export function upsertItem(items: PersonalTodo[], item: PersonalTodo): PersonalTodo[] {
	const index = items.findIndex((entry) => entry.id === item.id);
	if (index < 0) return [...items, item];
	return items.map((entry) => (entry.id === item.id ? item : entry));
}

/** 云端刷新后的变化集：revision 变化或新增即变化；本地有、云端无 → 需要整表重拉。 */
export function diffItemIds(before: PersonalTodo[], after: PersonalTodo[]): { changedIds: string[]; removed: boolean } {
	const beforeMap = new Map(before.map((item) => [item.id, item.revision]));
	const changedIds: string[] = [];
	for (const item of after) {
		if (beforeMap.get(item.id) !== item.revision) changedIds.push(item.id);
	}
	const afterIds = new Set(after.map((item) => item.id));
	const removed = before.some((item) => !afterIds.has(item.id));
	return { changedIds, removed };
}

/** 退避序列：小于 base 时回到 base，否则翻倍直到 max；发送成功时由调用方重置。 */
export function nextBackoffMs(current: number, base: number, max: number): number {
	const from = Math.max(current, 0);
	if (from < base) return Math.min(base, max);
	return Math.min(from * 2, max);
}
