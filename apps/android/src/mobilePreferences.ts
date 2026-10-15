import { isRecord } from "../../../packages/tpa-remote/src/crypto";
import { parseModels } from "../../../packages/tpa-remote/src/models";
import type { RemoteMessage, RemoteModel } from "../../../packages/tpa-remote/src/types";

export type PinnedMessage = { key: string; messageId: string; entryId?: string; text: string; timestamp: number; role: RemoteMessage["role"] };
export type MobilePreferences = { model?: RemoteModel; pins: Record<string, PinnedMessage[]> };
export const pinKey = (message: Pick<RemoteMessage, "id" | "entryId" | "role">) => `${message.role}:${message.entryId || message.id}`;

/** Pins are bounded reading bookmarks in the encrypted mobile cache, not session mutations. */
export function togglePinned(preferences: MobilePreferences, sessionId: string, message: RemoteMessage): MobilePreferences {
	const key = pinKey(message);
	const old = preferences.pins[sessionId] ?? [];
	const next = old.some((pin) => pin.key === key) ? old.filter((pin) => pin.key !== key) : [...old, { key, messageId: message.id, entryId: message.entryId, text: message.text.slice(0, 240), timestamp: message.timestamp, role: message.role }].slice(-30);
	return { ...preferences, pins: Object.fromEntries([...Object.entries(preferences.pins).filter(([id]) => id !== sessionId), [sessionId, next]].slice(-30)) };
}

/** Old cache versions have no preferences; malformed optional data degrades to defaults. */
export function parseMobilePreferences(value: unknown): MobilePreferences {
	const result: MobilePreferences = { pins: {} };
	if (!isRecord(value)) return result;
	try {
		if (value.model) result.model = parseModels([value.model])[0];
	} catch {
		/* Discard an unavailable local choice, never change credentials. */
	}
	if (isRecord(value.pins))
		for (const [sessionId, entries] of Object.entries(value.pins).slice(-30)) {
			if (sessionId.length > 200 || !Array.isArray(entries)) continue;
			result.pins[sessionId] = [];
			for (const item of entries.slice(-30))
				if (
					isRecord(item) &&
					typeof item.key === "string" &&
					item.key.length <= 410 &&
					typeof item.messageId === "string" &&
					item.messageId.length <= 200 &&
					typeof item.text === "string" &&
					typeof item.timestamp === "number" &&
					(item.role === "user" || item.role === "assistant" || item.role === "system" || item.role === "tool" || item.role === "error")
				) {
					result.pins[sessionId].push({ key: item.key, messageId: item.messageId, text: item.text.slice(0, 240), timestamp: item.timestamp, role: item.role, ...(typeof item.entryId === "string" && item.entryId.length <= 200 ? { entryId: item.entryId } : {}) });
				}
		}
	return result;
}
