import type { AgentBackend } from "./types/agent";

/** Runtime choices exclude retired backends; their tags remain readable in historical records. */
export function isActiveAgentBackend(value: unknown): value is Exclude<AgentBackend, "acp"> {
	return value === "pi" || value === "dsh" || value === "imagegen" || value === "videogen";
}

/** Legacy default preferences fall back to Pi without changing historical session identities. */
export function normalizeDefaultAgentBackend(value: unknown): Exclude<AgentBackend, "acp"> {
	return isActiveAgentBackend(value) ? value : "pi";
}
