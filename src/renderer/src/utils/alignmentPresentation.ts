import type { AlignmentState } from "../../../shared/types/alignment";
import { canApproveAlignment, isAlignmentActive } from "../../../shared/alignment";

/** Local delivery barrier: receipt of a message never approves or changes pi's brief. */
export type AlignmentSubmission = { requestId: string; briefId?: string; revision?: number };
export type AlignmentPresentationKind = "hidden" | "sending" | "queued" | "working" | "questions" | "incomplete" | "ready" | "confirming" | "approved" | "complete" | "failed" | "unknown" | "interrupted" | "unavailable";
export type AlignmentPresentation = { kind: AlignmentPresentationKind; canApprove: boolean; questionCount: number };

/** One policy owns both the completion heading and the approval action; drafts cannot masquerade as completed briefs. */
export function deriveAlignmentPresentation(input: { state?: AlignmentState; selected: boolean; hasRuntime: boolean; busy: boolean; pending: boolean; sending: boolean; queuedCount: number; submission?: AlignmentSubmission; sendStatus?: string; controlError?: string }): AlignmentPresentation {
	const { state } = input;
	const questionCount = state?.brief?.questions.length ?? 0;
	const result = (kind: AlignmentPresentationKind): AlignmentPresentation => ({ kind, canApprove: kind === "ready", questionCount });
	if (!input.selected && !isAlignmentActive(state) && state?.phase !== "approved" && state?.phase !== "complete") return result("hidden");
	if (state?.phase === "approved") return result(input.hasRuntime ? "approved" : "unavailable");
	if (state?.phase === "complete") return result("complete");
	if (input.pending) return result("confirming");
	if (input.controlError || input.sendStatus === "error") return result("failed");
	if (input.sendStatus === "unknown") return result("unknown");
	if (input.sending) return result("sending");
	if (input.queuedCount > 0) return result("queued");
	if (input.busy) return result("working");
	if (state?.lastStopReason === "aborted") return result("interrupted");
	if (state?.lastStopReason === "error") return result("failed");
	// Even before pi's input hook publishes a newer snapshot, a sent revision retires the old confirmation.
	const retainedDraft = state?.phase === "clarifying" && state.briefRevision !== undefined && state.briefRevision < state.revision;
	const awaitingPublication = retainedDraft || Boolean(input.submission && (!state || (state.briefId === input.submission.briefId && state.revision <= (input.submission.revision ?? -1))));
	if (awaitingPublication) return result("incomplete");
	if (canApproveAlignment(state)) return result(input.hasRuntime ? "ready" : "unavailable");
	if (questionCount > 0) return result("questions");
	if (state?.brief || input.submission) return result("incomplete");
	return result("hidden");
}
