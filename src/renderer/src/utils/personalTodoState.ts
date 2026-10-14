/**
 * 待办的展示与动作规则（纯函数）：同步状态映射、错误码映射、完成动作的父子约束、草稿去留。
 *
 * 这些规则同时决定「界面上写什么」和「什么操作不许发出去」，写进组件会让两侧各有一份判断。
 * 主进程仍是权威：这里的父子约束只是提前挡住明显不合法的操作并给出人话原因，
 * 云端 `SUBTODO_INCOMPLETE` / `REVISION_CONFLICT` 之类的拒绝仍然如实呈现（见 personalTodoErrorKey）。
 */
import type { PersonalTodoErrorCode, PersonalTodoErrorInfo, PersonalTodoLinkedTask, PersonalTodoStatus, PersonalTodoSubmitResult, PersonalTodoSubtask, PersonalTodoSyncPhase } from "../../../shared/types/personalTodo";
import type { TranslationKey } from "../i18n";

/** 同步徽标色调：synced 用中性色，进行中用信息色，冲突/未知/失败用告警色。 */
export type PersonalTodoSyncTone = "muted" | "info" | "warning" | "danger";

export type PersonalTodoSyncBadge = { key: TranslationKey; tone: PersonalTodoSyncTone };

/**
 * 同步阶段 → 徽标。只有 `synced` 才算云端已确认；`pending`（已入队未发出）、`sending`、
 * `unknown`、`error`、`conflict` 一律显示未确认状态，界面不得提前显示「已保存」。
 */
export function personalTodoSyncBadge(phase: PersonalTodoSyncPhase): PersonalTodoSyncBadge {
	switch (phase) {
		case "synced":
			return { key: "personalTodo.syncSynced", tone: "muted" };
		case "sending":
			return { key: "personalTodo.syncSending", tone: "info" };
		case "conflict":
			return { key: "personalTodo.syncConflict", tone: "warning" };
		case "unknown":
			return { key: "personalTodo.syncUnknown", tone: "warning" };
		case "error":
			return { key: "personalTodo.syncError", tone: "danger" };
		case "pending":
		default:
			// 运行期遇到未来新增阶段时不假装已保存，按待确认展示
			return { key: "personalTodo.syncPending", tone: "info" };
	}
}

/** 结构化错误码 → 文案 key（契约里的 code，界面不落到 message 兜底文本上）。 */
export function personalTodoErrorKey(code: PersonalTodoErrorCode): TranslationKey {
	switch (code) {
		case "notConnected":
			return "personalTodo.errorNotConnected";
		case "invalidInput":
			return "personalTodo.errorInvalidInput";
		case "offline":
			return "personalTodo.errorOffline";
		case "writeFailed":
			return "personalTodo.errorWriteFailed";
		case "cloudRejected":
			return "personalTodo.errorCloudRejected";
		case "conflict":
			return "personalTodo.errorConflict";
		case "unknownOutcome":
			return "personalTodo.errorUnknownOutcome";
		case "writeUnavailable":
			return "personalTodo.errorWriteUnavailable";
		case "unsupported":
			return "personalTodo.errorUnsupported";
		case "staleAccount":
			return "personalTodo.errorStaleAccount";
		case "internalError":
		default:
			return "personalTodo.errorInternalError";
	}
}

/** 有错误就给出可展示的 key；无错误返回 null（调用方据此决定是否渲染提示）。 */
export function personalTodoErrorInfoKey(error: PersonalTodoErrorInfo | null | undefined): TranslationKey | null {
	return error ? personalTodoErrorKey(error.code) : null;
}

/** 事项状态 → 文案 key。cancelled 是云端已有状态，界面照实显示，不做隐藏也不自动删除。 */
export function personalTodoStatusKey(status: PersonalTodoStatus): TranslationKey {
	switch (status) {
		case "done":
			return "personalTodo.statusDone";
		case "cancelled":
			return "personalTodo.statusCancelled";
		case "open":
		default:
			return "personalTodo.statusOpen";
	}
}

export type PersonalTodoStatusDecision = { kind: "allowed" } | { kind: "blocked"; reasonKey: TranslationKey };

/**
 * 待写入的状态是否允许：根项置 done 前检查未完成子项（open）。
 *
 * 与云端 `SUBTODO_INCOMPLETE`（409）同规则；子项状态变更不经过这里——
 * 子项完成永远不会连带完成父项，父项状态只由用户对父项的显式操作或云端推送决定。
 */
export function resolvePersonalTodoStatusDecision(input: { status: PersonalTodoStatus; subtodos: readonly PersonalTodoSubtask[] }): PersonalTodoStatusDecision {
	if (input.status !== "done") return { kind: "allowed" };
	if (input.subtodos.some((subtodo) => subtodo.status === "open")) return { kind: "blocked", reasonKey: "personalTodo.subtodoBlockedComplete" };
	return { kind: "allowed" };
}

/** 完成/重新打开的目标状态：done → open，其余 → done。 */
export function personalTodoToggleTarget(status: PersonalTodoStatus): PersonalTodoStatus {
	return status === "done" ? "open" : "done";
}

/**
 * 提交受理后的界面草稿去留：失败/冲突一律保留用户输入，只有受理成功才把输入交给主进程队列。
 * 受理成功时主进程已耐久入队并会在视图里带上 draft，此时清掉界面缓冲不会丢输入。
 */
export type PersonalTodoDraftDisposition = "keep" | "clear";

export function personalTodoSubmitDraftDisposition(result: PersonalTodoSubmitResult): PersonalTodoDraftDisposition {
	return result.ok ? "clear" : "keep";
}

/** 冲突界面需要并列两份内容：本人草稿与云端最新版本都在时才算完整冲突。 */
export function personalTodoConflictSides(view: { confirmed: unknown | null; draft: unknown | null }): { mineAvailable: boolean; cloudAvailable: boolean } {
	return { mineAvailable: view.draft !== null, cloudAvailable: view.confirmed !== null };
}

/** 关联任务展示：缺失（false）与未核验（null）必须说清，不能静默省略。 */
export function personalTodoLinkedTaskKey(task: PersonalTodoLinkedTask): TranslationKey {
	if (task.available === false) return "personalTodo.linkedTaskMissing";
	if (task.available === null) return "personalTodo.linkedTaskUnverified";
	return "personalTodo.linkedTask";
}

/** 云端写入开关的界面提示：不可用时说明原因，可用时不占位。 */
export function personalTodoWriteNoticeKey(write: { available: boolean; reason: string | null } | null | undefined): TranslationKey | null {
	if (!write || write.available) return null;
	return write.reason === null ? "personalTodo.writeUnavailableGeneric" : "personalTodo.writeUnavailableReason";
}

export type PersonalTodoWindowState = "loading" | "rows" | "empty-window" | "empty";

/**
 * 列表窗口状态。区分「已加载窗口里没有匹配」与「确实没有」：
 * 筛选由主进程在已取回的窗口内完成，还有下一页时「本页无匹配」不代表 «不存在»，
 * 界面必须继续给加载入口并明确已加载范围，不能把未加载当成没有。
 */
export function resolvePersonalTodoWindowState(input: { itemCount: number; hasMore: boolean; loading: boolean }): PersonalTodoWindowState {
	if (input.itemCount > 0) return "rows";
	if (input.loading) return "loading";
	return input.hasMore ? "empty-window" : "empty";
}
