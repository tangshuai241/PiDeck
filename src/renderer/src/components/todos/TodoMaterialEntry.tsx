/**
 * 待办详情「带入会话」入口（P04）。
 *
 * 行为契约：
 * - 只把父项/子项的快照（todoId/subtodoId/rootRevision/source + 文本）追加到用户选定的
 *   目标会话输入框；不执行任务、不自动勾选、不发送、不调用模型；
 * - 目标会话由用户显式选择（不自动绑定、不自动新建）；
 * - 子项入口与父项共用同一选择器与追加逻辑，身份分别取自各自子项。
 */
import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import { t } from "../../i18n";
import type { PersonalTodoView } from "../../../../shared/types/personalTodo";
import { useWorkbenchMaterial } from "../../hooks/useWorkbenchMaterial";
import { useWorkbenchSessionTargets } from "../../hooks/useWorkbenchSessionTargets";
import { createTodoMaterial } from "../../utils/workbenchMaterialSession";
import { Button } from "../ui-shadcn/button";
import { WorkbenchSessionPicker } from "../personal-workbench/WorkbenchSessionPicker";

/** 父项入口：自带触发按钮与选择面板。 */
export function TodoMaterialEntry(props: { view: PersonalTodoView; projectId?: string }) {
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState<"brought" | "duplicate" | null>(null);

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<Button
				variant="ghost"
				size="sm"
				className="shrink-0"
				onClick={() => {
					setOpen((value) => !value);
					setNotice(null);
				}}
			>
				<MessagesSquare className="size-3.5" aria-hidden="true" />
				{t("workbenchMaterial.bringToSession")}
			</Button>
			{notice && <span className="text-micro text-muted-foreground">{t(notice === "duplicate" ? "workbenchMaterial.noticeDuplicate" : "workbenchMaterial.noticeBrought")}</span>}
			{open && (
				<TodoMaterialPanel
					view={props.view}
					subtodoId={null}
					projectId={props.projectId}
					onDone={(duplicate) => {
						setOpen(false);
						setNotice(duplicate ? "duplicate" : "brought");
					}}
					onCancel={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

/** 子项入口的选择面板：由子项列表持有「当前选的是哪个子项」，这里只做选择与带入。 */
export function TodoMaterialPanel(props: { view: PersonalTodoView; subtodoId: string | null; projectId?: string; onDone: (duplicate: boolean) => void; onCancel: () => void }) {
	const targets = useWorkbenchSessionTargets(props.projectId);
	const { appendMaterial } = useWorkbenchMaterial();
	const [picked, setPicked] = useState<string | null>(null);
	const [error, setError] = useState(false);

	return (
		<div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
			<WorkbenchSessionPicker
				targets={targets}
				value={picked}
				onSelect={setPicked}
				busy={false}
				onConfirm={() => {
					// 确认时必须重新在候选里找目标：会话在弹面板期间被删掉/切项目后不得继续带入
					const target = targets.find((entry) => entry.id === picked);
					const material = createTodoMaterial({ view: props.view, subtodoId: props.subtodoId });
					if (!target || !material) {
						setError(true);
						return;
					}
					const report = appendMaterial({ sessionId: target.id, material });
					setError(false);
					props.onDone(report.duplicate);
				}}
				onCancel={props.onCancel}
			/>
			{error && <span className="text-micro text-danger">{t("workbenchMaterial.errorMaterial")}</span>}
		</div>
	);
}
