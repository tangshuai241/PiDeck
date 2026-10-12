import { useAtomValue } from "jotai";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { useSessionAlignmentControls } from "../../hooks/useSessionAlignmentControls";
import { useSessionDocumentWork } from "../../hooks/useSessionDocumentWork";
import { AlignmentCard } from "./AlignmentCard";
import { DocumentWorkCard } from "./DocumentWorkCard";

/**
 * 会话聊天流里的唯一确认/文稿挂载点（solo/split 共用，不做 composer 弹层，
 * 也不另立一个进度 owner）。
 *
 * 两张卡共用一个会话级 owner：对齐卡负责"这一版要求能不能确认"，文稿卡负责
 * "这一轮做出来的东西归到哪、检查结果是什么"。批准动作先经文稿域的准备与分发，
 * 失败就不进入执行（`beforeApprove` 返回 false 时不发 `/align approve`）。
 */
export function SessionAlignmentTimeline(props: { sessionId: string }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const backend = record?.backend ?? "pi";
	const documentWork = useSessionDocumentWork(props.sessionId, backend);
	const controls = useSessionAlignmentControls(props.sessionId, backend, documentWork);
	return (
		<>
			<DocumentWorkCard sessionId={props.sessionId} controls={documentWork} />
			<AlignmentCard controls={controls} />
		</>
	);
}
