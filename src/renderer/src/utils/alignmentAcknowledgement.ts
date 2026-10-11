import type { AlignmentState } from "../../../shared/types/alignment";

/** RPC acceptance is delivery only. Wait for the exact authoritative extension transition, bounded and paired with cleanup. */
export function waitForAlignmentAcknowledgement(input: { read: () => AlignmentState | undefined; isCurrent: () => boolean; subscribe: (changed: () => void) => () => void; matches: (state: AlignmentState) => boolean; timeoutMs?: number }): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			if (timer !== undefined) globalThis.clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (!input.isCurrent()) return finish(new Error("runtimeChanged"));
			const state = input.read();
			if (state && input.matches(state)) finish();
		};
		unsubscribe = input.subscribe(check);
		if (settled) {
			unsubscribe();
			return;
		}
		timer = globalThis.setTimeout(() => finish(new Error("notAcknowledged")), input.timeoutMs ?? 5000);
		check();
	});
}
