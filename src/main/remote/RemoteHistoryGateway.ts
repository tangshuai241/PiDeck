import type { AgentManager } from "../pi/AgentManager";
import type { SessionCatalogEntry } from "../sessions/SessionCatalog";
import type { Request, RemoteHistoryPage } from "../../../packages/tpa-remote/src/types";
import { projectRemoteMessages } from "./remoteMessageProjection";

/** Page only the catalog-owned file; the phone never supplies a filesystem path. */
export async function readRemoteHistory(agents: AgentManager, entry: SessionCatalogEntry, request: Request): Promise<RemoteHistoryPage> {
	if (!entry.filePath) return { messages: [], nextBefore: null };
	const page = await agents.readSessionDisplayTurnPage(entry.filePath, entry.id, request.before, 1, request.beforeEntryId, { projectId: entry.projectId });
	const rows = projectRemoteMessages(page.messages);
	const visible = page.messages.filter((message) => !message.meta?.hidden && !message.meta?.deleted && message.role !== "system");
	const truncated = rows.length < visible.length;
	const first = rows[0]?.entryId;
	// A large single turn may exceed one packet. Anchor the next page at the first delivered entry.
	if (truncated && !first) throw new Error("HISTORY_ANCHOR_UNAVAILABLE");
	return { messages: rows, nextBefore: truncated ? (request.before ?? page.total) : page.nextBefore, ...(truncated ? { nextBeforeEntryId: first } : page.nextBeforeEntryId ? { nextBeforeEntryId: page.nextBeforeEntryId } : {}) };
}
