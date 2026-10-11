import { atom, type createStore } from "jotai";
import type { AlignmentSubmission } from "../utils/alignmentPresentation";
import { sessionRuntimeByIdAtom } from "./session-atoms";
import { atomFamily } from "jotai/utils";

/** One in-flight alignment control per session, including split views of the same session. */
export const alignmentControlPendingAtomFamily = atomFamily((_sessionId: string) => atom(false));
export type AlignmentControlFailure = { message: string; agentId: string; runtimeGeneration: number; briefId?: string; revision?: number };
export const alignmentControlErrorAtomFamily = atomFamily((_sessionId: string) => atom<AlignmentControlFailure | undefined>(undefined));
export const alignmentSubmissionAtomFamily = atomFamily((_sessionId: string) => atom<AlignmentSubmission | undefined>(undefined));
export const alignmentQueuedCountAtomFamily = atomFamily((_sessionId: string) => atom(0));

/** Invalidate the visible confirmation synchronously at submission, before optimistic UI or RPC events. */
export function beginAlignmentSubmission(store: ReturnType<typeof createStore>, sessionId: string, requestId: string): void {
	const alignment = store.get(sessionRuntimeByIdAtom)[sessionId]?.state?.alignment;
	store.set(alignmentSubmissionAtomFamily(sessionId), { requestId, briefId: alignment?.briefId, revision: alignment?.revision });
	store.set(alignmentControlErrorAtomFamily(sessionId), undefined);
}
