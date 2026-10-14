/**
 * pi-deck-cloud-memory-sync-bridge —— 采集动作 → SyncRecord → D 的持久队列（唯一接线点）。
 *
 * 为什么单列：capture 模块不认识 D 的类型（保持可离线测试），wrapper 只做装配；
 * 这里集中使用 D 的**公开** identity/outbox API（createSyncRecord / advanceSyncRevision /
 * parseSyncRecord / createSyncOutbox().open().register），不复制它的哈希与编号逻辑，
 * 也不建第二套队列。失败一律返回 `{ ok: false, reason }`，由采集侧决定不推进游标。
 */

import type { CaptureAction, CaptureRegisterResult } from "./pi-deck-cloud-memory-capture";
import { advanceSyncRevision, createSyncRecord, parseSyncRecord } from "./pi-deck-cloud-memory-sync-identity";
import { createSyncOutbox } from "./pi-deck-cloud-memory-sync-outbox";
import type { SyncIdentity, SyncOutbox, SyncQueue, SyncRecord } from "./pi-deck-cloud-memory-sync-types";

/** 队列 scope：绑定账号 + 云端实例 + 设备，切账号不混用同一目录。 */
export type CaptureScope = {
	accountId: string;
	cloudInstanceId: string;
	deviceId: string;
	stateDir: string;
	sessionId: string;
};

export type CaptureRegistrar = {
	register(scope: CaptureScope, action: CaptureAction): Promise<CaptureRegisterResult>;
	/** 同一 scope 的队列句柄（sender 必须复用这个实例，不建第二套队列）。 */
	queue(scope: CaptureScope): Promise<SyncQueue>;
};

export function createCaptureRegistrar(): CaptureRegistrar {
	const outboxByStateDir = new Map<string, SyncOutbox>();
	const queueByScope = new Map<string, Promise<SyncQueue>>();

	async function ensureQueue(scope: CaptureScope): Promise<SyncQueue> {
		let outbox = outboxByStateDir.get(scope.stateDir);
		if (!outbox) {
			outbox = createSyncOutbox({ stateDir: scope.stateDir });
			outboxByStateDir.set(scope.stateDir, outbox);
		}
		const key = `${scope.stateDir}|${scope.accountId}|${scope.cloudInstanceId}|${scope.deviceId}`;
		let queue = queueByScope.get(key);
		if (!queue) {
			queue = outbox.open({ accountId: scope.accountId, cloudInstanceId: scope.cloudInstanceId, deviceId: scope.deviceId });
			queueByScope.set(key, queue);
		}
		return await queue;
	}

	return {
		queue: (scope) => ensureQueue(scope),

		async register(scope, action) {
			const previous = action.previousRecord === null ? null : parseSyncRecord(action.previousRecord);
			if (action.previousRecord !== null && !previous) return { ok: false, reason: "previous_record_invalid" };
			const identity: SyncIdentity = {
				accountId: scope.accountId,
				cloudInstanceId: scope.cloudInstanceId,
				deviceId: scope.deviceId,
				sessionId: scope.sessionId,
				entryId: action.entryId,
				revision: action.revision,
			};
			let record: SyncRecord;
			try {
				if (action.kind === "message") {
					record = previous
						? advanceSyncRevision(previous, { kind: "message", occurredAt: action.occurredAt, content: action.textBlocks, completion: action.completion, project: action.project, branch: action.branch })
						: createSyncRecord({ kind: "message", identity, role: action.role, content: action.textBlocks, project: action.project, parentSourceId: action.parentSourceId, targetSourceId: null, branch: action.branch, occurredAt: action.occurredAt, completion: action.completion, visibility: "visible" });
				} else {
					if (!previous) return { ok: false, reason: "previous_record_missing" };
					record = advanceSyncRevision(previous, { kind: "visibility", occurredAt: action.occurredAt, visibility: action.visibility, project: action.project, branch: action.branch, completion: action.completion });
				}
			} catch {
				return { ok: false, reason: "record_build_failed" };
			}
			try {
				const queue = await ensureQueue(scope);
				const result = await queue.register(record);
				// 同身份异内容必须显式冲突，不静默覆盖（采集侧据此不推进游标）。
				if (result.status === "conflict") return { ok: false, reason: "content_conflict", existingSourceId: result.sourceId };
				return { ok: true, sourceId: result.sourceId, revision: record.identity.revision, record };
			} catch {
				return { ok: false, reason: "outbox_unavailable" };
			}
		},
	};
}
