import type { AutomationStore } from "../automation/AutomationStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { ProjectStore } from "../projects/ProjectStore";
import type { Request, RemoteProject, RemoteTask } from "../../../packages/tpa-remote/src/types";

/** Reuse desktop catalogs and scheduler storage; remote clients never own a parallel task ledger. */
export function createRemoteCatalogGateway(deps: { catalog: SessionCatalog; projects: ProjectStore; getAutomations?: () => AutomationStore | null }) {
	const projects = (): RemoteProject[] =>
		deps.projects
			.list()
			.slice(0, 200)
			.map((project) => ({ id: project.id, name: project.name, path: project.path }));
	const tasks = (): RemoteTask[] =>
		(deps.getAutomations?.()?.getSnapshot().tasks ?? [])
			.slice(0, 200)
			.map((task) => ({ id: task.id, name: task.name, projectId: task.projectId, prompt: task.prompt.slice(0, 200), schedule: task.schedule.type === "manual" ? "manual" : task.schedule.expression, enabled: task.enabled, ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}) }));
	async function createSession(request: Request): Promise<string> {
		const project = request.projectId ? deps.projects.get(request.projectId) : undefined;
		if (!project) throw new Error("PROJECT_UNAVAILABLE");
		const previous = deps.catalog
			.listEntries()
			.filter((entry) => entry.projectId === project.id && (!entry.backend || entry.backend === "pi"))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		const session = await deps.catalog.createDraft({
			projectId: project.id,
			title: request.title?.trim() || project.name,
			environment: project.environment === "wsl" ? "wsl" : "native",
			backend: "pi",
			...(previous?.model ? { model: previous.model } : {}),
			...(previous?.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {}),
		});
		return session.id;
	}
	async function createTask(request: Request): Promise<{ id: string }> {
		const store = deps.getAutomations?.();
		const task = request.task;
		if (!store || !task || !deps.projects.get(task.projectId)) throw new Error("AUTOMATION_UNAVAILABLE");
		const created = await store.createTask({ name: task.name, projectId: task.projectId, prompt: task.prompt, backend: "pi", enabled: true, schedule: task.trigger === "manual" ? { type: "manual" } : { type: "cron", expression: `${task.minute} ${task.hour} * * *` } });
		// Durable receipts contain identity, never a growing copy of every task.
		return { id: created.id };
	}
	return { projects, tasks, createSession, createTask };
}
