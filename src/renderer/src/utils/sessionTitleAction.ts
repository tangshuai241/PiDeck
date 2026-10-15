/** Saved conversations can start their own runtime for naming; empty drafts cannot. */
import type { PiDesktopApi } from "../../../preload";
import type { AgentStatus, SessionRecord, SessionRuntimeTarget } from "../../../shared/types";

export type SessionTitleAction = "unsupported" | "empty" | "busy" | "generate" | "activate";
export function sessionTitleAction(record: Pick<SessionRecord, "backend" | "filePath" | "messageCount" | "status" | "noSession"> | undefined, runtime: { agentId?: string; status?: AgentStatus | "detached" } | undefined): SessionTitleAction {
	if (!record || (record.backend && record.backend !== "pi")) return "unsupported";
	if (runtime?.status === "running" || runtime?.status === "starting") return "busy";
	if (record.status === "draft" && !record.filePath && record.messageCount === 0) return "empty";
	if (runtime?.agentId && runtime.status === "idle") return "generate";
	return record.filePath && !record.noSession ? "activate" : "empty";
}

/** Activation never sends a user prompt. The generated name remains bound to its returned runtime. */
export async function generateTitleForSession(sessionId: string, target: SessionRuntimeTarget | undefined, api: Pick<PiDesktopApi["sessions"], "activateRuntime" | "generateTitle">, isCurrent: () => boolean) {
	let resolved = target;
	if (!resolved) {
		const activated = await api.activateRuntime(sessionId);
		if (!activated.ok || activated.value.sessionId !== sessionId || activated.value.status !== "idle") throw new Error("Title runtime unavailable");
		resolved = activated.value;
	}
	if (!isCurrent()) throw new Error("Title request superseded");
	return api.generateTitle(resolved);
}
