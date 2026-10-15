/** A native extension command makes one isolated request; absence must never fall through to a model turn. */
import { randomUUID } from "node:crypto";
import type { PiRpcClient } from "./PiRpcClient";
import { normalizeSessionTitleModel, type SessionTitleModel } from "../../shared/sessionTitlePreference";
import { sessionTitleErrorCode, type SessionTitleErrorCode } from "../../shared/sessionTitleErrors";

const isBox = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export async function requestSessionTitle(client: PiRpcClient, isCurrent: () => boolean, model?: SessionTitleModel): Promise<string> {
	const commands = await client.request({ type: "get_commands" }, 10000);
	const list = isBox(commands.data) && Array.isArray(commands.data.commands) ? commands.data.commands : [];
	if (!isCurrent()) throw new Error("TITLE_RUNTIME_CHANGED");
	if (!commands.success || !list.some((item) => isBox(item) && item.name === "pideck-title" && item.source === "extension")) throw new Error("TITLE_EXTENSION_UNAVAILABLE");
	const requestId = randomUUID();
	let title: string | undefined;
	let failure: SessionTitleErrorCode | undefined;
	const onEvent = (event: unknown) => {
		if (isBox(event) && event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === `pideck:title-result:${requestId}` && typeof event.statusText === "string" && event.statusText.length <= 160) title = event.statusText.trim();
		if (isBox(event) && event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === `pideck:title-error:${requestId}`) failure = sessionTitleErrorCode(event.statusText);
	};
	client.on("event", onEvent);
	try {
		if (!isCurrent()) throw new Error("TITLE_RUNTIME_CHANGED");
		const response = await client.request({ type: "prompt", message: `/pideck-title ${JSON.stringify({ requestId, model: normalizeSessionTitleModel(model) })}` }, 45000);
		if (!isCurrent()) throw new Error("TITLE_RUNTIME_CHANGED");
		if (failure) throw new Error(failure);
		if (!response.success || !title) throw new Error("TITLE_FAILED");
		return title;
	} finally {
		client.off("event", onEvent);
	}
}
