import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { Request, Response, RemoteSession, RemoteSnapshot } from "../../../packages/tpa-remote/src/types";
import type { DocumentWorkDomain } from "../document-work";
import { createRemoteArtifactGateway } from "./RemoteArtifactGateway";
import { ipcChannels } from "../../shared/ipc";
import { isRecord } from "../../../packages/tpa-remote/src/crypto";
import { projectRemoteMessages } from "./remoteMessageProjection";
import { createRemoteCatalogGateway } from "./RemoteCatalogGateway";
import type { AutomationStore } from "../automation/AutomationStore";
import { readRemoteHistory } from "./RemoteHistoryGateway";
import { readRemoteMessagePart } from "./RemoteMessageGateway";
import { createRemoteInteractions } from "./RemoteInteractionGateway";
import type { SessionForkCommands } from "../sessions/sessionForkCommands";

export type RemoteGateway = {
	list(): RemoteSession[];
	snapshot(sessionId: string, activate?: boolean): Promise<RemoteSnapshot>;
	execute(request: Request): Promise<Response>;
	subscribe?(listener: (sessionId: string) => void): () => void;
};

/** Network commands reuse session-domain methods; no renderer IPC or alternate Pi channel. */
export function createRemoteSessionGateway(deps: { catalog: SessionCatalog; runtime: SessionRuntimeCoordinator; agents: AgentManager; projects: ProjectStore; getDocuments: () => DocumentWorkDomain | null; getAutomations?: () => AutomationStore | null; sessionForkCommands?: SessionForkCommands }): RemoteGateway {
	const { catalog, runtime, agents, projects } = deps;
	const artifacts = createRemoteArtifactGateway(deps.getDocuments);
	const catalogs = createRemoteCatalogGateway(deps);
	const interactions = createRemoteInteractions(deps);
	let revision = 0;
	const eligible = (sessionId: string) => {
		const entry = catalog.get(sessionId);
		if (!entry || (entry.backend !== undefined && entry.backend !== "pi") || entry.noSession || entry.supersededBy) throw new Error("SESSION_UNAVAILABLE");
		return entry;
	};
	const list = (): RemoteSession[] =>
		catalog
			.listEntries()
			.filter((entry) => !entry.noSession && !entry.supersededBy && (!entry.backend || entry.backend === "pi"))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 100)
			.map((entry) => ({
				id: entry.id,
				title: entry.title,
				project: projects.get(entry.projectId)?.name ?? "",
				projectId: entry.projectId,
				projectPath: projects.get(entry.projectId)?.path,
				model: entry.model ? `${entry.model.modelName ?? entry.model.modelId} · ${entry.model.provider}` : undefined,
				thinkingLevel: entry.thinkingLevel,
				backend: "pi",
				updatedAt: entry.updatedAt,
				active: runtime.hasLiveRuntime(entry.id),
			}));
	async function snapshot(sessionId: string, activate = false): Promise<RemoteSnapshot> {
		const entry = eligible(sessionId);
		let live = runtime.getRuntimeMessages(sessionId);
		if (!live && activate) {
			// Activation performs no prompt/model call and preserves the original session identity.
			const activated = await runtime.activateRuntime(sessionId);
			if (!activated.ok) throw new Error("RUNTIME_UNAVAILABLE");
			live = runtime.getRuntimeMessages(sessionId);
		}
		let messages = live ? agents.getDisplayMessages(live.target.agentId) : [];
		if (!messages.length && entry.filePath) messages = (await agents.readSessionLoadWindow(entry.filePath, sessionId, { projectId: entry.projectId })).messages;
		const target = runtime.getTarget(sessionId);
		const tab = target ? agents.list().find((item) => item.id === target.agentId) : undefined;
		const projected = projectRemoteMessages(messages);
		return {
			sessionId,
			target,
			messages: projected,
			questions: runtime.listPendingUiRequests(sessionId).map((question) => ({ sessionId, agentId: question.agentId, runtimeGeneration: question.runtimeGeneration, requestId: question.requestId, method: question.method, title: question.title, options: question.options })),
			busy: tab?.status === "running",
			revision: ++revision,
			hasOlder: !!entry.filePath || messages.length > projected.length,
		};
	}
	async function execute(request: Request): Promise<Response> {
		const success = (result: unknown): Response => ({ kind: "response", id: request.id, ok: true, result });
		if (request.method === "sessions.list") return success(list());
		if (request.method === "projects.list") return success(catalogs.projects());
		if (request.method === "tasks.list") return success(catalogs.tasks());
		if (request.method === "tasks.create") return success(await catalogs.createTask(request));
		if (request.method === "models.list") {
			const sessionId = request.sessionId ?? list().find((item) => !request.projectId || item.projectId === request.projectId)?.id ?? list()[0]?.id;
			if (!sessionId) return success([]);
			const view = await snapshot(sessionId, true);
			return success(view.target ? await interactions.models(view.target) : []);
		}
		if (request.method === "session.create") {
			const sessionId = await catalogs.createSession(request);
			const view = await snapshot(sessionId, true);
			if (!view.target || !request.text) return success({ sessionId, accepted: false });
			await interactions.apply(view.target, request.model);
			const result = await runtime.send({ sessionId, requestId: `remote-${request.id}`, message: request.text, expectedRuntime: view.target });
			return success({ sessionId, accepted: result.accepted, ...(!result.accepted && result.delivery === "unknown" ? { unknown: true } : {}) });
		}
		if (!request.sessionId) throw new Error("INVALID_REQUEST");
		eligible(request.sessionId);
		if (request.method === "message.read") return success(await readRemoteMessagePart(deps, eligible(request.sessionId), request));
		if (request.method === "session.history") return success(await readRemoteHistory(agents, eligible(request.sessionId), request));
		if (request.method === "artifacts.list") return success(await artifacts.list(request.sessionId));
		if (request.method === "artifact.read") return success(await artifacts.read(request));
		if (request.method === "session.read") return success(await snapshot(request.sessionId, true));
		if (request.method === "session.fork" && request.target && request.entryId) return success(await interactions.fork(request.target, request.entryId));
		if (request.method === "session.send" && request.text && request.target) {
			await interactions.apply(request.target, request.model);
			const result = await runtime.send({ sessionId: request.sessionId, requestId: `remote-${request.id}`, message: request.text, expectedRuntime: request.target });
			return result.accepted ? success({ accepted: true }) : { kind: "response", id: request.id, ok: false, error: result.delivery === "unknown" ? "DELIVERY_UNKNOWN" : "SEND_REJECTED" };
		}
		if (request.method === "session.abort" && request.target) {
			const result = await runtime.abortRuntime(request.target);
			return result.ok ? success({ stopped: true }) : { kind: "response", id: request.id, ok: false, error: "RUNTIME_CHANGED" };
		}
		if (request.method === "ui.respond" && request.target && request.questionId && request.answer !== undefined) {
			await runtime.respondToUi({ ...request.target, requestId: request.questionId, response: typeof request.answer === "boolean" ? { confirmed: request.answer } : { value: request.answer } });
			return success({ answered: true });
		}
		return { kind: "response", id: request.id, ok: false, error: "NOT_SUPPORTED" };
	}
	const channels = new Set<string>([ipcChannels.agentsMessage, ipcChannels.agentsThinking, ipcChannels.agentsTextStream, ipcChannels.agentsState, ipcChannels.agentsRuntimeState, ipcChannels.agentsUiRequest]);
	const subscribe = (listener: (sessionId: string) => void) =>
		agents.onOutput((channel, payload) => {
			if (!channels.has(channel)) return;
			for (const item of Array.isArray(payload) ? payload : [payload]) {
				if (!isRecord(item)) continue;
				const agentId = typeof item.agentId === "string" ? item.agentId : typeof item.id === "string" ? item.id : undefined;
				if (!agentId) continue;
				const binding = runtime.getRuntimeBinding(agentId);
				if (!binding || (item.sessionId !== undefined && item.sessionId !== binding.sessionId) || (item.runtimeGeneration !== undefined && item.runtimeGeneration !== binding.runtimeGeneration)) continue;
				// A remote observer must never throw into the desktop's event delivery.
				try {
					listener(binding.sessionId);
				} catch {
					/* The next event or explicit resync recovers the view. */
				}
			}
		});
	return { list, snapshot, execute, subscribe };
}
