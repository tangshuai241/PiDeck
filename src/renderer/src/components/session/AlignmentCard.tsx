import { ChevronDown, ChevronUp, MessageSquareText } from "lucide-react";
import { canApproveAlignment, isAlignmentActive } from "../../../../shared/alignment";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import type { SessionAlignmentControls } from "../../hooks/useSessionAlignmentControls";
import { Button } from "../ui-shadcn/button";
import { Badge } from "../ui-shadcn/badge";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";

/** Plain text is intentional: requirements are data, not trusted HTML or a second Markdown engine. */
function BriefSection(props: { label: TranslationKey; value: string | string[] }) {
	const items = typeof props.value === "string" ? [props.value] : props.value;
	if (!items.length) return null;
	return (
		<section className="space-y-1">
			<h4 className="text-caption font-medium text-muted-foreground">{t(props.label)}</h4>
			<ul className="space-y-1 text-control text-foreground">
				{items.map((item, index) => (
					<li key={index} className="whitespace-pre-wrap break-words">
						{item}
					</li>
				))}
			</ul>
		</section>
	);
}

/** Uses the existing measured widget stack, theme tokens and shadcn controls. */
export function AlignmentCard(props: { controls: SessionAlignmentControls }) {
	const { state, selected, busy, pending } = props.controls;
	const { collapsed, setCollapsed } = useComposerWidgetCollapsed(`alignment:${state?.briefId ?? "draft"}`, false);
	const active = isAlignmentActive(state);
	if (!selected && !active && state?.phase !== "approved") return null;
	const disabled = busy || pending;
	const brief = state?.brief;
	const status = state?.phase === "approved" ? "alignment.approved" : state?.phase === "ready" ? "alignment.ready" : "alignment.clarifying";
	return (
		<ComposerWidgetFrame>
			<div data-testid="alignment-card" data-phase={state?.phase ?? "draft"} className="w-full shrink-0 overflow-hidden text-card-foreground">
				<div className="flex items-center gap-2 px-3 py-2">
					<Button variant="ghost" size="sm" className="h-auto min-w-0 flex-1 justify-start gap-2 p-0 text-control font-medium hover:bg-transparent" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
						<MessageSquareText size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="truncate">{t("alignment.title")}</span>
						{collapsed ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronUp size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
					</Button>
					<Badge variant="secondary" className="shrink-0 text-caption font-normal" aria-live="polite">
						{t(status)}
					</Badge>
				</div>
				{!collapsed && (
					<div className="space-y-3 border-t border-border px-3 py-3">
						<p className="text-caption text-muted-foreground">{t(state?.phase === "approved" ? "alignment.approvedHint" : brief ? "alignment.reviewHint" : "alignment.startHint")}</p>
						{brief && (
							<div className="max-h-56 space-y-3 overflow-y-auto pr-1">
								<BriefSection label="alignment.goal" value={brief.goal} />
								<BriefSection label="alignment.scope" value={brief.scope} />
								<BriefSection label="alignment.materials" value={brief.materials} />
								<BriefSection label="alignment.deliverable" value={brief.deliverable} />
								<BriefSection label="alignment.preserve" value={brief.preserve} />
								<BriefSection label="alignment.acceptance" value={brief.acceptance} />
								<BriefSection label="alignment.questions" value={brief.questions} />
							</div>
						)}
					</div>
				)}
				{state?.phase !== "approved" && (
					<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
						<Button variant="ghost" size="sm" disabled={disabled} onClick={props.controls.cancel}>
							{t("alignment.cancel")}
						</Button>
						{brief && (
							<Button variant="outline" size="sm" disabled={disabled || !active} onClick={props.controls.revise}>
								{t("alignment.revise")}
							</Button>
						)}
						{brief && (
							<Button size="sm" disabled={disabled || !canApproveAlignment(state)} onClick={props.controls.approve} title={brief.questions.length ? t("alignment.questionsBlock") : undefined}>
								{t("alignment.approve")}
							</Button>
						)}
					</div>
				)}
			</div>
		</ComposerWidgetFrame>
	);
}
