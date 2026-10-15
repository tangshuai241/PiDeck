/** Explicit generation is scoped by stable session id and the exact active runtime. */
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomFamily } from "jotai/utils";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, upsertSessionAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { generateTitleForSession, sessionTitleAction } from "../utils/sessionTitleAction";
import { sessionTitleErrorCode } from "../../../shared/sessionTitleErrors";

const titleErrorCopy = {
	TITLE_EXTENSION_UNAVAILABLE: "session.titleErrorExtension",
	TITLE_MODEL_UNAVAILABLE: "session.titleErrorModel",
	TITLE_AUTH_UNAVAILABLE: "session.titleErrorAuth",
	TITLE_PROVIDER_ERROR: "session.titleErrorProvider",
	TITLE_TIMEOUT: "session.titleErrorTimeout",
	TITLE_INVALID_RESULT: "session.titleErrorResult",
	TITLE_RUNTIME_CHANGED: "session.titleErrorChanged",
	TITLE_FAILED: "session.generateTitleFailed",
} as const;

const generatingTitleAtomFamily = atomFamily((_sessionId: string) => atom(false));
export function useGenerateSessionTitle(sessionId: string) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const [busy, setBusy] = useAtom(generatingTitleAtomFamily(sessionId));
	const upsert = useSetAtom(upsertSessionAtom);
	const store = useStore();
	const action = sessionTitleAction(record, runtime);
	const supported = action !== "unsupported";
	const available = action === "generate" || action === "activate";
	const generate = async () => {
		// IPC events can update the store before React commits a new click handler.
		const clickedRecord = store.get(sessionRecordByIdAtomFamily(sessionId));
		const clickedRuntime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
		const clickedAction = sessionTitleAction(clickedRecord, clickedRuntime);
		if (store.get(generatingTitleAtomFamily(sessionId)) || !clickedRecord || (clickedAction !== "generate" && clickedAction !== "activate")) return;
		setBusy(true);
		try {
			const target = clickedAction === "generate" && clickedRuntime?.agentId ? { sessionId, agentId: clickedRuntime.agentId, runtimeGeneration: clickedRuntime.runtimeGeneration } : undefined;
			const result = await generateTitleForSession(sessionId, target, desktopApi.sessions, () => {
				const current = store.get(sessionRecordByIdAtomFamily(sessionId));
				// A manual edit or removed session while startup is pending supersedes this click.
				return current?.title === clickedRecord.title && current?.filePath === clickedRecord.filePath;
			});
			if (!result.ok || !result.record) {
				showNotice(t(titleErrorCopy[sessionTitleErrorCode(result.error)]));
				return;
			}
			upsert(result.record);
		} catch {
			showNotice(t("session.generateTitleFailed"));
		} finally {
			setBusy(false);
		}
	};
	return { busy, available, supported, action, generate };
}
