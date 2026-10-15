import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import { diffSnapshots } from "../../../packages/tpa-remote/src/stream";
import type { RemotePatch, RemoteSnapshot, RemoteSync, StreamCursor } from "../../../packages/tpa-remote/src/types";

type Entry = { epoch: string; sequence: number; snapshot?: RemoteSnapshot; patches: RemotePatch[]; bytes: number; dirty: boolean; pending?: Promise<void>; timer?: ReturnType<typeof setTimeout> };

/** Event-driven, bounded replay cache; only views previously opened by the phone are observed. */
export class RemoteSessionFeed {
	private readonly entries = new Map<string, Entry>();
	private disposed = false;
	constructor(
		private readonly read: (sessionId: string) => Promise<RemoteSnapshot>,
		private readonly publish: (patch: RemotePatch) => void,
		private readonly onError: () => void,
	) {}
	private entry(sessionId: string): Entry {
		const found = this.entries.get(sessionId);
		if (found) return found;
		if (this.entries.size >= 8) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				const old = this.entries.get(oldest);
				if (old?.timer) clearTimeout(old.timer);
				this.entries.delete(oldest);
			}
		}
		const entry: Entry = { epoch: randomUUID(), sequence: 0, patches: [], bytes: 0, dirty: true };
		this.entries.set(sessionId, entry);
		return entry;
	}
	/** Coalesce one UI frame, not a polling loop; tools and terminal edges still arrive promptly. */
	invalidate(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry || this.disposed) return;
		entry.dirty = true;
		if (entry.timer || entry.pending) return;
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			void this.refresh(sessionId, entry).catch(this.onError);
		}, 35);
	}
	private refresh(sessionId: string, entry: Entry): Promise<void> {
		if (entry.pending) return entry.pending;
		entry.pending = (async () => {
			do {
				entry.dirty = false;
				const snapshot = await this.read(sessionId);
				if (this.disposed || this.entries.get(sessionId) !== entry) return;
				const previous = entry.snapshot;
				const fingerprint = (value: RemoteSnapshot) => JSON.stringify({ ...value, revision: 0, cursor: undefined });
				if (previous && fingerprint(previous) === fingerprint(snapshot)) continue;
				const cursor = { epoch: entry.epoch, sequence: ++entry.sequence };
				entry.snapshot = { ...snapshot, revision: entry.sequence, cursor };
				if (!previous) continue;
				const patch = diffSnapshots(previous, entry.snapshot, cursor);
				const bytes = Buffer.byteLength(JSON.stringify(patch));
				entry.patches.push(patch);
				entry.bytes += bytes;
				while (entry.patches.length > 128 || entry.bytes > 512_000) {
					const removed = entry.patches.shift();
					if (removed) entry.bytes -= Buffer.byteLength(JSON.stringify(removed));
				}
				this.publish(patch);
			} while (entry.dirty && !this.disposed);
		})().finally(() => {
			entry.pending = undefined;
		});
		return entry.pending;
	}
	async synchronize(sessionId: string, cursor?: StreamCursor): Promise<RemoteSync> {
		const entry = this.entry(sessionId);
		// Re-read the authority on reconnect, including runtime replacement while disconnected.
		entry.dirty = true;
		await this.refresh(sessionId, entry);
		const snapshot = entry.snapshot;
		if (!snapshot || this.disposed) throw new Error("SYNC_UNAVAILABLE");
		if (cursor?.epoch === entry.epoch && cursor.sequence <= entry.sequence) {
			if (cursor.sequence === entry.sequence) return { kind: "sync", patches: [] };
			const patches = entry.patches.filter((patch) => patch.cursor.sequence > cursor.sequence);
			if (patches[0]?.previous === cursor.sequence) return { kind: "sync", patches };
		}
		return { kind: "sync", snapshot, patches: [] };
	}
	dispose(): void {
		this.disposed = true;
		this.clear();
	}
	clear(): void {
		for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
		this.entries.clear();
	}
}
