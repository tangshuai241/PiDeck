import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../../packages/tpa-remote/src/crypto";
import type { Request, Response } from "../../../packages/tpa-remote/src/types";
import { commandIdentity } from "../../../packages/tpa-remote/src/commandIdentity";

type Receipt = { digest: string; state: "unknown" | "done"; at: number; acknowledged?: boolean; reply?: Response };

/** Durable write-ahead receipts prevent reconnect or host restart from replaying a command. */
export class RemoteCommandLedger {
	private readonly entries = new Map<string, Receipt>();
	private readonly pending = new Map<string, { digest: string; promise: Promise<Response> }>();
	private tail = Promise.resolve();
	private loaded = false;
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
	}
	async load(): Promise<void> {
		try {
			if ((await stat(this.path)).size > 2_000_000) throw new Error("LEDGER_TOO_LARGE");
			const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1000) throw new Error("INVALID_LEDGER");
			for (const pair of value.entries) {
				if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !isRecord(pair[1])) throw new Error("INVALID_LEDGER");
				const receipt = pair[1];
				if (typeof receipt.digest !== "string" || (receipt.state !== "done" && receipt.state !== "unknown") || typeof receipt.at !== "number") throw new Error("INVALID_LEDGER");
				let reply: Response | undefined;
				if (isRecord(receipt.reply) && receipt.reply.kind === "response" && typeof receipt.reply.id === "string" && typeof receipt.reply.ok === "boolean")
					reply = { kind: "response", id: receipt.reply.id, ok: receipt.reply.ok, result: receipt.reply.result, ...(typeof receipt.reply.error === "string" ? { error: receipt.reply.error } : {}) };
				this.entries.set(pair[0], { digest: receipt.digest, state: receipt.state, at: receipt.at, acknowledged: receipt.acknowledged === true, reply });
			}
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
		this.loaded = true;
	}
	/** Exclude connection challenges and timestamps from retry identity. */
	run(request: Request, action: () => Promise<Response>): Promise<Response> {
		const digest = createHash("sha256").update(commandIdentity(request.method, request)).digest("hex");
		const existing = this.entries.get(request.id);
		if (existing && existing.digest !== digest) return Promise.resolve({ kind: "response", id: request.id, ok: false, error: "REQUEST_ID_CONFLICT" });
		const inFlight = this.pending.get(request.id);
		if (inFlight) return inFlight.digest === digest ? inFlight.promise : Promise.resolve({ kind: "response", id: request.id, ok: false, error: "REQUEST_ID_CONFLICT" });
		const work = this.tail.then(async (): Promise<Response> => {
			if (!this.loaded) throw new Error("LEDGER_NOT_READY");
			const cached = this.entries.get(request.id);
			if (cached) return cached.reply ?? { kind: "response", id: request.id, ok: false, error: "DELIVERY_UNKNOWN" };
			// Unacknowledged results must survive time-based cleanup. Otherwise a phone
			// returning after a day could mistake an executed command for one never received.
			for (const [id, entry] of this.entries) if (entry.acknowledged && Date.now() - entry.at > 24 * 60 * 60_000) this.entries.delete(id);
			if (this.entries.size >= 1000) return { kind: "response", id: request.id, ok: false, error: "RECEIPT_LIMIT" } satisfies Response;
			this.entries.set(request.id, { digest, state: "unknown", at: Date.now() });
			await this.flush();
			let reply: Response;
			try {
				reply = await action();
			} catch {
				reply = { kind: "response", id: request.id, ok: false, error: "DELIVERY_UNKNOWN" };
			}
			this.entries.set(request.id, { digest, state: "done", at: Date.now(), reply });
			await this.flush();
			return reply;
		});
		this.tail = work.then(
			() => undefined,
			() => undefined,
		);
		this.pending.set(request.id, { digest, promise: work });
		void work.finally(() => this.pending.delete(request.id)).catch(() => undefined);
		return work;
	}
	/** Read a durable receipt without re-running the original command. */
	status(commandId: string): { state: "missing" | "unknown" | "done"; reply?: Response } {
		if (!this.loaded) throw new Error("LEDGER_NOT_READY");
		const receipt = this.entries.get(commandId);
		return receipt ? { state: receipt.state, ...(receipt.reply ? { reply: receipt.reply } : {}) } : { state: "missing" };
	}
	/** The phone acknowledges only after durably clearing its outstanding command. */
	acknowledge(commandId: string): Promise<void> {
		const work = this.tail.then(async () => {
			if (!this.loaded) throw new Error("LEDGER_NOT_READY");
			const receipt = this.entries.get(commandId);
			if (!receipt || receipt.state !== "done" || receipt.reply?.error === "DELIVERY_UNKNOWN" || (isRecord(receipt.reply?.result) && receipt.reply.result.unknown === true)) return;
			this.entries.set(commandId, { ...receipt, acknowledged: true });
			await this.flush();
		});
		this.tail = work.catch(() => undefined);
		return work;
	}
	private async flush(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		const file = await open(temp, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify({ version: 1, entries: [...this.entries] }));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temp, this.path);
	}
}
