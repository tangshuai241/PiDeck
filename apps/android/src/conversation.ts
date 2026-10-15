import type { RemoteMessage } from "../../../packages/tpa-remote/src/types";
import { displayChannels } from "../../../packages/tpa-remote/src/displayChannels";

export type ProcessStep = { id: string; kind: "thinking" | "tool" | "reply"; message: RemoteMessage };
export type ConversationTurn = { id: string; user?: RemoteMessage; steps: ProcessStep[]; answer?: RemoteMessage; notices: RemoteMessage[]; running: boolean; partial: boolean; tools: number; thoughts: number; replies: number };
export type ConversationRow = { id: string; kind: "message"; message: RemoteMessage } | { id: string; kind: "summary"; turn: ConversationTurn } | { id: string; kind: "step"; step: ProcessStep };

/** Stable identities deduplicate transport updates, never equal text from distinct calls. */
export function buildConversation(messages: RemoteMessage[], busy: boolean, hasOlder: boolean): ConversationTurn[] {
	const unique = new Map<string, RemoteMessage>();
	for (const message of messages) unique.set(message.entryId ? `${message.role}:${message.entryId}` : message.id, message);
	const groups: { id: string; user?: RemoteMessage; items: RemoteMessage[] }[] = [];
	for (const source of unique.values()) {
		const channels = source.channelsSeparated ? { text: source.text, thinking: source.thinking ?? "" } : displayChannels(source);
		const message = { ...source, ...channels };
		if (message.role === "user") groups.push({ id: message.id, user: message, items: [] });
		else {
			if (!groups.length) groups.push({ id: `partial-${message.id}`, items: [] });
			groups[groups.length - 1].items.push(message);
		}
	}
	return groups.map((group, index) => {
		const running = busy && index === groups.length - 1;
		const tail = group.items[group.items.length - 1];
		// A tool/error tail cannot turn an earlier progress report into a final answer.
		const answer = tail?.role === "assistant" && tail.text.trim() && (running || !tail.stopReason || tail.stopReason === "stop" || tail.stopReason === "pending") ? tail : undefined;
		const steps: ProcessStep[] = [];
		const calls = new Map<string, ProcessStep>();
		const notices: RemoteMessage[] = [];
		for (const message of group.items) {
			if (message.role === "assistant") {
				if (message.thinking?.trim()) steps.push({ id: `thought-${message.id}`, kind: "thinking", message });
				if (message !== answer && message.text.trim()) steps.push({ id: `reply-${message.id}`, kind: "reply", message });
			} else if (message.role === "tool") {
				const key = message.tool?.callId || message.entryId || message.id;
				const previous = calls.get(key);
				if (previous) previous.message = message;
				else {
					const step: ProcessStep = { id: `tool-${key}`, kind: "tool", message };
					calls.set(key, step);
					steps.push(step);
				}
			} else notices.push(message);
		}
		return { id: group.id, user: group.user, steps, answer, notices, running, partial: index === 0 && hasOlder && !group.user, tools: calls.size, thoughts: steps.filter((step) => step.kind === "thinking").length, replies: steps.filter((step) => step.kind === "reply").length };
	});
}

/** Flatten expanded steps so a long tool run remains virtualized at individual row granularity. */
export function conversationRows(turns: ConversationTurn[], expanded: ReadonlySet<string>): ConversationRow[] {
	const rows: ConversationRow[] = [];
	for (const turn of turns) {
		if (turn.user) rows.push({ id: turn.user.id, kind: "message", message: turn.user });
		if (turn.steps.length) rows.push({ id: `summary-${turn.id}`, kind: "summary", turn });
		if (expanded.has(turn.id)) for (const step of turn.steps) rows.push({ id: step.id, kind: "step", step });
		for (const notice of turn.notices) rows.push({ id: notice.id, kind: "message", message: notice });
		if (turn.answer) rows.push({ id: turn.answer.id, kind: "message", message: turn.answer });
	}
	return rows;
}
