import type { AlignmentBrief, AlignmentPhase, AlignmentState } from "./types/alignment";

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

/** Registered commands run before pi input hooks; only our version-checked controls may bypass them. */
export function isAlignmentReadOnlyInputAllowed(message: string): boolean {
	const trimmed = message.trimStart();
	return (!trimmed.startsWith("/") && !trimmed.startsWith("!")) || /^\/align(?:\s|$)/.test(trimmed);
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
