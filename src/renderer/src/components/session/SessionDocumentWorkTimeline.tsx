import { useAtomValue } from "jotai";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { useSessionDocumentWork } from "../../hooks/useSessionDocumentWork";
import { DocumentWorkCard } from "./DocumentWorkCard";

/** One mount in the session's chat flow, shared across solo/split layouts; never a composer popup. */
export function SessionDocumentWorkTimeline(props: { sessionId: string }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const controls = useSessionDocumentWork(props.sessionId, record?.backend ?? "pi");
	return <DocumentWorkCard controls={controls} />;
}
