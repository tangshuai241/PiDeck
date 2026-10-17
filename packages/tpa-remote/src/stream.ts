import { isRecord } from "./crypto.ts";
import { parseRemoteAttention, parseSnapshot } from "./projection.ts";
import { parseCursor } from "./cursor.ts";
import type { MessageDelta, RemoteMessage, RemotePatch, RemoteSnapshot, StreamCursor } from "./types.ts";

/** Send append deltas for growing text; metadata changes use an authoritative row upsert. */
export function diffSnapshots(previous: RemoteSnapshot, next: RemoteSnapshot, cursor: StreamCursor): RemotePatch {
	const old = new Map(previous.messages.map((message) => [message.id, message]));
	const upserts: RemoteMessage[] = [];
	const deltas: MessageDelta[] = [];
	for (const message of next.messages) {
		const before = old.get(message.id);
		if (!before) {
			upserts.push(message);
			continue;
		}
		if (JSON.stringify(before) === JSON.stringify(message)) continue;
		const metadataMatches =
			before.role === message.role &&
			before.stopReason === message.stopReason &&
			before.channelsSeparated === message.channelsSeparated &&
			before.entryId === message.entryId &&
			before.textTruncated === message.textTruncated &&
			before.thinkingTruncated === message.thinkingTruncated &&
			before.toolTruncated === message.toolTruncated &&
			JSON.stringify(before.tool) === JSON.stringify(message.tool);
		if (metadataMatches && message.text.startsWith(before.text) && (message.thinking ?? "").startsWith(before.thinking ?? "")) {
			deltas.push({ id: message.id, timestamp: message.timestamp, text: message.text.slice(before.text.length), thinking: (message.thinking ?? "").slice((before.thinking ?? "").length), thinkingStartedAt: message.thinkingStartedAt, thinkingEndedAt: message.thinkingEndedAt });
		} else upserts.push(message);
	}
	const ids = new Set(next.messages.map((message) => message.id));
	return {
		kind: "stream",
		sessionId: next.sessionId,
		cursor,
		previous: previous.cursor?.sequence ?? 0,
		target: next.target,
		upserts,
		deltas,
		removed: previous.messages.filter((message) => !ids.has(message.id)).map((message) => message.id),
		order: next.messages.map((message) => message.id),
		questions: next.questions,
		busy: next.busy,
		hasOlder: next.hasOlder,
		attention: next.attention,
	};
}

/** Reject holes and foreign sessions; duplicate delivery is harmless and keeps row identity. */
export function applyPatch(snapshot: RemoteSnapshot, patch: RemotePatch): RemoteSnapshot {
	if (patch.sessionId !== snapshot.sessionId || patch.cursor.epoch !== snapshot.cursor?.epoch) throw new Error("STREAM_RESET_REQUIRED");
	if (patch.cursor.sequence <= snapshot.cursor.sequence) return snapshot;
	if (patch.previous !== snapshot.cursor.sequence || patch.cursor.sequence !== patch.previous + 1) throw new Error("STREAM_GAP");
	const rows = new Map(snapshot.messages.map((message) => [message.id, message]));
	for (const id of patch.removed) rows.delete(id);
	for (const row of patch.upserts) rows.set(row.id, row);
	for (const delta of patch.deltas) {
		const before = rows.get(delta.id);
		if (!before) throw new Error("STREAM_GAP");
		rows.set(delta.id, { ...before, text: before.text + (delta.text ?? ""), thinking: (before.thinking ?? "") + (delta.thinking ?? ""), timestamp: delta.timestamp, thinkingStartedAt: delta.thinkingStartedAt, thinkingEndedAt: delta.thinkingEndedAt });
	}
	const messages = patch.order.map((id) => {
		const row = rows.get(id);
		if (!row) throw new Error("STREAM_GAP");
		return row;
	});
	return parseSnapshot({ ...snapshot, target: patch.target, cursor: patch.cursor, revision: patch.cursor.sequence, messages, questions: patch.questions, busy: patch.busy, hasOlder: patch.hasOlder, ...(patch.attention ? { attention: patch.attention } : {}) });
}

/** Strict decoding bounds malformed or oversized relay payloads before projection. */
export function parsePatch(value: unknown): RemotePatch {
	if (
		!isRecord(value) ||
		value.kind !== "stream" ||
		typeof value.sessionId !== "string" ||
		!Number.isSafeInteger(value.previous) ||
		typeof value.previous !== "number" ||
		!Array.isArray(value.deltas) ||
		value.deltas.length > 80 ||
		!Array.isArray(value.order) ||
		value.order.length > 80 ||
		!Array.isArray(value.removed) ||
		value.removed.length > 80
	)
		throw new Error("INVALID_STREAM");
	const strings = (items: unknown[]): string[] => {
		if (!items.every((item) => typeof item === "string" && item.length <= 500)) throw new Error("INVALID_STREAM");
		return items.filter((item): item is string => typeof item === "string");
	};
	const base = parseSnapshot({ ...value, messages: value.upserts, revision: value.previous });
	const deltas = value.deltas.map((delta: unknown): MessageDelta => {
		if (
			!isRecord(delta) ||
			typeof delta.id !== "string" ||
			delta.id.length > 500 ||
			typeof delta.timestamp !== "number" ||
			(delta.text !== undefined && (typeof delta.text !== "string" || delta.text.length > 12_000)) ||
			(delta.thinking !== undefined && (typeof delta.thinking !== "string" || delta.thinking.length > 12_000))
		)
			throw new Error("INVALID_STREAM");
		return {
			id: delta.id,
			timestamp: delta.timestamp,
			...(typeof delta.text === "string" ? { text: delta.text } : {}),
			...(typeof delta.thinking === "string" ? { thinking: delta.thinking } : {}),
			...(typeof delta.thinkingStartedAt === "number" ? { thinkingStartedAt: delta.thinkingStartedAt } : {}),
			...(typeof delta.thinkingEndedAt === "number" ? { thinkingEndedAt: delta.thinkingEndedAt } : {}),
		};
	});
	return { kind: "stream", sessionId: value.sessionId, cursor: parseCursor(value.cursor), previous: value.previous, target: base.target, upserts: base.messages, deltas, removed: strings(value.removed), order: strings(value.order), questions: base.questions, busy: base.busy, hasOlder: base.hasOlder, ...(base.attention ? { attention: base.attention } : {}) };
}
