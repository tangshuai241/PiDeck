/** Explicit rename orchestration; bind both generation and persistence to the original runtime. */
import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionRuntimeTarget } from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { sessionTitleErrorCode } from "../../shared/sessionTitleErrors";
import { getAppLogger } from "../logging/sharedLogger";

function validTarget(value: unknown): value is SessionRuntimeTarget {
	if (typeof value !== "object" || value === null) return false;
	return "sessionId" in value && typeof value.sessionId === "string" && value.sessionId.length <= 160 && "agentId" in value && typeof value.agentId === "string" && value.agentId.length <= 160 && "runtimeGeneration" in value && Number.isSafeInteger(value.runtimeGeneration) && Number(value.runtimeGeneration) >= 0;
}
export function registerSessionTitleIpc(ipc: IpcMain, deps: { sessionCatalog: SessionCatalog; sessionRuntimeCoordinator: SessionRuntimeCoordinator; agentManager: AgentManager }): { invalidate(sessionId: string): void } {
	const pending = new Map<string, symbol>();
	ipc.handle(ipcChannels.sessionsGenerateTitle, async (_event, target: unknown) => {
		if (!validTarget(target)) return { ok: false };
		const { sessionCatalog: catalog, sessionRuntimeCoordinator: coordinator, agentManager } = deps;
		const entry = catalog.get(target.sessionId);
		if (!entry || (entry.backend && entry.backend !== "pi") || !coordinator.validateTarget(target).ok || pending.has(target.sessionId)) return { ok: false };
		const beforeTitle = entry.title;
		const request = Symbol();
		pending.set(target.sessionId, request);
		const isCurrent = () => pending.get(target.sessionId) === request && coordinator.validateTarget(target).ok;
		try {
			const title = await agentManager.generateSessionTitle(target.agentId);
			if (!isCurrent() || catalog.get(target.sessionId)?.title !== beforeTitle) return { ok: false };
			await catalog.claimTitleOwnership(target.sessionId);
			if (!isCurrent() || catalog.get(target.sessionId)?.title !== beforeTitle) return { ok: false };
			const renamed = await coordinator.renameRuntime(target, title);
			if (!renamed.ok || !isCurrent()) return { ok: false };
			const record = await catalog.update(target.sessionId, { title });
			return { ok: true, record };
		} catch (error) {
			const code = sessionTitleErrorCode(error instanceof Error ? error.message : undefined);
			void getAppLogger()?.warn("session-title", "Title generation failed", { sessionId: target.sessionId, code });
			return { ok: false, error: code };
		} finally {
			pending.delete(target.sessionId);
		}
	});
	// A desktop manual rename invalidates immediately, before either persistence or native RPC yields.
	return {
		invalidate(sessionId) {
			if (pending.has(sessionId)) pending.set(sessionId, Symbol());
		},
	};
}
