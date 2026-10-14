/**
 * 工作台「选择目标会话」共用小面板（P04）。
 *
 * 只做呈现与回调：候选来自 `useWorkbenchSessionTargets`，绑定/材料判定在各自 hook 与
 * 纯策略里。阅读页与待办详情共用同一个选择器，避免两处各写一套会话选择 UI。
 */
import { t, type TranslationKey } from "../../i18n";
import type { WorkbenchSessionTarget } from "../../hooks/useWorkbenchSessionTargets";
import { Button } from "../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

export function WorkbenchSessionPicker(props: { targets: readonly WorkbenchSessionTarget[]; value: string | null; onSelect: (sessionId: string) => void; onConfirm: () => void; onCancel: () => void; busy: boolean; confirmLabelKey?: TranslationKey }) {
	return (
		<div className="flex w-full flex-wrap items-center gap-2">
			<Select value={props.value ?? ""} onValueChange={props.onSelect} disabled={props.busy || props.targets.length === 0}>
				<SelectTrigger className="h-8 min-w-[200px] max-w-[360px] flex-1 text-caption">
					<SelectValue placeholder={t("workbenchMaterial.selectSession")} />
				</SelectTrigger>
				<SelectContent>
					{props.targets.map((target) => (
						<SelectItem key={target.id} value={target.id}>
							{target.title}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button size="sm" disabled={props.busy || !props.value} onClick={props.onConfirm}>
				{t(props.confirmLabelKey ?? "workbenchMaterial.confirmBring")}
			</Button>
			<Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>
				{t("workbenchMaterial.cancel")}
			</Button>
			{props.targets.length === 0 && <span className="text-micro text-muted-foreground">{t("workbenchMaterial.noSession")}</span>}
		</div>
	);
}
