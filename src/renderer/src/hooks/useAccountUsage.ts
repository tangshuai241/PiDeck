/** A single desktop owner polls visible accounts; all timers stop with the shell. */
import { useAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QuotaAccountInput, QuotaSnapshot } from "../../../shared/types/accountUsage";
import { accountUsageSnapshotAtom } from "../atoms/account-usage-atoms";
import { desktopApi } from "../desktopApi";

export function useAccountUsage() {
	const [snapshot, setSnapshot] = useAtom(accountUsageSnapshotAtom);
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now());
	const alive = useRef(false);
	const revision = useRef(0);
	const run = useCallback(
		async (action: () => Promise<QuotaSnapshot>) => {
			const request = ++revision.current;
			setBusy(true);
			try {
				const result = await action();
				if (alive.current && request === revision.current) setSnapshot(result);
				return !result.error;
			} catch {
				if (alive.current && request === revision.current) setSnapshot((current) => ({ ...current, error: "storage" }));
				return false;
			} finally {
				if (alive.current && request === revision.current) setBusy(false);
			}
		},
		[setSnapshot],
	);
	useEffect(() => {
		let active = true;
		alive.current = true;
		void run(() => desktopApi.accountUsage.list()).then((ok) => {
			if (ok && active) void run(() => desktopApi.accountUsage.refresh());
		});
		const poll = window.setInterval(() => {
			if (document.visibilityState === "visible") void run(() => desktopApi.accountUsage.refresh());
		}, 5 * 60_000);
		const clock = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => {
			active = false;
			alive.current = false;
			revision.current += 1;
			window.clearInterval(poll);
			window.clearInterval(clock);
		};
	}, [run]);
	return {
		snapshot,
		busy,
		now,
		refresh: (id?: string) => run(() => desktopApi.accountUsage.refresh(id)),
		save: (input: QuotaAccountInput) =>
			run(async () => {
				const saved = await desktopApi.accountUsage.save(input);
				if (saved.error || !input.visible) return saved;
				const id = input.id ?? saved.accounts.at(-1)?.id;
				return id ? desktopApi.accountUsage.refresh(id) : saved;
			}),
		remove: (id: string) => run(() => desktopApi.accountUsage.remove(id)),
	};
}
export type AccountUsageController = ReturnType<typeof useAccountUsage>;
