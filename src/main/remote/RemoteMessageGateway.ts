import { createHash } from "node:crypto";
import type { AgentManager } from "../pi/AgentManager";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { SessionCatalogEntry } from "../sessions/SessionCatalog";
import type { ChatMessage } from "../../shared/types/session";
import type { Request, RemoteMessagePart } from "../../../packages/tpa-remote/src/types";
import { messagePartEnd } from "../../../packages/tpa-remote/src/messagePart";
import { displayChannels } from "../../../packages/tpa-remote/src/displayChannels";

/** Page only display text from the selected catalog session; never expose arbitrary JSONL or metadata. */
export async function readRemoteMessagePart(deps: { agents: AgentManager; runtime: SessionRuntimeCoordinator }, entry: SessionCatalogEntry, request: Request): Promise<RemoteMessagePart> {
	if (!request.messageId || !request.channel || request.offset === undefined) throw new Error("INVALID_REQUEST");
	const target = deps.runtime.getTarget(entry.id);
	const matches = (item: ChatMessage) => (request.entryId ? item.meta?.entryId === request.entryId && request.messageId === `entry-${item.role}-${request.entryId}` : item.id === request.messageId);
	let row: ChatMessage | undefined = target ? deps.agents.getDisplayMessages(target.agentId).find(matches) : undefined;
	if (row?.meta?.hidden || row?.meta?.deleted || row?.role === "system") throw new Error("MESSAGE_UNAVAILABLE");
	if (!row && entry.filePath) row = (await deps.agents.readDisplayMessagesForEntryFromFile(entry.filePath, request.messageId, request.entryId)).find(matches);
	if (!row || row.meta?.hidden || row.meta?.deleted || row.role === "system") throw new Error("MESSAGE_UNAVAILABLE");
	const channels = displayChannels(row);
	let text = request.channel === "thinking" ? channels.thinking : request.channel === "tool" ? (typeof row.meta?.detailText === "string" ? row.meta.detailText : row.text) : channels.text;
	if (request.channel === "tool" && row.meta?.truncated === true) {
		text = target ? (await deps.agents.readMessageFullText(target.agentId, row.id, request.entryId)).text : row.text;
	}
	const version = createHash("sha256").update(text).digest("hex");
	if (request.version !== undefined && request.version !== version) throw new Error("MESSAGE_CHANGED");
	if (text.length > 64_000_000 || request.offset > text.length) throw new Error("MESSAGE_PART_UNAVAILABLE");
	const end = messagePartEnd(text, request.offset);
	return { messageId: request.messageId, channel: request.channel, text: text.slice(request.offset, end), offset: request.offset, nextOffset: end < text.length ? end : null, total: text.length, version };
}
