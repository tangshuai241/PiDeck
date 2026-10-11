import { ALIGNMENT_MESSAGE_TYPE, latestAlignmentStateFromMessages } from "../../shared/alignment";
import type { AlignmentState } from "../../shared/types/alignment";

/** Snapshot the runtime binding: agentId alone cannot distinguish a reused process/session. */
export type AlignmentRuntimeIdentity = {
	process: object;
	sessionId?: string;
	runtimeGeneration?: number;
	sessionPath?: string;
};

type Projection = { identity: AlignmentRuntimeIdentity; sequence: number; state: AlignmentState | null };

/** Process identity joins the persisted Session triple to reject replacement runtimes. */
function sameIdentity(left: AlignmentRuntimeIdentity, right: AlignmentRuntimeIdentity): boolean {
	return left.process === right.process && left.sessionId === right.sessionId && left.runtimeGeneration === right.runtimeGeneration && left.sessionPath === right.sessionPath;
}

/** Historical UI state is usable only if this actual process registered its control command. */
export async function loadEnabledAlignmentHistory(read: () => Promise<AlignmentState | null>, isExtensionLoaded: () => Promise<boolean>): Promise<AlignmentState | null> {
	const state = await read();
	if (!state) return null;
	return (await isExtensionLoaded()) ? state : null;
}

/** Native projection only: this never starts tasks, sends commands, or grants approval. */
export class AlignmentProjection {
	private readonly byAgent = new Map<string, Projection>();

	/** Snapshot reads never expose another binding's state. */
	read(agentId: string, identity: AlignmentRuntimeIdentity): AlignmentState | null {
		const projection = this.byAgent.get(agentId);
		return projection && sameIdentity(projection.identity, identity) ? projection.state : null;
	}

	/** Activation performs one initial hydration instead of disk IO on every poll. */
	has(agentId: string, identity: AlignmentRuntimeIdentity): boolean {
		const projection = this.byAgent.get(agentId);
		return Boolean(projection && sameIdentity(projection.identity, identity));
	}

	/** Invalid latest snapshots are explicit clears, never permission to revive older state. */
	acceptMessage(agentId: string, identity: AlignmentRuntimeIdentity, message: unknown): boolean {
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "custom" || !("customType" in message) || message.customType !== ALIGNMENT_MESSAGE_TYPE) return false;
		const projection = this.ensure(agentId, identity);
		projection.sequence++;
		projection.state = latestAlignmentStateFromMessages([message]) ?? null;
		return true;
	}

	/** A newer live event, restore, binding change, or cleanup invalidates an in-flight disk read. */
	async hydrate(agentId: string, identity: AlignmentRuntimeIdentity, load: () => Promise<AlignmentState | null>, isCurrent: () => boolean): Promise<boolean> {
		const projection = this.ensure(agentId, identity);
		const sequence = ++projection.sequence;
		let state: AlignmentState | null;
		try {
			state = await load();
		} catch {
			// Disk failures must fail closed without interfering with ordinary pi operation.
			state = null;
		}
		if (this.byAgent.get(agentId) !== projection || projection.sequence !== sequence || !isCurrent()) return false;
		projection.state = state;
		return true;
	}

	/** Paired with bridge unregister for stop/delete/restart/quit and process replacement. */
	clear(agentId: string): AlignmentRuntimeIdentity | undefined {
		const identity = this.byAgent.get(agentId)?.identity;
		this.byAgent.delete(agentId);
		return identity;
	}

	/** A new runtime gets one fresh owner object; stale asynchronous work cannot reuse it. */
	private ensure(agentId: string, identity: AlignmentRuntimeIdentity): Projection {
		const existing = this.byAgent.get(agentId);
		if (existing && sameIdentity(existing.identity, identity)) return existing;
		const projection: Projection = { identity: { ...identity }, sequence: 0, state: null };
		this.byAgent.set(agentId, projection);
		return projection;
	}
}
