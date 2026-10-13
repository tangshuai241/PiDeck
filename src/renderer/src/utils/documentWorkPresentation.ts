/**
 * 文稿卡片的呈现策略（纯函数，可直接单测）。
 *
 * 与对齐卡一样的纪律：一张卡只表达一件事，「已归档」「检查通过」「用户认可」分别是
 * 不同事实，不合并成一句「完成」。模型汇报也不进这里——它只作为成果摘要展示。
 */
import type { DocumentWorkView } from "../../../shared/types/documentWork";
import type { DocumentWorkChange, DocumentWorkPhase } from "../atoms/document-work-atoms";

export type DocumentWorkCardKind = "hidden" | "needsLocation" | "idle" | "preparing" | "dispatching" | "running" | "inspecting" | "archived" | "failed" | "unknown" | "interrupted";

export type DocumentWorkCardPresentation = {
	kind: DocumentWorkCardKind;
	/** 有可用基稿时才允许直接改稿；没有就只显示成果列表。 */
	canRevise: boolean;
	canCancel: boolean;
	/** 结果需要用户看，不能只靠动画表达。 */
	showVersions: boolean;
};

const ACTIVE_PHASES = new Set(["prepared", "dispatching", "running", "inspecting"]);

export function deriveDocumentWorkCardPresentation(input: { view: DocumentWorkView | null; pendingCreation?: { sourceTurnId: string }; phase: DocumentWorkPhase; change?: DocumentWorkChange; failure?: { code: string } }): DocumentWorkCardPresentation {
	const { view } = input;
	const active = view?.active ?? null;
	const canRevise = Boolean(view && view.versions.some((version) => version.inspection === "passed") && !active);
	if (!view) return { kind: input.pendingCreation ? "needsLocation" : "hidden", canRevise: false, canCancel: false, showVersions: false };
	if (input.phase === "creating") return { kind: "preparing", canRevise: false, canCancel: false, showVersions: false };
	if (input.phase === "preparing" || input.phase === "starting") return { kind: "preparing", canRevise: false, canCancel: false, showVersions: false };
	// 检查失败与未知分发必须显式呈现，不能因为「有成果」就显示成成功。
	if (input.failure?.code === "DISPATCH_UNKNOWN") return { kind: "unknown", canRevise, canCancel: false, showVersions: true };
	if (active) {
		if (active.phase === "failed") return { kind: "failed", canRevise: false, canCancel: false, showVersions: true };
		if (active.phase === "unknown") return { kind: "unknown", canRevise: false, canCancel: false, showVersions: true };
		if (active.phase === "interrupted") return { kind: "interrupted", canRevise: true, canCancel: false, showVersions: true };
		if (active.phase === "inspecting") return { kind: "inspecting", canRevise: false, canCancel: true, showVersions: true };
		if (active.phase === "dispatching") return { kind: "dispatching", canRevise: false, canCancel: true, showVersions: true };
		if (active.phase === "running") return { kind: "running", canRevise: false, canCancel: true, showVersions: true };
		return { kind: "preparing", canRevise: false, canCancel: true, showVersions: true };
	}
	if (input.failure) return { kind: "failed", canRevise, canCancel: false, showVersions: true };
	// 归档后的最近一次变化决定卡片文案：归档、取消、失败都要能分辨。
	if (input.change?.changeKind === "archived") return { kind: "archived", canRevise, canCancel: false, showVersions: true };
	if (input.change?.changeKind === "cancelled") return { kind: "interrupted", canRevise, canCancel: false, showVersions: true };
	if (input.change?.changeKind === "unknown") return { kind: "unknown", canRevise, canCancel: false, showVersions: true };
	if (input.change?.changeKind === "failed") return { kind: "failed", canRevise, canCancel: false, showVersions: true };
	return { kind: "idle", canRevise, canCancel: false, showVersions: view.versions.length > 0 };
}

/** 运行中的尝试与最新成果都必须可见：不能只靠一次性 toast。 */
export function isDocumentWorkActivePhase(phase: string | undefined): boolean {
	return phase !== undefined && ACTIVE_PHASES.has(phase);
}

export function formatVersionLabel(ordinal: number): string {
	return `v${String(ordinal).padStart(4, "0")}`;
}
