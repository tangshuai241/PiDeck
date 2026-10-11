import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect } from "react";
import type { AgentBackend, ComposerAgentMode, SessionRuntimeTarget } from "../../../shared/types";
import { isAlignmentActive } from "../../../shared/alignment";
import { sessionComposerModeBySessionIdAtomFamily, sessionSendStateBySessionIdAtomFamily, setSessionSendStateAtom, setSessionComposerModeAtom } from "../atoms/composer-atoms";
import { alignmentControlPendingAtomFamily, alignmentControlErrorAtomFamily, alignmentSubmissionAtomFamily, alignmentQueuedCountAtomFamily, beginAlignmentSubmission, type AlignmentControlFailure } from "../atoms/alignment-atoms";
import { bindSessionRuntimeAtom, type SessionRuntimeViewState } from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { buildComposerPromptSubmission } from "../composerBehavior";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { alignmentActionCommand, alignmentModeCommands, sameAlignmentRuntime } from "../utils/alignmentControls";
import { deriveAlignmentPresentation } from "../utils/alignmentPresentation";
import { waitForAlignmentAcknowledgement } from "../utils/alignmentAcknowledgement";
import { isSessionRuntimeBusy } from "./useSessionTimelineController";

/** An old request's failure must not poison a replacement runtime or a newly published brief. */
function currentFailure(failure: AlignmentControlFailure | undefined, runtime: SessionRuntimeViewState | undefined): string | undefined {
	return failure && failure.agentId === runtime?.agentId && failure.runtimeGeneration === runtime.runtimeGeneration && failure.briefId === runtime.state?.alignment?.briefId && failure.revision === runtime.state?.alignment?.revision ? failure.message : undefined;
}

/** Session-scoped owner shared by composer mode controls and the single timeline confirmation surface. */
export function useSessionAlignmentControls(sessionId: string, backend: AgentBackend = "pi") {
	const store = useStore();
	const runtimeAtom = sessionRuntimeBySessionIdAtomFamily(sessionId);
	const modeAtom = sessionComposerModeBySessionIdAtomFamily(sessionId);
	const pendingAtom = alignmentControlPendingAtomFamily(sessionId);
	const errorAtom = alignmentControlErrorAtomFamily(sessionId);
	const submissionAtom = alignmentSubmissionAtomFamily(sessionId);
	const sendAtom = sessionSendStateBySessionIdAtomFamily(sessionId);
	const queueAtom = alignmentQueuedCountAtomFamily(sessionId);
	const runtime = useAtomValue(runtimeAtom);
	const mode = useAtomValue(modeAtom);
	const pending = useAtomValue(pendingAtom);
	const failure = useAtomValue(errorAtom);
	const controlError = currentFailure(failure, runtime);
	const submission = useAtomValue(submissionAtom);
	const sendState = useAtomValue(sendAtom);
	const queuedCount = useAtomValue(queueAtom);
	const state = backend === "pi" ? (runtime?.state?.alignment ?? undefined) : undefined;
	const busy = isSessionRuntimeBusy(runtime?.status, runtime?.state) || runtime?.state?.isCompacting === true;
	const selected = backend === "pi" && mode === "alignment";
	const presentationNow = useCallback(() => {
		const current = store.get(runtimeAtom);
		const send = store.get(sendAtom);
		return deriveAlignmentPresentation({
			state: backend === "pi" ? (current?.state?.alignment ?? undefined) : undefined,
			selected: backend === "pi" && store.get(modeAtom) === "alignment",
			hasRuntime: Boolean(current?.agentId),
			busy: isSessionRuntimeBusy(current?.status, current?.state) || current?.state?.isCompacting === true,
			pending: store.get(pendingAtom),
			sending: send?.status === "activating" || send?.status === "sending",
			sendStatus: send?.status,
			queuedCount: store.get(queueAtom),
			submission: store.get(submissionAtom),
			controlError: currentFailure(store.get(errorAtom), current),
		});
	}, [backend, store, runtimeAtom, modeAtom, pendingAtom, sendAtom, queueAtom, submissionAtom, errorAtom]);
	const presentation = deriveAlignmentPresentation({ state, selected, hasRuntime: Boolean(runtime?.agentId), busy, pending, sending: sendState?.status === "activating" || sendState?.status === "sending", sendStatus: sendState?.status, queuedCount, submission, controlError });

	useEffect(() => {
		if (!state) return;
		if (isAlignmentActive(state)) store.set(setSessionComposerModeAtom, { sessionId, mode: "alignment" });
		else if (store.get(modeAtom) === "alignment") store.set(setSessionComposerModeAtom, { sessionId, mode: "normal" });
	}, [sessionId, state?.briefId, state?.revision, state?.phase, modeAtom, store]);

	const targetNow = useCallback((): SessionRuntimeTarget | undefined => {
		const current = store.get(runtimeAtom);
		return current?.agentId ? { sessionId, agentId: current.agentId, runtimeGeneration: current.runtimeGeneration } : undefined;
	}, [sessionId, runtimeAtom, store]);

	const dispatch = useCallback(
		async (commands: string[], nextMode?: ComposerAgentMode, resume = false) => {
			const current = store.get(runtimeAtom);
			const send = store.get(sendAtom);
			if (store.get(pendingAtom) || isSessionRuntimeBusy(current?.status, current?.state) || current?.state?.isCompacting || store.get(queueAtom) > 0 || send?.status === "sending" || send?.status === "activating") {
				showNotice(t("alignment.busy"));
				return;
			}
			const expectedRuntime = targetNow();
			if (!expectedRuntime) {
				if (commands.length) showNotice(t("alignment.unavailable"));
				else if (nextMode) store.set(setSessionComposerModeAtom, { sessionId, mode: nextMode });
				return;
			}
			const expectedBrief = current?.state?.alignment;
			let resumeRequestId: string | undefined;
			const maySettleResume = () => resume && sameAlignmentRuntime(expectedRuntime, targetNow()) && store.get(sendAtom)?.requestId === resumeRequestId;
			store.set(pendingAtom, true);
			store.set(errorAtom, undefined);
			try {
				for (const message of commands) {
					if (!sameAlignmentRuntime(expectedRuntime, targetNow())) throw new Error("runtimeChanged");
					const requestId = crypto.randomUUID();
					if (resume) {
						resumeRequestId = requestId;
						beginAlignmentSubmission(store, sessionId, requestId);
						store.set(setSessionSendStateAtom, { sessionId, state: { status: "sending", requestId } });
					}
					const submission = resume ? buildComposerPromptSubmission(message, "alignment") : { message };
					const result = await desktopApi.sessions.sendPrompt({ sessionId, requestId, ...submission, expectedRuntime });
					if (!result.accepted) throw new Error(result.error);
					if (maySettleResume()) {
						// Ordinary message delivery owns chat progress; mode commands must never start it.
						store.set(bindSessionRuntimeAtom, { ...expectedRuntime, status: "running" });
						store.set(setSessionSendStateAtom, { sessionId, state: { status: "idle" } });
					}
					// An alignment transition must be acknowledged before a following mode command is sent.
					if (!resume && message.startsWith("/align")) {
						await waitForAlignmentAcknowledgement({
							read: () => store.get(runtimeAtom)?.state?.alignment ?? undefined,
							isCurrent: () => sameAlignmentRuntime(expectedRuntime, targetNow()),
							subscribe: (changed) => store.sub(runtimeAtom, changed),
							matches: (latest) =>
								message.startsWith("/align approve")
									? latest.briefId === expectedBrief?.briefId && latest.revision === expectedBrief.revision && (latest.phase === "approved" || latest.phase === "complete")
									: message === "/align off"
										? latest.phase === "cancelled" || latest.phase === "complete"
										: isAlignmentActive(latest),
						});
					}
				}
				if (nextMode && sameAlignmentRuntime(expectedRuntime, targetNow())) store.set(setSessionComposerModeAtom, { sessionId, mode: nextMode });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const message = reason === "notAcknowledged" ? t("alignment.notAcknowledged") : reason === "runtimeChanged" ? t("alignment.runtimeChanged") : t("alignment.actionFailed", { error: reason });
				if (maySettleResume()) store.set(setSessionSendStateAtom, { sessionId, state: { status: "error", requestId: resumeRequestId, error: message } });
				store.set(errorAtom, { ...expectedRuntime, message, briefId: expectedBrief?.briefId, revision: expectedBrief?.revision });
				showNotice(message);
			} finally {
				store.set(pendingAtom, false);
			}
		},
		[sessionId, runtimeAtom, pendingAtom, errorAtom, sendAtom, queueAtom, targetNow, store],
	);

	const changeMode = useCallback(
		(next: ComposerAgentMode, currentMode: ComposerAgentMode): boolean => {
			if (next !== "alignment" && currentMode !== "alignment") return false;
			if (backend !== "pi") {
				showNotice(t("alignment.unavailable"));
				return true;
			}
			if (!targetNow()) {
				store.set(setSessionComposerModeAtom, { sessionId, mode: next });
				store.set(errorAtom, undefined);
			} else void dispatch(alignmentModeCommands(currentMode, next, true), next);
			return true;
		},
		[sessionId, backend, targetNow, dispatch, errorAtom, store],
	);
	const approve = useCallback(() => {
		if (backend !== "pi") {
			showNotice(t("alignment.unavailable"));
			return;
		}
		const current = store.get(runtimeAtom)?.state?.alignment ?? undefined;
		const command = alignmentActionCommand("approve", state, current);
		if (!command) {
			showNotice(t("alignment.requirementsChanged"));
			return;
		}
		if (!presentationNow().canApprove) {
			showNotice(t("alignment.busy"));
			return;
		}
		void dispatch([command], "normal");
	}, [backend, state, runtimeAtom, presentationNow, dispatch, store]);
	const resume = useCallback(() => {
		if (backend !== "pi") return;
		void dispatch([t("alignment.resumeRequest")], undefined, true);
	}, [backend, dispatch]);

	return { state, selected, pending, busy, controlError, presentation, changeMode, approve, resume, cancel: () => changeMode("normal", "alignment") };
}
export type SessionAlignmentControls = ReturnType<typeof useSessionAlignmentControls>;
