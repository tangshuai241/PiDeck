import { isRecord } from "./crypto.ts";
import type { RemoteProject, RemoteTask } from "./types.ts";

/** Bound catalogs before native list rendering; the host remains their only authority. */
export function parseProjects(value: unknown): RemoteProject[] {
	if (!Array.isArray(value) || value.length > 200) throw new Error("INVALID_PROJECTS");
	return value.map((item: unknown) => {
		if (!isRecord(item) || typeof item.id !== "string" || item.id.length > 200 || typeof item.name !== "string" || item.name.length > 500 || typeof item.path !== "string" || item.path.length > 2000) throw new Error("INVALID_PROJECT");
		return { id: item.id, name: item.name, path: item.path };
	});
}
export function parseTasks(value: unknown): RemoteTask[] {
	if (!Array.isArray(value) || value.length > 200) throw new Error("INVALID_TASKS");
	return value.map((item: unknown) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.projectId !== "string" || typeof item.prompt !== "string" || item.prompt.length > 20_000 || typeof item.schedule !== "string" || typeof item.enabled !== "boolean") throw new Error("INVALID_TASK");
		return { id: item.id, name: item.name, projectId: item.projectId, prompt: item.prompt, schedule: item.schedule, enabled: item.enabled, ...(typeof item.nextRunAt === "number" ? { nextRunAt: item.nextRunAt } : {}) };
	});
}
