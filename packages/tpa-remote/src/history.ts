import { isRecord } from "./crypto.ts";
import { parseSnapshot } from "./projection.ts";
import type { RemoteHistoryPage, RemoteMessage } from "./types.ts";

/** Historical pages use the same row decoder and a stable desktop entry anchor. */
export function parseHistory(value: unknown, sessionId: string): RemoteHistoryPage {
	if (!isRecord(value) || (value.nextBefore !== null && (typeof value.nextBefore !== "number" || !Number.isSafeInteger(value.nextBefore) || value.nextBefore < 0)) || (value.nextBeforeEntryId !== undefined && typeof value.nextBeforeEntryId !== "string")) throw new Error("INVALID_HISTORY");
	const base = parseSnapshot({ sessionId, messages: value.messages, questions: [], busy: false, revision: 0, hasOlder: false });
	return { messages: base.messages, nextBefore: value.nextBefore, ...(typeof value.nextBeforeEntryId === "string" ? { nextBeforeEntryId: value.nextBeforeEntryId } : {}) };
}

/** A sliding historical window stays contiguous and bounded; newer live content is a separate view. */
export function prependHistory(older: RemoteMessage[], current: RemoteMessage[], limit = 600): RemoteMessage[] {
	const seen = new Set<string>();
	const rows: RemoteMessage[] = [];
	for (const row of [...older, ...current])
		if (!seen.has(row.id)) {
			seen.add(row.id);
			rows.push(row);
		}
	return rows.slice(0, limit);
}
