/**
 * 待办账号运行时的共享形状与结构化错误（Service 与队列 Runner 共用）。
 *
 * 为什么独立：Runtime 是「一个账号的缓存 + 队列 + 台账 + 写可用性」的内存视图，服务与
 * 后台发送器都要读写它；错误分类也必须在两处保持一致（同一失败不能被一处当未知、一处当失败）。
 *
 * 边界：本模块不 import electron/fs/HTTP，只放类型与纯函数；凭据不在 Runtime 里（令牌按需从 seam 取）。
 */

import type { PersonalTodoAccountScope, PersonalTodoErrorInfo, PersonalTodoSyncSummary, PersonalTodoWriteStatus } from "../../shared/types/personalTodo";
import type { CloudMemoryErrorInfo } from "../../shared/types/cloudMemory";
import type { CloudMemoryAuthSnapshot } from "../cloudMemory/cloudMemoryAuthSeam";
import type { PersonalTodoPaths } from "./personalTodoAccount";
import type { PersonalTodoAccountStore, PersonalTodoCacheFile, PersonalTodoLedgerFile, PersonalTodoOutboxFile, PersonalTodoStoreIssue } from "./personalTodoStore";
import type { PersonalTodoTransportFailure } from "./personalTodoTransport";

/** 单个云端账号的运行时（缓存/队列/台账按 accountKey 分目录；切换账号即换 Runtime）。 */
export type PersonalTodoAccountRuntime = {
	scope: PersonalTodoAccountScope;
	authSnapshot: CloudMemoryAuthSnapshot;
	paths: PersonalTodoPaths;
	store: PersonalTodoAccountStore;
	cache: PersonalTodoCacheFile;
	outbox: PersonalTodoOutboxFile;
	ledger: PersonalTodoLedgerFile;
	write: PersonalTodoWriteStatus;
	supported: boolean;
	lastError: PersonalTodoErrorInfo | null;
	lastRefreshAttemptAt: number;
	/** 本地写入序号：列表请求开始后本地确认过的记录不被该请求的旧快照覆盖。 */
	nextItemWriteSeq: number;
	itemWriteSeq: Map<string, number>;
	/** 装载时发现的文件损坏事实（隔离失败时继续禁止写该文件）；成功写回后清除。 */
	storeIssues: Map<"cache" | "outbox" | "ledger", PersonalTodoStoreIssue>;
};

export function emptyWriteStatus(): PersonalTodoWriteStatus {
	return { available: true, reason: null, verified: false };
}

export function emptySummary(): PersonalTodoSyncSummary {
	return { pending: 0, sending: 0, conflict: 0, unknown: 0, error: 0, confirmedRecent: 0 };
}

export function notConnectedError(): PersonalTodoErrorInfo {
	return { code: "notConnected", message: "尚未连接云端账号" };
}

/** `stale` 语义：身份已切换，结果作废（不得显示为用户可见错误）。 */
export function staleAccountError(): PersonalTodoErrorInfo {
	return { code: "staleAccount", message: "云端账号已切换，本次结果作废" };
}

export function writeFailedError(message: string): PersonalTodoErrorInfo {
	return { code: "writeFailed", message };
}

export function internalError(message: string): PersonalTodoErrorInfo {
	return { code: "internalError", message };
}

export function conflictError(current: string, message: string): PersonalTodoErrorInfo {
	return { code: "conflict", message, detail: { current } };
}

export function cloudRejected(message: string, detail?: PersonalTodoErrorInfo["detail"]): PersonalTodoErrorInfo {
	return detail ? { code: "cloudRejected", message, detail } : { code: "cloudRejected", message };
}

export function invalidInput(message: string, field: string): PersonalTodoErrorInfo {
	return { code: "invalidInput", message, detail: { field } };
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
	if (!limit || !Number.isInteger(limit)) return fallback;
	return Math.min(Math.max(limit, 1), max);
}

/** 云端记忆错误 → 待办错误（凭据类失败一律归 notConnected，界面提示重新连接）。 */
export function mapAuthError(error: CloudMemoryErrorInfo): PersonalTodoErrorInfo {
	if (error.code === "offline") return { code: "offline", message: "云端不可达" };
	if (error.code === "unauthorized" || error.code === "notConfigured" || error.code === "secureStorageUnavailable" || error.code === "principalMismatch" || error.code === "scopeMissing") {
		return { code: "notConnected", message: error.message, detail: { cloudCode: error.code } };
	}
	return { code: "internalError", message: error.message, detail: { cloudCode: error.code } };
}

export function transportFailureToError(failure: PersonalTodoTransportFailure): PersonalTodoErrorInfo {
	return failure.detail ? { code: failure.code, message: failure.message, detail: failure.detail } : { code: failure.code, message: failure.message };
}
