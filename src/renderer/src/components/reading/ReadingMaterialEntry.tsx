/**
 * 阅读页「把选中原文带入会话」入口（P04）。
 *
 * 行为契约：
 * - 只把选中的原文作为一次性材料追加到明确目标会话的输入框；绝不发送、绝不调用模型；
 * - 目标会话优先取 workId+editionId 的持久绑定；没有绑定时由用户显式「新建会话并绑定」
 *   或从既有会话中选择（不静默新建、不静默替换）；
 * - 绑定指向的会话已不存在时保留选区与材料，提示重新绑定或解除绑定（stale 不自动带入）；
 * - 材料身份取自本次选区快照（work/edition/contentVersion/章节/偏移），核验档位如实保留。
 *
 * 竞态与迟到守卫全部在 `useReadingMaterialBring`：本组件只做呈现与事件转发。
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { BookPlus, Loader2 } from "lucide-react";
import { t } from "../../i18n";
import { sessionRecordsAtom, upsertSessionAtom } from "../../atoms";
import type { ReadingSelectionState } from "../../atoms/reading-atoms";
import { desktopApi as api } from "../../desktopApi";
import { useReadingMaterialBring } from "../../hooks/useReadingMaterialBring";
import { useReadingSessionBinding } from "../../hooks/useReadingSessionBinding";
import { useWorkbenchMaterial } from "../../hooks/useWorkbenchMaterial";
import { useWorkbenchSessionTargets } from "../../hooks/useWorkbenchSessionTargets";
import { Button } from "../ui-shadcn/button";
import { WorkbenchSessionPicker } from "../personal-workbench/WorkbenchSessionPicker";

export function ReadingMaterialEntry(props: {
	workId: string;
	editionId: string;
	contentVersion: string | null;
	chapterHref: string;
	chapterNum: number | null;
	workTitle?: string | null;
	editionTitle?: string | null;
	chapterTitle?: string | null;
	selection: ReadingSelectionState;
	projectId?: string;
	onOpenSession?: (projectId: string, sessionId: string) => void | Promise<void>;
}) {
	const scope = props.workId && props.editionId ? { workId: props.workId, editionId: props.editionId } : null;
	const binding = useReadingSessionBinding(scope);
	const { appendMaterial } = useWorkbenchMaterial();
	const targets = useWorkbenchSessionTargets(props.projectId);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const records = useAtomValue(sessionRecordsAtom);
	// 目录查询必须实时：async 完成回包时组件可能已用旧闭包，读 store 才能兑现「await 后当前目录核对」
	//（新建会话 registerSession 写 store 后，同一趟 getter 立即能看到）。
	const store = useStore();

	const controller = useReadingMaterialBring(
		{
			workId: props.workId,
			editionId: props.editionId,
			contentVersion: props.contentVersion,
			chapterHref: props.chapterHref,
			chapterNum: props.chapterNum,
			workTitle: props.workTitle ?? null,
			editionTitle: props.editionTitle ?? null,
			chapterTitle: props.chapterTitle ?? null,
			selection: props.selection,
			projectId: props.projectId,
		},
		{
			binding,
			appendMaterial,
			createDraft: (input) => api.sessions.createDraft(input),
			registerSession: (session) => upsertSession(session),
			readSession: (sessionId) => {
				const record = store.get(sessionRecordsAtom)[sessionId];
				return record ? { id: record.id, projectId: record.projectId } : null;
			},
			newSessionTitle: () => t("workbenchMaterial.newSessionTitle"),
		},
	);

	if (!props.selection.snapshot) return null;

	const boundSessionId = binding.state.binding?.sessionId ?? null;
	const boundTitle = boundSessionId ? (records[boundSessionId]?.title ?? boundSessionId) : null;
	const boundValid = boundSessionId !== null && binding.state.sessionExists;
	const pickedTarget = controller.picked ? targets.find((target) => target.id === controller.picked) : undefined;
	const noticeKey = controller.notice === "created" ? "workbenchMaterial.noticeCreated" : controller.notice === "duplicate" ? "workbenchMaterial.noticeDuplicate" : controller.notice === "bound" ? "workbenchMaterial.noticeBound" : "workbenchMaterial.noticeBrought";

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			{boundValid ? (
				<>
					<span className="min-w-0 truncate text-micro text-muted-foreground">{t("workbenchMaterial.boundTo", { title: boundTitle ?? "" })}</span>
					<Button variant="outline" size="sm" disabled={controller.busy} onClick={controller.bringToBound}>
						<BookPlus className="size-3.5" aria-hidden="true" />
						{t("workbenchMaterial.bringToSession")}
					</Button>
					<Button variant="ghost" size="sm" disabled={controller.busy} onClick={controller.openPicker}>
						{t("workbenchMaterial.changeSession")}
					</Button>
					<Button variant="ghost" size="sm" disabled={controller.busy} onClick={controller.unbindBound}>
						{t("workbenchMaterial.unbind")}
					</Button>
				</>
			) : (
				<Button variant="outline" size="sm" disabled={controller.busy} onClick={controller.openPicker}>
					<BookPlus className="size-3.5" aria-hidden="true" />
					{t(binding.state.stale ? "workbenchMaterial.rebind" : "workbenchMaterial.bringToSession")}
				</Button>
			)}
			{binding.state.stale && boundTitle && <span className="text-micro text-warning">{t("workbenchMaterial.stale", { title: boundTitle })}</span>}
			{controller.busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
			{controller.notice && (
				<span className="flex items-center gap-2 text-micro text-muted-foreground">
					{t(noticeKey)}
					{controller.notice === "created" && controller.createdSessionId && props.onOpenSession && (
						<Button variant="ghost" size="sm" onClick={() => void props.onOpenSession?.(props.projectId ?? "", controller.createdSessionId ?? "")}>
							{t("workbenchMaterial.openSession")}
						</Button>
					)}
				</span>
			)}
			{controller.errorKey && <span className="text-micro text-danger">{t(controller.errorKey)}</span>}
			{controller.pickerOpen && (
				<div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
					<WorkbenchSessionPicker
						targets={targets}
						value={controller.picked}
						onSelect={controller.selectTarget}
						confirmLabelKey="workbenchMaterial.confirmBindBring"
						busy={controller.busy}
						onConfirm={() => {
							if (pickedTarget) controller.bindAndBring({ sessionId: pickedTarget.id, projectId: pickedTarget.projectId });
						}}
						onCancel={controller.closePicker}
					/>
					{props.projectId && (
						<Button variant="outline" size="sm" disabled={controller.busy} onClick={controller.createAndBind}>
							{t("workbenchMaterial.newSession")}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
