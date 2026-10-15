import { isRecord } from "./crypto.ts";
import type { StreamCursor } from "./types.ts";

/** A cursor acknowledges display events and never authorizes command replay. */
export function parseCursor(value: unknown): StreamCursor {
	if (!isRecord(value) || typeof value.epoch !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.epoch) || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("INVALID_CURSOR");
	return { epoch: value.epoch, sequence: value.sequence };
}
