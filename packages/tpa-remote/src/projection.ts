import { isRecord } from "./crypto.ts";
import { parseCursor } from "./cursor.ts";
import type { RemoteArtifact, RemoteAttention, RemoteMessage, RemoteQuestion, RemoteSession, RemoteSnapshot, RuntimeTarget } from "./types.ts";

/** Validate bounded host projections before they enter mobile state. */
export function parseSessions(value: unknown): RemoteSession[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_SESSIONS");
	return value.map((item: unknown) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.project !== "string" || typeof item.backend !== "string" || typeof item.updatedAt !== "number" || typeof item.active !== "boolean") throw new Error("INVALID_SESSION");
		return {
			id: item.id,
			title: item.title,
			project: item.project,
			backend: item.backend,
			updatedAt: item.updatedAt,
			active: item.active,
			...(typeof item.projectId === "string" ? { projectId: item.projectId } : {}),
			...(typeof item.projectPath === "string" ? { projectPath: item.projectPath } : {}),
			...(typeof item.model === "string" ? { model: item.model } : {}),
			...(typeof item.thinkingLevel === "string" ? { thinkingLevel: item.thinkingLevel } : {}),
			...(item.attention ? { attention: parseRemoteAttention(item.attention) } : {}),
		};
	});
}
export function parseTarget(value: unknown): RuntimeTarget {
	if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.agentId !== "string" || typeof value.runtimeGeneration !== "number" || !Number.isSafeInteger(value.runtimeGeneration)) throw new Error("INVALID_TARGET");
	return { sessionId: value.sessionId, agentId: value.agentId, runtimeGeneration: value.runtimeGeneration };
}
export function parseSnapshot(value: unknown): RemoteSnapshot {
	if (!isRecord(value) || typeof value.sessionId !== "string" || !Array.isArray(value.messages) || value.messages.length > 80 || !Array.isArray(value.questions) || value.questions.length > 20 || typeof value.busy !== "boolean" || typeof value.revision !== "number" || typeof value.hasOlder !== "boolean")
		throw new Error("INVALID_SNAPSHOT");
	const messages = value.messages.map((item: unknown): RemoteMessage => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.text !== "string" || item.text.length > 12_000 || typeof item.timestamp !== "number" || (item.role !== "user" && item.role !== "assistant" && item.role !== "tool" && item.role !== "system" && item.role !== "error"))
			throw new Error("INVALID_MESSAGE");
		if (item.thinking !== undefined && (typeof item.thinking !== "string" || item.thinking.length > 12_000)) throw new Error("INVALID_MESSAGE");
		const tool = item.tool;
		if (tool !== undefined && (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length > 200 || typeof tool.detail !== "string" || tool.detail.length > 12_000 || (tool.status !== "running" && tool.status !== "done" && tool.status !== "error"))) throw new Error("INVALID_TOOL");
		const message: RemoteMessage = {
			id: item.id,
			role: item.role,
			text: item.text,
			timestamp: item.timestamp,
			...(item.channelsSeparated === true ? { channelsSeparated: true } : {}),
			...(typeof item.stopReason === "string" && item.stopReason.length <= 100 ? { stopReason: item.stopReason } : {}),
			...(typeof item.thinking === "string" ? { thinking: item.thinking } : {}),
			...(typeof item.thinkingStartedAt === "number" ? { thinkingStartedAt: item.thinkingStartedAt } : {}),
			...(typeof item.thinkingEndedAt === "number" ? { thinkingEndedAt: item.thinkingEndedAt } : {}),
			...(isRecord(tool) && typeof tool.name === "string" && typeof tool.detail === "string" && (tool.status === "running" || tool.status === "done" || tool.status === "error")
				? { tool: { name: tool.name, detail: tool.detail, status: tool.status, ...(typeof tool.callId === "string" && tool.callId.length <= 500 ? { callId: tool.callId } : {}), ...(typeof tool.durationMs === "number" ? { durationMs: tool.durationMs } : {}) } }
				: {}),
		};
		if (item.entryId !== undefined) {
			if (typeof item.entryId !== "string" || item.entryId.length > 200) throw new Error("INVALID_MESSAGE");
			message.entryId = item.entryId;
		}
		for (const field of ["textTruncated", "thinkingTruncated", "toolTruncated"] as const) {
			if (item[field] !== undefined && typeof item[field] !== "boolean") throw new Error("INVALID_MESSAGE");
			if (item[field] === true) message[field] = true;
		}
		return message;
	});
	const questions = value.questions.map((item: unknown): RemoteQuestion => {
		if (!isRecord(item) || typeof item.requestId !== "string" || typeof item.method !== "string" || typeof item.title !== "string" || (item.options !== undefined && (!Array.isArray(item.options) || !item.options.every((option) => typeof option === "string")))) throw new Error("INVALID_QUESTION");
		const batchQuestions = Array.isArray(item.batchQuestions) ? item.batchQuestions.map(parseBatchQuestion) : undefined;
		return {
			...parseTarget(item),
			requestId: item.requestId,
			method: item.method,
			title: item.title,
			...(Array.isArray(item.options) ? { options: item.options.filter((option): option is string => typeof option === "string") } : {}),
			...(typeof item.placeholder === "string" ? { placeholder: item.placeholder } : {}),
			...(typeof item.prefill === "string" ? { prefill: item.prefill } : {}),
			...(item.allowOther === true ? { allowOther: true } : {}),
			...(batchQuestions ? { batchQuestions } : {}),
			...(item.batchReview === true ? { batchReview: true } : {}),
		};
	});
	return { sessionId: value.sessionId, messages, questions, busy: value.busy, revision: value.revision, hasOlder: value.hasOlder, ...(value.target ? { target: parseTarget(value.target) } : {}), ...(value.cursor ? { cursor: parseCursor(value.cursor) } : {}), ...(value.attention ? { attention: parseRemoteAttention(value.attention) } : {}) };
}

function parseBatchQuestion(item: unknown): NonNullable<RemoteQuestion["batchQuestions"]>[number] {
	if (!isRecord(item) || typeof item.id !== "string" || typeof item.question !== "string" || (item.type !== "select" && item.type !== "multi_select" && item.type !== "confirm" && item.type !== "input" && item.type !== "editor")) throw new Error("INVALID_QUESTION");
	const options = Array.isArray(item.options)
		? item.options
				.map((option) => (typeof option === "string" ? option : isRecord(option) && typeof option.label === "string" ? { label: option.label, ...(typeof option.value === "string" ? { value: option.value } : {}), ...(typeof option.description === "string" ? { description: option.description } : {}) } : undefined))
				.filter((option): option is NonNullable<typeof option> => option !== undefined)
		: undefined;
	return {
		id: item.id,
		type: item.type,
		question: item.question,
		...(options ? { options } : {}),
		...(item.allowOther === true ? { allowOther: true } : {}),
		...(typeof item.placeholder === "string" ? { placeholder: item.placeholder } : {}),
		...(typeof item.prefill === "string" ? { prefill: item.prefill } : {}),
	};
}

function isCompletionOutcome(value: unknown): value is "succeeded" | "failed" | "aborted" | "interrupted" {
	return value === "succeeded" || value === "failed" || value === "aborted" || value === "interrupted";
}

export function parseRemoteAttention(value: unknown): RemoteAttention {
	if (!isRecord(value) || typeof value.running !== "boolean" || typeof value.questionCount !== "number" || !Number.isSafeInteger(value.questionCount) || typeof value.completionUnread !== "boolean") throw new Error("INVALID_ATTENTION");
	const raw = value.completion;
	if (raw !== undefined && (!isRecord(raw) || typeof raw.id !== "string" || !isCompletionOutcome(raw.outcome) || typeof raw.finishedAt !== "number")) throw new Error("INVALID_ATTENTION");
	return {
		running: value.running,
		questionCount: value.questionCount,
		...(typeof value.question === "string" ? { question: value.question } : {}),
		...(isRecord(raw) && typeof raw.id === "string" && isCompletionOutcome(raw.outcome) && typeof raw.finishedAt === "number" ? { completion: { id: raw.id, outcome: raw.outcome, finishedAt: raw.finishedAt } } : {}),
		completionUnread: value.completionUnread,
	};
}

export function parseArtifacts(value: unknown): RemoteArtifact[] {
	if (!Array.isArray(value) || value.length > 600) throw new Error("INVALID_ARTIFACTS");
	return value.map((item: unknown) => {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.id) ||
			typeof item.sessionId !== "string" ||
			typeof item.title !== "string" ||
			typeof item.fileName !== "string" ||
			item.fileName.includes("/") ||
			item.fileName.includes("\\") ||
			typeof item.version !== "number" ||
			typeof item.bytes !== "number" ||
			item.bytes > 10_000_000 ||
			item.bytes < 0 ||
			typeof item.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.digest)
		)
			throw new Error("INVALID_ARTIFACT");
		return { id: item.id, sessionId: item.sessionId, title: item.title, fileName: item.fileName, version: item.version, bytes: item.bytes, digest: item.digest };
	});
}
