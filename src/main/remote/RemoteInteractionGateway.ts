import type { AgentManager } from "../pi/AgentManager";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { SessionForkCommands } from "../sessions/sessionForkCommands";
import type { ModelChoice, RuntimeTarget } from "../../../packages/tpa-remote/src/types";
import { parseModels } from "../../../packages/tpa-remote/src/models";

type Deps = { catalog: SessionCatalog; runtime: SessionRuntimeCoordinator; agents: AgentManager; sessionForkCommands?: SessionForkCommands };
const expectedErrors = new Set(["MODEL_BUSY", "MODEL_UNAVAILABLE", "RUNTIME_CHANGED", "FORK_UNAVAILABLE", "FORK_BUSY"]);
/** Known rejections occur before prompt delivery and must not become uncertain receipts. */
export function interactionError(error: unknown): string | undefined {
	return error instanceof Error && expectedErrors.has(error.message) ? error.message : undefined;
}

/** Mobile controls use the same Pi runtime/model/fork commands as the desktop. */
export function createRemoteInteractions(deps: Deps) {
	async function models(target: RuntimeTarget) {
		const result = await deps.runtime.listRuntimeModels(target);
		if (!result.ok) throw new Error("RUNTIME_CHANGED");
		return parseModels(result.value.value.slice(0, 2000));
	}
	async function apply(target: RuntimeTarget, choice?: ModelChoice) {
		if (!choice) return;
		if (!deps.runtime.validateTarget(target).ok) throw new Error("RUNTIME_CHANGED");
		const existing = deps.catalog.get(target.sessionId)?.model;
		const same = existing?.provider === choice.provider && existing.modelId === choice.modelId;
		if (deps.agents.list().find((item) => item.id === target.agentId)?.status === "running" && !same) throw new Error("MODEL_BUSY");
		const available = await models(target);
		const chosen = available.find((item) => item.provider === choice.provider && item.id === choice.modelId);
		if (!chosen) throw new Error("MODEL_UNAVAILABLE");
		// Listing models crosses an async boundary: the desktop may have started a turn or restarted Pi.
		if (!deps.runtime.validateTarget(target).ok) throw new Error("RUNTIME_CHANGED");
		if (deps.agents.list().find((item) => item.id === target.agentId)?.status === "running") {
			if (!same) throw new Error("MODEL_BUSY");
			return;
		}
		const result = await deps.runtime.setRuntimeModel(target, chosen.provider, chosen.id, chosen.name);
		if (!result.ok || result.value.value.provider !== chosen.provider || result.value.value.modelId !== chosen.id) throw new Error("MODEL_UNAVAILABLE");
	}
	async function fork(target: RuntimeTarget, entryId: string) {
		if (!deps.sessionForkCommands || !deps.runtime.validateTarget(target).ok) throw new Error("FORK_UNAVAILABLE");
		if (deps.agents.list().find((item) => item.id === target.agentId)?.status === "running") throw new Error("FORK_BUSY");
		const anchors = await deps.runtime.getRuntimeForkMessages(target);
		if (!anchors.ok || !anchors.value.value.some((item) => item.entryId === entryId)) throw new Error("FORK_UNAVAILABLE");
		const result = await deps.sessionForkCommands.forkRuntimeSession(target, entryId, { branchMode: true });
		if (!result.ok || !result.value.targetSessionId) throw new Error("FORK_UNAVAILABLE");
		return { sessionId: result.value.targetSessionId, text: result.value.text ?? "" };
	}
	return { models, apply, fork };
}
