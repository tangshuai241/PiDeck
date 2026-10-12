import type { AlignmentBrief, AlignmentPhase, AlignmentState } from "./types/alignment";
import { DOCUMENT_WORK_BIND_COMMAND, DOCUMENT_WORK_ID_MAX_LENGTH } from "./types/documentWork";
import { decodeBindingPayload } from "./documentWork";

export const ALIGNMENT_MESSAGE_TYPE = "pi-deck-alignment-state";
export const PI_DECK_ALIGNMENT_MODE_MARKER = "__PI_DECK_ALIGNMENT_MODE__";

/** Treat extension output as untrusted input, including when restoring old sessions. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown): value is string {
	return typeof value === "string" && value.length <= 4000;
}

function isBoundedList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 40 && value.every((item) => typeof item === "string" && item.length <= 2000);
}

function parseBrief(value: unknown): AlignmentBrief | undefined {
	if (!isRecord(value) || !isBoundedText(value.goal) || !isBoundedText(value.deliverable)) return undefined;
	if (!isBoundedList(value.scope) || !isBoundedList(value.materials) || !isBoundedList(value.preserve) || !isBoundedList(value.acceptance) || !isBoundedList(value.questions)) return undefined;
	const lists = [value.scope, value.materials, value.preserve, value.acceptance, value.questions];
	if (value.goal.length + value.deliverable.length + lists.flat().reduce((size, item) => size + item.length, 0) > 48000) return undefined;
	return { goal: value.goal, scope: [...value.scope], materials: [...value.materials], deliverable: value.deliverable, preserve: [...value.preserve], acceptance: [...value.acceptance], questions: [...value.questions] };
}

function parsePhase(value: unknown): AlignmentPhase | undefined {
	if (value === "clarifying" || value === "ready" || value === "approved" || value === "cancelled" || value === "complete") return value;
	return undefined;
}

/** Invalid or future snapshots fail closed instead of reviving a stale approval. */
export function parseAlignmentState(value: unknown): AlignmentState | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.briefId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.briefId)) return undefined;
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) return undefined;
	const phase = parsePhase(value.phase);
	if (!phase) return undefined;
	const brief = value.brief === undefined ? undefined : parseBrief(value.brief);
	if (value.brief !== undefined && !brief) return undefined;
	if (phase === "ready" || phase === "approved") {
		if (!brief?.goal.trim() || !brief.deliverable.trim() || !brief.acceptance.some((item) => item.trim()) || brief.questions.length) return undefined;
	}
	const briefRevision = value.briefRevision;
	if (briefRevision !== undefined && (!brief || typeof briefRevision !== "number" || !Number.isSafeInteger(briefRevision) || briefRevision < 0 || briefRevision > value.revision)) return undefined;
	if (briefRevision !== undefined && (phase === "ready" || phase === "approved") && briefRevision !== value.revision) return undefined;
	const lastStopReason = value.lastStopReason;
	if (lastStopReason !== undefined && lastStopReason !== "aborted" && lastStopReason !== "error") return undefined;
	return { schemaVersion: 1, briefId: value.briefId, revision: value.revision, phase, ...(brief ? { brief } : {}), ...(briefRevision !== undefined ? { briefRevision } : {}), ...(lastStopReason ? { lastStopReason } : {}) };
}

/** Only the runtime's custom state message is authoritative; a tool cannot approve itself. */
export function latestAlignmentStateFromMessages(messages: readonly unknown[]): AlignmentState | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "custom" || message.customType !== ALIGNMENT_MESSAGE_TYPE) continue;
		return isRecord(message.details) ? parseAlignmentState(message.details.alignment) : undefined;
	}
	return undefined;
}

/** 绑定载荷里的身份是最小可验证集；完整绑定形态由扩展自己校验，宿主只查不能放错会话的字段。 */
export type DocumentWorkBindingIdentity = { sessionId: string; nativeSessionId: string };

/**
 * 绑定载荷的身份字段：与当前 runtime 快照比对后才允许转发。
 * 返回声明的身份，缺字段或形态不对就返回 undefined（不转发）。
 */
export function documentWorkBindingIdentity(payload: Record<string, unknown>): DocumentWorkBindingIdentity | undefined {
	const { workId, attemptId, preparationId, digest, kind, sessionId, nativeSessionId } = payload;
	if (payload.schemaVersion !== 1) return undefined;
	for (const id of [workId, attemptId, preparationId]) if (typeof id !== "string" || id.length === 0 || id.length > DOCUMENT_WORK_ID_MAX_LENGTH) return undefined;
	// 摘要绑定本轮准备；扩展与主进程各自用同一份 64 位小写十六进制形态。
	if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
	if (kind !== "create_document" && kind !== "revise_document") return undefined;
	// 稳定会话 id 与 pi 原生会话 id 是两套身份，两处都必须有且要被宿主逐项比对。
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) return undefined;
	if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0 || nativeSessionId.length > 200) return undefined;
	return { sessionId, nativeSessionId };
}

/** 对齐期间允许透传的 TPA 元数据控制：只落元数据，不带任何执行权限。 */
export type DocumentWorkMetadataControl = { action: "bind"; payload: Record<string, unknown> } | { action: "release" | "unbind" | "status" };

/**
 * 解析 `/tpa-work` 元数据控制的精确语法。
 *
 * 允许透传的理由：它们只把本轮准备写进扩展状态（bind）或把结束/查询落成会话元数据
 * （release/unbind/status），不恢复工具、不触发模型回合、不放行批准、不写成果文件。
 * 因此对齐期间的「只读输入」例外必须把它们算进来，否则主进程自己的绑定在真实链路上
 * 走不通（真实验收：bind/release 都被这里的守卫挡成了 RUNTIME_CHANGED）。
 * 反过来，语法不精确（多余参数、未知动作、载荷不合法/超长）一律返回 undefined：
 * 调用方必须拒绝，不得当成普通模型提示转发。
 */
export function parseDocumentWorkMetadataControl(message: string): DocumentWorkMetadataControl | undefined {
	const tokens = message.trim().split(/[ \t]+/);
	if (tokens[0] !== DOCUMENT_WORK_BIND_COMMAND) return undefined;
	const action = tokens[1];
	if (action === "release" || action === "unbind" || action === "status") return tokens.length === 2 ? { action } : undefined;
	if (action !== "bind" || tokens.length !== 3) return undefined;
	const encoded = tokens[2] ?? "";
	const payload = decodeBindingPayload(encoded);
	return payload ? { action: "bind", payload } : undefined;
}

/**
 * 命令名级匹配：用于「扩展在不在」的预检，避免把载荷当普通提示交给模型。
 *
 * 必须比严格语法更宽：命令名后面接任何非命令名字符（空格、制表、换行、NBSP、控制字符…）都
 * 算「这是文稿命令」，交给 `parseDocumentWorkMetadataControl` 去拒。若只看空格/制表，
 * `/tpa-work\nstatus` 这种形态在普通（非对齐）模式下会绕过可用性预检，扩展缺位时被当成
 * 普通提示发给模型。命令名继续按 pi 的口径判定：后面跟 `-`/`_`/字母数字（如 `/tpa-work-x`）
 * 是另一个命令名，不算命中。
 */
export function isDocumentWorkMetadataCommandName(message: string): boolean {
	return /^\/tpa-work(?![\w-])/.test(message.trim());
}

/** Registered commands run before pi input hooks; only our version-checked controls may bypass them. */
export function isAlignmentReadOnlyInputAllowed(message: string): boolean {
	const trimmed = message.trimStart();
	if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return true;
	if (/^\/align(?:\s|$)/.test(trimmed)) return true;
	// 文稿元数据控制只落元数据：与 /align 同级放行，其余斜杠/执行命令维持原策略。
	return parseDocumentWorkMetadataControl(trimmed) !== undefined;
}

export function isAlignmentActive(state: AlignmentState | undefined): boolean {
	return state?.phase === "clarifying" || state?.phase === "ready";
}

export function canApproveAlignment(state: AlignmentState | undefined): boolean {
	return state?.phase === "ready" && !state.lastStopReason && (state.briefRevision === undefined || state.briefRevision === state.revision) && Boolean(state.brief && state.brief.questions.length === 0);
}

/** Matches /align approve|revise <briefId> <revision> exactly; ids are [a-zA-Z0-9_-]{1,80}. */
const ALIGNMENT_COMMAND_RE = /^\/align (?:(?:approve|revise) [a-zA-Z0-9_-]{1,80} (?:0|[1-9]\d*)|on|off|clear)$/;

export function isAlignmentControlCommand(message: string): boolean {
	return ALIGNMENT_COMMAND_RE.test(message.trim());
}

/** Commands carry the version visible to the user; the extension checks it again. */
export function buildAlignmentCommand(action: "approve" | "revise", state: AlignmentState): string | undefined {
	if (action === "approve" ? !canApproveAlignment(state) : !isAlignmentActive(state)) return undefined;
	return `/align ${action} ${state.briefId} ${state.revision}`;
}
