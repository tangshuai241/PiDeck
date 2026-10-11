import type { AlignmentState, ComposerAgentMode, SessionRuntimeTarget } from "../../../shared/types";
import { buildAlignmentCommand } from "../../../shared/alignment";

/** Leaving another automation mode must restore its tools before alignment captures them. */
export function alignmentModeCommands(from: ComposerAgentMode, to: ComposerAgentMode, hasRuntime: boolean): string[] {
	if (!hasRuntime) return [];
	if (to === "alignment") {
		return [...(from === "plan" ? ["/plan off"] : from === "goal" ? ["/goal pause"] : []), "/align on"];
	}
	return from === "alignment" ? ["/align off"] : [];
}

/** A click on an older card must not silently approve the current, different requirements. */
export function alignmentActionCommand(action: "approve" | "revise", rendered: AlignmentState | undefined, current: AlignmentState | undefined): string | undefined {
	if (!rendered || !current || rendered.briefId !== current.briefId || rendered.revision !== current.revision || rendered.phase !== current.phase) return undefined;
	return buildAlignmentCommand(action, current);
}

export function sameAlignmentRuntime(left: SessionRuntimeTarget | undefined, right: SessionRuntimeTarget | undefined): boolean {
	return Boolean(left && right && left.sessionId === right.sessionId && left.agentId === right.agentId && left.runtimeGeneration === right.runtimeGeneration);
}
