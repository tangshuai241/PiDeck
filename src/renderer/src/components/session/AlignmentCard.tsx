import { useState } from "react";
import { Check, ChevronDown, ChevronUp, FileCheck2 } from "lucide-react";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import type { SessionAlignmentControls } from "../../hooks/useSessionAlignmentControls";
import type { AlignmentPresentationKind } from "../../utils/alignmentPresentation";
import { Button } from "../ui-shadcn/button";
import { Badge } from "../ui-shadcn/badge";

const NOTICE_COPY: Record<Exclude<AlignmentPresentationKind, "ready" | "hidden">, TranslationKey> = {
	sending: "alignment.sendingNotice",
	queued: "alignment.queuedNotice",
	working: "alignment.workingNotice",
	questions: "alignment.questionsNotice",
	incomplete: "alignment.incompleteNotice",
	confirming: "alignment.confirmingNotice",
	approved: "alignment.approvedNotice",
	complete: "alignment.completeNotice",
	failed: "alignment.failedNotice",
	unknown: "alignment.unknownNotice",
	interrupted: "alignment.interruptedNotice",
	unavailable: "alignment.unavailableNotice",
};

/** Requirements are plain data; the confirmation sheet is the only full summary, not another chat renderer. */
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

/** Timeline-only surface. Running feedback stays in the existing chat pipeline: no independent spinner or draft panel. */
export function AlignmentCard(props: { controls: SessionAlignmentControls }) {
	const { state, presentation, pending, busy, controlError } = props.controls;
	const [collapsedVersion, setCollapsedVersion] = useState<string | undefined>();
	const version = `${state?.briefId}:${state?.revision}`;
	const expanded = collapsedVersion !== version;
	const { kind } = presentation;
	if (kind === "hidden") return null;
	if (kind !== "ready") {
		const resumable = kind === "incomplete" || kind === "interrupted" || kind === "failed";
		return (
			<div data-testid="alignment-card" data-phase={kind} className="space-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-caption text-muted-foreground">
				<p role="status" aria-live="polite">
					{kind === "failed" && controlError ? controlError : t(NOTICE_COPY[kind], { count: presentation.questionCount })}
				</p>
				{!busy && !pending && kind !== "approved" && kind !== "complete" && kind !== "sending" && kind !== "queued" && kind !== "unknown" && (
					<div className="flex flex-wrap gap-2">
						{resumable && (
							<Button variant="outline" size="sm" onClick={props.controls.resume}>
								{t("alignment.resume")}
							</Button>
						)}
						<Button variant="ghost" size="sm" onClick={props.controls.cancel}>
							{t("alignment.cancel")}
						</Button>
					</div>
				)}
			</div>
		);
	}
	const brief = state?.brief;
	if (!brief) return null;
	return (
		<article data-testid="alignment-card" data-phase="ready" className="w-full min-w-0 shrink-0 overflow-hidden rounded-lg border border-success/40 bg-card text-card-foreground">
			<div className="flex items-start gap-2 bg-success/10 px-3 py-3">
				<FileCheck2 size={17} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<h3 className="text-control font-medium" role="status" aria-live="polite">
						{t("alignment.readyTitle")}
					</h3>
					<p className="mt-1 text-caption text-muted-foreground">{t("alignment.readyHint")}</p>
				</div>
				<Badge variant="secondary" className="shrink-0 text-caption font-normal">
					{t("alignment.version", { revision: state?.revision ?? 0 })}
				</Badge>
			</div>
			<Button variant="ghost" size="sm" className="mx-3 mt-2 h-auto gap-1 p-0 text-caption text-muted-foreground hover:bg-transparent" aria-expanded={expanded} onClick={() => setCollapsedVersion(expanded ? version : undefined)}>
				{t(expanded ? "alignment.hideBrief" : "alignment.showBrief")}
				{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
			</Button>
			{expanded && (
				<div className="max-h-96 space-y-3 overflow-y-auto px-3 py-3">
					<BriefSection label="alignment.goal" value={brief.goal} />
					<BriefSection label="alignment.scope" value={brief.scope} />
					<BriefSection label="alignment.materials" value={brief.materials} />
					<BriefSection label="alignment.deliverable" value={brief.deliverable} />
					<BriefSection label="alignment.preserve" value={brief.preserve} />
					<BriefSection label="alignment.acceptance" value={brief.acceptance} />
				</div>
			)}
			<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-3">
				<Button variant="ghost" size="sm" onClick={props.controls.cancel}>
					{t("alignment.cancel")}
				</Button>
				<Button size="sm" onClick={props.controls.approve}>
					<Check size={14} aria-hidden="true" />
					{t("alignment.approve")}
				</Button>
			</div>
		</article>
	);
}
