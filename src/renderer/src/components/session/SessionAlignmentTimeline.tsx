import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { useSessionAlignmentControls } from "../../hooks/useSessionAlignmentControls";
import { useSessionDocumentWork } from "../../hooks/useSessionDocumentWork";
import { AlignmentCard } from "./AlignmentCard";

/**
 * One mount in the session's chat flow, shared across solo/split layouts; never a composer popup or second progress owner.
 *
 * 文稿域与对齐域在这里组合：确认动作先让文稿域冻结准备并绑定扩展，再走原来的 `/align approve`。
 * 未建立文稿工作时时序完全不变（旧对齐入口兼容）。
 */
export function SessionAlignmentTimeline(props: { sessionId: string }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const backend = record?.backend ?? "pi";
	const controls = useSessionAlignmentControls(props.sessionId, backend);
	const documentWork = useSessionDocumentWork(props.sessionId, backend);
	// 单个点击只允许一次批准：文稿路径由主进程发 `/align approve`，这里就不再发第二次。
	// 单个点击只允许一次批准：文稿路径由主进程发 `/align approve`，这里就不再发第二次；
	// `blocked` 表示明确文稿但还缺工作记录/成果目录，同样不发批准（保留输入并提示原因）。
	const approve = useCallback(async () => {
		if ((await documentWork.prepareAndStartForApproval()) !== "proceedWithAlignment") return;
		controls.approve();
	}, [documentWork, controls]);
	return <AlignmentCard controls={useMemo(() => ({ ...controls, approve }), [controls, approve])} />;
}
