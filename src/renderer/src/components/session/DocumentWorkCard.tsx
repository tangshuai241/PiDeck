import { FileText, FolderOpen, Loader2, Paperclip, ShieldAlert, Square } from "lucide-react";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import type { SessionDocumentWorkControls } from "../../hooks/useSessionDocumentWork";
import type { DocumentWorkCardKind } from "../../utils/documentWorkPresentation";
import { formatVersionLabel } from "../../utils/documentWorkPresentation";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Badge } from "../ui-shadcn/badge";

const KIND_COPY: Record<Exclude<DocumentWorkCardKind, "hidden" | "needsLocation" | "archived" | "failed" | "unknown" | "interrupted">, TranslationKey> = {
	idle: "documentWork.phase.idle",
	preparing: "documentWork.phase.preparing",
	dispatching: "documentWork.phase.dispatching",
	running: "documentWork.phase.running",
	inspecting: "documentWork.phase.inspecting",
};

const INSPECTION_COPY: Record<string, TranslationKey> = {
	passed: "documentWork.inspection.passed",
	failed: "documentWork.inspection.failed",
	unverified: "documentWork.inspection.unverified",
	pending: "documentWork.inspection.pending",
};

/**
 * 会话时间线里的文稿接口，与对齐卡共用同一个聊天流：不另开弹窗，也不自建进度条。
 *
 * 卡片只呈现主进程记录的事实：归档状态、程序检查结论和用户认可分别显示，
 * 不把「已归档」说成「已验收」。
 */
export function DocumentWorkCard(props: { controls: SessionDocumentWorkControls }) {
	const { controls } = props;
	const { presentation, view, errorMessage, materials, phase } = controls;
	if (presentation.kind === "hidden") return null;
	const busy = phase !== "idle";
	const versions = view?.versions ?? [];
	const newest = versions[0];
	return (
		<article data-testid="document-work-card" data-kind={presentation.kind} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3" aria-label={t("documentWork.title")}>
			<header className="flex flex-wrap items-center gap-2">
				<FileText size={15} aria-hidden="true" className="text-muted-foreground" />
				<h3 className="text-control font-medium text-foreground">{view?.title ?? t("documentWork.pendingTitle")}</h3>
				{presentation.kind !== "needsLocation" && <Badge variant="secondary">{t(KIND_COPY[presentation.kind as keyof typeof KIND_COPY] ?? "documentWork.phase.idle")}</Badge>}
				{busy && <Loader2 size={14} className="animate-pideck-spin text-muted-foreground" aria-hidden="true" />}
			</header>

			{presentation.kind === "needsLocation" && (
				<div className="space-y-2">
					<p className="text-caption text-muted-foreground">{t("documentWork.pendingHint")}</p>
					<Button size="sm" onClick={() => void controls.createForSession()} disabled={busy}>
						<FolderOpen size={14} aria-hidden="true" />
						{t("documentWork.chooseFolder")}
					</Button>
				</div>
			)}

			{presentation.kind === "archived" && <p className="text-caption text-muted-foreground">{t("documentWork.archivedNotice")}</p>}
			{presentation.kind === "failed" && <p className="text-caption text-danger">{errorMessage ?? t("documentWork.phase.failed")}</p>}
			{presentation.kind === "unknown" && <p className="text-caption text-warning">{errorMessage ?? t("documentWork.phase.unknown")}</p>}
			{presentation.kind === "interrupted" && <p className="text-caption text-muted-foreground">{errorMessage ?? t("documentWork.phase.interrupted")}</p>}
			{presentation.kind !== "needsLocation" && presentation.kind !== "archived" && presentation.kind !== "failed" && presentation.kind !== "unknown" && presentation.kind !== "interrupted" && (
				<p className="text-caption text-muted-foreground">{t(KIND_COPY[presentation.kind as keyof typeof KIND_COPY] ?? "documentWork.phase.idle")}</p>
			)}

			{view && (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-caption text-muted-foreground">{materials.length ? t("documentWork.materials", { names: materials.join("、") }) : t("documentWork.materialsNone")}</span>
						<Button variant="ghost" size="sm" onClick={() => void controls.chooseMaterials()} disabled={busy}>
							<Paperclip size={14} aria-hidden="true" />
							{t("documentWork.addMaterials")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => {
								void controls.registerChatMaterials().then((count) => {
									if (count === 0) showNotice(t("documentWork.registerMaterialsEmpty"));
								});
							}}
						>
							{t("documentWork.registerMaterials")}
						</Button>
					</div>
					{!versions.length && !busy && <p className="text-caption text-muted-foreground">{t("documentWork.newDocumentHint")}</p>}
				</div>
			)}

			{presentation.showVersions && versions.length > 0 && (
				<section className="space-y-1">
					<h4 className="text-caption font-medium text-muted-foreground">{t("documentWork.versions")}</h4>
					<ul className="space-y-1 text-control text-foreground">
						{versions.map((version) => (
							<li key={version.versionId} className="flex flex-wrap items-center gap-2">
								<span>{t("documentWork.versionLabel", { ordinal: formatVersionLabel(version.ordinal) })}</span>
								<span className="text-muted-foreground break-all">{version.fileName}</span>
								<Badge variant={version.inspection === "passed" ? "secondary" : "outline"}>{t(INSPECTION_COPY[version.inspection] ?? "documentWork.inspection.pending")}</Badge>
								{version.userAcceptance === "accepted" && <Badge variant="secondary">{t("documentWork.acceptanceAccepted")}</Badge>}
								{version.userAcceptance === "rejected" && <Badge variant="outline">{t("documentWork.acceptanceRejected")}</Badge>}
								{version.manualModification && <Badge variant="outline">{t("documentWork.manualModification")}</Badge>}
							</li>
						))}
					</ul>
				</section>
			)}

			{presentation.canRevise && <p className="text-caption text-muted-foreground">{t("documentWork.revisionReadyHint")}</p>}
			{newest && view?.outputRootLabel && <p className="text-caption text-muted-foreground">{t("documentWork.currentBase", { version: formatVersionLabel(newest.ordinal) })}</p>}
			{errorMessage && presentation.kind !== "failed" && presentation.kind !== "unknown" && (
				<p className="flex items-center gap-1 text-caption text-danger">
					<ShieldAlert size={14} aria-hidden="true" />
					{errorMessage}
				</p>
			)}

			{presentation.canCancel && (
				<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2">
					<span className="text-caption text-muted-foreground">{t("documentWork.cancelHint")}</span>
					<Button variant="ghost" size="sm" onClick={() => void controls.cancelActive()} disabled={busy}>
						<Square size={14} aria-hidden="true" />
						{t("documentWork.cancel")}
					</Button>
				</div>
			)}
		</article>
	);
}
