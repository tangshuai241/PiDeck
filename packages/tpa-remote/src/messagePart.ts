import { isRecord } from "./crypto.ts";
import type { MessageChannel, RemoteMessagePart } from "./types.ts";

/** Preserve UTF-16 boundaries while keeping every message page small enough for native text layout. */
export function messagePartEnd(text: string, offset: number, size = 10_000): number {
	let end = Math.min(text.length, offset + size);
	if (end < text.length && end > offset && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
	return end;
}

/** A response must match the requested identity, channel, offset and stable content version. */
export function parseMessagePart(value: unknown, messageId: string, channel: MessageChannel, offset: number, version?: string): RemoteMessagePart {
	if (
		!isRecord(value) ||
		value.messageId !== messageId ||
		value.channel !== channel ||
		value.offset !== offset ||
		typeof value.text !== "string" ||
		value.text.length > 10_000 ||
		typeof value.total !== "number" ||
		!Number.isSafeInteger(value.total) ||
		value.total < offset ||
		value.total > 64_000_000 ||
		typeof value.version !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.version) ||
		(version !== undefined && value.version !== version)
	)
		throw new Error("INVALID_MESSAGE_PART");
	const end = offset + value.text.length;
	if (end > value.total || (value.nextOffset === null ? end !== value.total : value.nextOffset !== end || end <= offset || end >= value.total)) throw new Error("INVALID_MESSAGE_PART");
	return { messageId, channel, offset, text: value.text, total: value.total, version: value.version, nextOffset: value.nextOffset === null ? null : end };
}
