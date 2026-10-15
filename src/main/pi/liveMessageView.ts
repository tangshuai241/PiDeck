import type { ChatMessage } from "../../shared/types/session";

/** Overlay read-only live channels without writing provisional tokens into history. */
export function projectLiveMessageView(messages: ChatMessage[], assistantId: string | undefined, text: string | undefined, thinking: string | undefined, segment: { assistantMessageId: string; startedAt: number; endedAt: number } | undefined): ChatMessage[] {
	return messages.map((message) => {
		const body = message.id === assistantId && text !== undefined;
		const thought = message.id === segment?.assistantMessageId && thinking !== undefined;
		return body || thought ? { ...message, ...(body ? { text } : {}), ...(thought ? { thinking, thinkingStartedAt: segment?.startedAt, thinkingEndedAt: segment?.endedAt } : {}) } : message;
	});
}
