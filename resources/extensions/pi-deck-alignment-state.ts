/** Bounded wire snapshots and validation for the branch-scoped alignment runtime. */
export const ALIGNMENT_STATE_TYPE = "pi-deck-alignment-state";
export const ALIGNMENT_SNAPSHOT_TYPE = "pi-deck-alignment-snapshot";
export const ALIGNMENT_MARKER = "__PI_DECK_ALIGNMENT_MODE__";

export interface AlignmentBrief {
	goal: string;
	scope: string[];
	materials: string[];
	deliverable: string;
	preserve: string[];
	acceptance: string[];
	questions: string[];
}

export interface AlignmentState {
	schemaVersion: 1;
	briefId: string;
	revision: number;
	phase: "clarifying" | "ready" | "approved" | "cancelled" | "complete";
	brief?: AlignmentBrief;
}

/** External session data is unknown until every field has passed the same bounds as tool input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit = 4000): value is string {
	return typeof value === "string" && value.length <= limit;
}

function boundedList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 40 && value.every((item: unknown) => boundedText(item, 2000));
}

/** Copy validated data, rejecting extra fields so the model cannot smuggle an approval action. */
export function decodeBrief(value: unknown): AlignmentBrief | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => !["goal", "scope", "materials", "deliverable", "preserve", "acceptance", "questions"].includes(key))) return;
	if (!boundedText(value.goal) || !boundedText(value.deliverable)) return;
	if (!boundedList(value.scope) || !boundedList(value.materials) || !boundedList(value.preserve) || !boundedList(value.acceptance) || !boundedList(value.questions)) return;
	if (value.goal.length + value.deliverable.length + [value.scope, value.materials, value.preserve, value.acceptance, value.questions].flat().reduce((size, item) => size + item.length, 0) > 48000) return;
	return { goal: value.goal, scope: [...value.scope], materials: [...value.materials], deliverable: value.deliverable, preserve: [...value.preserve], acceptance: [...value.acceptance], questions: [...value.questions] };
}

/** Placeholder prose is not an actionable goal, deliverable, or acceptance criterion. */
function meaningful(text: string): boolean {
	const normalized = text.trim();
	return normalized.length >= 2 && /[\p{L}\p{N}]/u.test(normalized) && !/^(?:tbd|todo|unknown|n\/?a|none|待定|未知|无|待补充|未确定|\?+)\.?$/i.test(normalized);
}

export function briefIsReady(brief: AlignmentBrief): boolean {
	return brief.questions.length === 0 && meaningful(brief.goal) && meaningful(brief.deliverable) && brief.acceptance.some(meaningful);
}

/** Reject malformed latest snapshots rather than falling back to an older approval. */
export function decodeAlignment(value: unknown): AlignmentState | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.briefId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.briefId)) return;
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) return;
	const phase = value.phase;
	if (phase !== "clarifying" && phase !== "ready" && phase !== "approved" && phase !== "cancelled" && phase !== "complete") return;
	const brief = value.brief === undefined ? undefined : decodeBrief(value.brief);
	if (value.brief !== undefined && !brief) return;
	if ((phase === "ready" || phase === "approved") && (!brief || !briefIsReady(brief))) return;
	return { schemaVersion: 1, briefId: value.briefId, revision: value.revision, phase, ...(brief ? { brief } : {}) };
}

/** Tool restoration accepts only a bounded list; a corrupt loadout restores no capabilities. */
export function decodeTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 1024 || !value.every((name: unknown) => typeof name === "string" && name.length > 0 && name.length <= 512)) return;
	return [...new Set<string>(value)];
}
