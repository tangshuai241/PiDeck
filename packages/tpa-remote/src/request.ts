import { isRecord } from "./crypto.ts";
import { parseCursor } from "./cursor.ts";
import type { Request, RuntimeTarget } from "./types.ts";
import { parseModelChoice } from "./models.ts";

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
export const MUTATIONS = new Set(["session.send", "session.abort", "ui.respond", "session.create", "tasks.create", "session.fork"]);

/** Parse a complete command at the host boundary; unknown methods never reach domain services. */
export function parseRequest(value: unknown, challenge: string, now = Date.now()): Request {
	if (!isRecord(value) || value.kind !== "request" || !identity(value.id) || value.challenge !== challenge || typeof value.issuedAt !== "number" || !Number.isSafeInteger(value.issuedAt) || Math.abs(now - value.issuedAt) > 120_000 || typeof value.method !== "string") throw new Error("INVALID_REQUEST");
	const base: Request = { kind: "request", id: value.id, challenge, issuedAt: value.issuedAt, method: value.method };
	if (value.model !== undefined && (value.method === "session.send" || value.method === "session.create")) base.model = parseModelChoice(value.model);
	if (value.method === "models.list") {
		if (value.sessionId !== undefined && !identity(value.sessionId)) throw new Error("INVALID_REQUEST");
		if (value.projectId !== undefined && !identity(value.projectId)) throw new Error("INVALID_REQUEST");
		return { ...base, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}), ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}) };
	}
	if (value.method === "commands.status" || value.method === "commands.ack") {
		if (!identity(value.commandId)) throw new Error("INVALID_REQUEST");
		return { ...base, commandId: value.commandId };
	}
	if (value.method === "sessions.list" || value.method === "projects.list" || value.method === "tasks.list") return base;
	if (value.method === "session.create") {
		if (!identity(value.projectId) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 20_000 || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 120))) throw new Error("INVALID_REQUEST");
		return { ...base, projectId: value.projectId, text: value.text, ...(typeof value.title === "string" ? { title: value.title } : {}) };
	}
	if (value.method === "tasks.create") {
		const task = value.task;
		if (
			!isRecord(task) ||
			!identity(task.projectId) ||
			typeof task.name !== "string" ||
			!task.name.trim() ||
			task.name.length > 120 ||
			typeof task.prompt !== "string" ||
			!task.prompt.trim() ||
			task.prompt.length > 20_000 ||
			(task.trigger !== "daily" && task.trigger !== "manual") ||
			typeof task.hour !== "number" ||
			!Number.isInteger(task.hour) ||
			task.hour < 0 ||
			task.hour > 23 ||
			typeof task.minute !== "number" ||
			!Number.isInteger(task.minute) ||
			task.minute < 0 ||
			task.minute > 59
		)
			throw new Error("INVALID_REQUEST");
		return { ...base, task: { name: task.name.trim(), prompt: task.prompt, projectId: task.projectId, trigger: task.trigger, hour: task.hour, minute: task.minute } };
	}
	if (!["session.read", "session.history", "message.read", "session.send", "session.abort", "session.fork", "ui.respond", "artifacts.list", "artifact.read"].includes(value.method) || !identity(value.sessionId)) throw new Error("INVALID_REQUEST");
	base.sessionId = value.sessionId;
	if (value.method === "message.read") {
		if (
			!identity(value.messageId) ||
			(value.entryId !== undefined && !identity(value.entryId)) ||
			(value.channel !== "text" && value.channel !== "thinking" && value.channel !== "tool") ||
			typeof value.offset !== "number" ||
			!Number.isSafeInteger(value.offset) ||
			value.offset < 0 ||
			value.offset > 64_000_000 ||
			(value.version !== undefined && (typeof value.version !== "string" || !/^[a-f0-9]{64}$/.test(value.version)))
		)
			throw new Error("INVALID_REQUEST");
		return { ...base, messageId: value.messageId, channel: value.channel, offset: value.offset, ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}), ...(typeof value.version === "string" ? { version: value.version } : {}) };
	}
	if (value.method === "session.history") {
		if (value.before !== undefined && (typeof value.before !== "number" || !Number.isSafeInteger(value.before) || value.before < 0)) throw new Error("INVALID_REQUEST");
		if (value.beforeEntryId !== undefined && !identity(value.beforeEntryId)) throw new Error("INVALID_REQUEST");
		return { ...base, ...(typeof value.before === "number" ? { before: value.before } : {}), ...(typeof value.beforeEntryId === "string" ? { beforeEntryId: value.beforeEntryId } : {}) };
	}
	if (value.method === "session.read" && value.cursor !== undefined) base.cursor = parseCursor(value.cursor);
	if (value.method === "session.send") {
		if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 20_000 || !value.target) throw new Error("INVALID_REQUEST");
		base.text = value.text;
	}
	if (value.target !== undefined) {
		const target = value.target;
		if (!isRecord(target) || target.sessionId !== value.sessionId || !identity(target.agentId) || typeof target.runtimeGeneration !== "number" || !Number.isSafeInteger(target.runtimeGeneration) || target.runtimeGeneration < 0) throw new Error("INVALID_REQUEST");
		const parsed: RuntimeTarget = { sessionId: value.sessionId, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration };
		base.target = parsed;
	}
	if (value.method === "session.abort" && !base.target) throw new Error("INVALID_REQUEST");
	if (value.method === "session.fork") {
		if (!base.target || !identity(value.entryId)) throw new Error("INVALID_REQUEST");
		base.entryId = value.entryId;
	}
	if (value.method === "artifact.read") {
		if (typeof value.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactId) || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 10_000_000) throw new Error("INVALID_REQUEST");
		base.artifactId = value.artifactId;
		base.offset = value.offset;
	}
	if (value.method === "ui.respond") {
		if (!base.target || !identity(value.questionId) || (typeof value.answer !== "string" && typeof value.answer !== "boolean") || (typeof value.answer === "string" && value.answer.length > 20_000)) throw new Error("INVALID_REQUEST");
		base.questionId = value.questionId;
		base.answer = value.answer;
	}
	return base;
}
