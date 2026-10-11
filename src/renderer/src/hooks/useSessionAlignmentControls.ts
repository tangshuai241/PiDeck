import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect } from "react";
import type { AgentBackend, ComposerAgentMode, SessionRuntimeTarget } from "../../../shared/types";
import { isAlignmentActive } from "../../../shared/alignment";
import { sessionComposerModeBySessionIdAtomFamily, setSessionComposerModeAtom } from "../atoms/composer-atoms";
import { alignmentControlPendingAtomFamily } from "../atoms/alignment-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { alignmentActionCommand, alignmentModeCommands, sameAlignmentRuntime } from "../utils/alignmentControls";
import { isSessionRuntimeBusy } from "./useSessionTimelineController";

/** Owns the optional alignment flow without moving domain logic into App or the composer view. */
export function useSessionAlignmentControls(sessionId: string, backend: AgentBackend = "pi") {
	const store = useStore();
	const runtimeAtom = sessionRuntimeBySessionIdAtomFamily(sessionId);
	const modeAtom = sessionComposerModeBySessionIdAtomFamily(sessionId);
	const pendingAtom = alignmentControlPendingAtomFamily(sessionId);
	const runtime = useAtomValue(runtimeAtom);
	const mode = useAtomValue(modeAtom);
	const pending = useAtomValue(pendingAtom);
	const state = backend === "pi" ? (runtime?.state?.alignment ?? undefined) : undefined;
	const busy = isSessionRuntimeBusy(runtime?.status, runtime?.state);

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
		async (commands: string[], nextMode?: ComposerAgentMode) => {
			const current = store.get(runtimeAtom);
			if (store.get(pendingAtom) || isSessionRuntimeBusy(current?.status, current?.state)) {
				showNotice(t("alignment.busy"));
				return;
			}
			const expectedRuntime = targetNow();
			if (!expectedRuntime) {
				if (commands.length) showNotice(t("alignment.unavailable"));
				else if (nextMode) store.set(setSessionComposerModeAtom, { sessionId, mode: nextMode });
				return;
			}
			store.set(pendingAtom, true);
			try {
				for (const message of commands) {
					if (!sameAlignmentRuntime(expectedRuntime, targetNow())) throw new Error(t("alignment.runtimeChanged"));
					const result = await desktopApi.sessions.sendPrompt({ sessionId, requestId: crypto.randomUUID(), message, expectedRuntime });
					if (!result.accepted) throw new Error(result.error);
				}
				if (nextMode && sameAlignmentRuntime(expectedRuntime, targetNow())) store.set(setSessionComposerModeAtom, { sessionId, mode: nextMode });
			} catch (error) {
				showNotice(t("alignment.actionFailed", { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				store.set(pendingAtom, false);
			}
		},
		[sessionId, runtimeAtom, pendingAtom, modeAtom, targetNow, store],
	);

	const changeMode = useCallback(
		(next: ComposerAgentMode, currentMode: ComposerAgentMode): boolean => {
			if (next !== "alignment" && currentMode !== "alignment") return false;
			if (backend !== "pi") {
				showNotice(t("alignment.unavailable"));
				return true;
			}
			const target = targetNow();
			if (!target) store.set(setSessionComposerModeAtom, { sessionId, mode: next });
			else void dispatch(alignmentModeCommands(currentMode, next, true), next);
			return true;
		},
		[sessionId, backend, targetNow, modeAtom, dispatch, store],
	);

	const act = useCallback(
		(action: "approve" | "revise") => {
			if (backend !== "pi") {
				showNotice(t("alignment.unavailable"));
				return;
			}
			const current = store.get(runtimeAtom)?.state?.alignment ?? undefined;
			const command = alignmentActionCommand(action, state, current);
			if (!command) {
				showNotice(t("alignment.requirementsChanged"));
				return;
			}
			void dispatch([command], action === "approve" ? "normal" : "alignment");
		},
		[backend, state, runtimeAtom, dispatch, store],
	);

	return {
		state,
		selected: backend === "pi" && mode === "alignment",
		pending,
		busy,
		changeMode,
		approve: () => act("approve"),
		revise: () => act("revise"),
		cancel: () => changeMode("normal", "alignment"),
	};
}

export type SessionAlignmentControls = ReturnType<typeof useSessionAlignmentControls>;
