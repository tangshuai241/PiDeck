import { useAtomValue } from "jotai";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { useSessionAlignmentControls } from "../../hooks/useSessionAlignmentControls";
import { AlignmentCard } from "./AlignmentCard";

/** One mount in the session's chat flow, shared across solo/split layouts; never a composer popup or second progress owner. */
export function SessionAlignmentTimeline(props: { sessionId: string }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const controls = useSessionAlignmentControls(props.sessionId, record?.backend ?? "pi");
	return <AlignmentCard controls={controls} />;
}
