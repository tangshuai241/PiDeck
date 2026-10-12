import { CheckCircle2, CircleSlash, FileStack, FolderOpen, Loader2, ShieldAlert, XCircle } from "lucide-react";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import type { SessionDocumentWorkControls } from "../../hooks/useSessionDocumentWork";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";

/** 操作状态 → 文案键；`archived` 的成败另有检查结论，不在这里混用。 */
const STATE_COPY: Record<string, TranslationKey> = {
	prepared: "documentWork.state.prepared",
	dispatching: "documentWork.state.dispatching",
	running: "documentWork.state.running",
	inspecting: "documentWork.state.inspecting",
	archived: "documentWork.state.archived",
	failed: "documentWork.state.failed",
	interrupted: "documentWork.state.interrupted",
	unknown: "documentWork.state.unknown",
};

const INSPECTION_COPY: Record<string, TranslationKey> = {
	passed: "documentWork.inspection.passed",
	failed: "documentWork.inspection.failed",
	unverified: "documentWork.inspection.unverified",
};

/** 检查结论只说明实际覆盖的内容，所以徽章旁边始终带覆盖范围。 */
export function InspectionBadge(props: { status: string; coverage: string }) {
	const copy = INSPECTION_COPY[props.status] ?? "documentWork.inspection.unverified";
	const Icon = props.status === "passed" ? CheckCircle2 : props.status === "failed" ? XCircle : ShieldAlert;
	return (
		<span className="inline-flex items-center gap-1 text-caption text-muted-foreground" title={props.coverage}>
			<Icon aria-hidden className="size-3" />
			{t(copy)}
		</span>
	);
}

/**
 * 文稿卡：会话时间线上的唯一文稿表面。
 *
 * 只呈现主进程给的有界快照（工作、操作状态、版本与检查结论），不在这里做路径拼装、
 * 不提供"自己找基稿"的入口：成果目录经系统目录选择器授权，版本由程序生成。
 */
export function DocumentWorkCard(props: { sessionId: string; controls: SessionDocumentWorkControls }) {
	const { controls } = props;
	const work = controls.snapshot?.work;
	const operation = controls.snapshot?.operation;
	const versions = controls.snapshot?.versions ?? [];
	// 没有工作记录时不占位置：普通聊天与未启用文稿的会话完全不受影响。
	if (!controls.available || !work) return null;
	const running = operation !== undefined && operation.state !== "archived" && operation.state !== "failed" && operation.state !== "interrupted" && operation.state !== "unknown";
	return (
		<div data-testid="document-work-card" data-state={operation?.state ?? "idle"} className="space-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-caption">
			<div className="flex flex-wrap items-center gap-2">
				<FileStack aria-hidden className="size-3.5 text-muted-foreground" />
				<span className="font-medium text-foreground">{t("documentWork.title")}</span>
				<Badge variant="secondary">{versions.length > 0 ? `v${String(versions[versions.length - 1].ordinal).padStart(4, "0")}` : t("documentWork.noVersion")}</Badge>
				{operation && <Badge variant="outline">{t(STATE_COPY[operation.state] ?? "documentWork.state.unknown")}</Badge>}
				{running && <Loader2 aria-hidden className="size-3 animate-spin text-muted-foreground" />}
			</div>

			<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
				<FolderOpen aria-hidden className="size-3.5" />
				<span className="break-all">{work.outputRootId && controls.snapshot?.outputRootPath ? controls.snapshot.outputRootPath : t("documentWork.needOutputFolder")}</span>
				{!running && (
					<Button type="button" size="sm" variant="outline" disabled={controls.pending} onClick={controls.chooseOutputRoot}>
						{t("documentWork.chooseOutputFolder")}
					</Button>
				)}
			</div>

			{versions.length > 0 && (
				<ul className="space-y-1">
					{versions.map((version) => (
						<li key={version.versionId} className="flex flex-wrap items-center gap-2">
							<span className="text-foreground">
								v{String(version.ordinal).padStart(4, "0")} · {version.artifacts[0]?.relativePath.split("/").pop() ?? ""}
							</span>
							<InspectionBadge status={version.inspection.status} coverage={version.inspection.channels.map((channel) => `${channel.channel}:${channel.status}`).join(" ")} />
							{version.base?.handEdited && <Badge variant="outline">{t("documentWork.handEdited")}</Badge>}
							{version.userAcceptance === "not_collected" ? null : <Badge variant="outline">{t(version.userAcceptance === "accepted" ? "documentWork.accepted" : "documentWork.rejected")}</Badge>}
						</li>
					))}
				</ul>
			)}

			{operation?.error && (
				<p role="status" aria-live="polite" className="flex items-start gap-1 text-destructive">
					<CircleSlash aria-hidden className="mt-0.5 size-3.5" />
					<span>{t("documentWork.operationFailed", { code: operation.error.code })}</span>
				</p>
			)}
			{controls.snapshot?.corrupt && (
				<p role="status" aria-live="polite" className="text-destructive">
					{t("documentWork.corruptRecord")}
				</p>
			)}
			{controls.error && (
				<p role="status" aria-live="polite" className="text-destructive">
					{controls.error}
				</p>
			)}

			{running && (
				<Button type="button" size="sm" variant="outline" disabled={controls.pending} onClick={controls.cancel}>
					{t("documentWork.cancelRound")}
				</Button>
			)}
			<p className="text-muted-foreground">{t("documentWork.footnote")}</p>
		</div>
	);
}
