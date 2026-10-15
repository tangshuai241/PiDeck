import { useEffect, useRef, useState } from "react";
import type { RemoteHistoryPage, RemoteMessage, RemoteSnapshot } from "../../../packages/tpa-remote/src/types";
import { prependHistory } from "../../../packages/tpa-remote/src/history";
import type { PhoneClient } from "./phoneClient";

type Window = { sessionId: string; messages: RemoteMessage[]; page: RemoteHistoryPage };

/** Historical browsing has a bounded sliding window; live events keep syncing independently. */
export function useHistory(client: PhoneClient, selected: string | undefined, snapshot: RemoteSnapshot | undefined, fail: (code: string) => void) {
	const [window, setWindow] = useState<Window>();
	const [loading, setLoading] = useState(false);
	const epoch = useRef(0);
	const pending = useRef(false);
	useEffect(() => {
		epoch.current++;
		pending.current = false;
		setLoading(false);
		setWindow(undefined);
		return () => {
			epoch.current++;
		};
	}, [selected, snapshot?.target?.agentId, snapshot?.target?.runtimeGeneration]);
	const current = window?.sessionId === selected ? window : undefined;
	async function loadOlder(): Promise<void> {
		if (!selected || !snapshot || pending.current || current?.page.nextBefore === null) return;
		pending.current = true;
		setLoading(true);
		const generation = epoch.current;
		const sessionId = selected;
		try {
			const page = await client.history(sessionId, current?.page.nextBefore ?? undefined, current?.page.nextBeforeEntryId ?? snapshot.messages[0]?.entryId);
			if (generation !== epoch.current) return;
			setWindow({ sessionId, messages: prependHistory(page.messages, current?.messages ?? snapshot.messages), page });
		} catch {
			if (generation === epoch.current) fail("HISTORY_FAILED");
		} finally {
			if (generation === epoch.current) {
				pending.current = false;
				setLoading(false);
			}
		}
	}
	function showLatest() {
		epoch.current++;
		pending.current = false;
		setLoading(false);
		setWindow(undefined);
	}
	return { historyMode: !!current, displayMessages: current?.messages ?? snapshot?.messages ?? [], hasOlder: current ? current.page.nextBefore !== null : (snapshot?.hasOlder ?? false), historyLoading: loading, loadOlder, showLatest };
}
