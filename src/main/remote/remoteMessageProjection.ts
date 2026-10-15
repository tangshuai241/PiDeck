import type { ChatMessage } from "../../shared/types/session";
import type { RemoteMessage } from "../../../packages/tpa-remote/src/types";
import { displayChannels } from "../../../packages/tpa-remote/src/displayChannels";

/** Expose a bounded display whitelist; raw metadata, credentials and hidden controls stay local. */
export function projectRemoteMessages(messages: ChatMessage[]): RemoteMessage[] {
	const result: RemoteMessage[] = [];
	let bytes = 0;
	for (const message of messages
		.filter((item) => !item.meta?.hidden && !item.meta?.deleted && item.role !== "system")
		.slice(-80)
		.reverse()) {
		const meta = message.meta;
		const entryId = typeof meta?.entryId === "string" ? meta.entryId : undefined;
		const channels = displayChannels(message);
		const row: RemoteMessage = {
			id: message.id,
			role: message.role,
			text: channels.text.slice(-12_000),
			timestamp: message.timestamp,
			channelsSeparated: true,
			...(message.stopReason ? { stopReason: message.stopReason } : {}),
			...(channels.thinking ? { thinking: channels.thinking.slice(-12_000), thinkingStartedAt: message.thinkingStartedAt, thinkingEndedAt: message.thinkingEndedAt } : {}),
		};
		if (message.role === "tool" && typeof meta?.toolName === "string")
			row.tool = {
				name: meta.toolName.slice(0, 200),
				...(typeof meta.toolCallId === "string" ? { callId: meta.toolCallId } : {}),
				status: meta.status === "running" ? "running" : meta.status === "error" || meta.isError === true ? "error" : "done",
				detail: typeof meta.detailText === "string" ? meta.detailText.slice(-12_000) : typeof meta.result === "string" ? meta.result.slice(-12_000) : "",
				...(typeof meta.durationMs === "number" ? { durationMs: meta.durationMs } : {}),
			};
		if (entryId) {
			row.id = `entry-${message.role}-${entryId}`;
			row.entryId = entryId;
		}
		if (channels.text.length > 12_000) row.textTruncated = true;
		if ((message.thinking?.length ?? 0) > 12_000) row.thinkingTruncated = true;
		if (message.role === "tool" && (meta?.truncated === true || (typeof meta?.detailText === "string" && meta.detailText.length > 12_000) || (typeof meta?.result === "string" && meta.result.length > 12_000))) row.toolTruncated = true;
		const size = new TextEncoder().encode(JSON.stringify(row)).length;
		if (bytes + size > 200_000) break;
		bytes += size;
		result.unshift(row);
	}
	return result;
}
