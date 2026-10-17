import * as Crypto from "expo-crypto";
import { AppState } from "react-native";
import { decode, encode, isRecord, keyPair, open, parsePairing, seal, sharedKey } from "../../../packages/tpa-remote/src/crypto";
import { parseArtifacts, parseSessions, parseSnapshot } from "../../../packages/tpa-remote/src/projection";
import { applyPatch, parsePatch } from "../../../packages/tpa-remote/src/stream";
import { parseProjects, parseTasks } from "../../../packages/tpa-remote/src/catalog";
import { commandIdentity } from "../../../packages/tpa-remote/src/commandIdentity";
import { MUTATIONS } from "../../../packages/tpa-remote/src/request";
import { parseHistory } from "../../../packages/tpa-remote/src/history";
import { parseMessagePart } from "../../../packages/tpa-remote/src/messagePart";
import type { MessageChannel, RemoteMessagePart } from "../../../packages/tpa-remote/src/types";
import { downloadRemoteArtifact } from "./downloadArtifact";
import type { RemoteHistoryPage } from "../../../packages/tpa-remote/src/types";
import { parseTarget } from "../../../packages/tpa-remote/src/projection";
import type { RuntimeTarget } from "../../../packages/tpa-remote/src/types";
import type { ModelChoice, RemoteModel } from "../../../packages/tpa-remote/src/types";
import { parseModels, parseModelChoice } from "../../../packages/tpa-remote/src/models";
import type { RemoteProject, RemoteTask, RemoteTaskInput } from "../../../packages/tpa-remote/src/types";
import type { Pairing, RemoteArtifact, RemoteSession, RemoteSnapshot, RemotePatch } from "../../../packages/tpa-remote/src/types";

export type ConnectionState = "unpaired" | "connecting" | "waiting" | "connected" | "offline" | "error";
export type OutstandingCommand = { id: string; method: string; signature: string; sessionId?: string; projectId?: string; target?: RuntimeTarget; model?: ModelChoice };
export type Credentials = { pairing: Pairing; secretKey: string; publicKey: string; paired: boolean; outstanding?: OutstandingCommand };
type Event = { kind: "state"; state: ConnectionState } | { kind: "sessions"; sessions: RemoteSession[] } | { kind: "snapshot"; snapshot: RemoteSnapshot } | { kind: "error"; code: string } | { kind: "receipt"; command: OutstandingCommand; ok: boolean; result?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; mutation: boolean };
const random = (length: number) => Crypto.getRandomBytes(length);

/** Native connection owner: sockets pause in the background and resync on foreground. */
export class PhoneClient {
	private credentials?: Credentials;
	private socket?: WebSocket;
	private timer?: ReturnType<typeof setTimeout>;
	private retry = 0;
	private challenge = "";
	private state: ConnectionState = "unpaired";
	private capabilities = new Set<string>();
	private selected = "";
	private paused = false;
	private disposed = false;
	private preparingMutation = false;
	private readonly snapshots = new Map<string, RemoteSnapshot>();
	private readonly syncing = new Set<string>();
	private readonly streamBuffers = new Map<string, RemotePatch[]>();
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(event: Event) => void>();
	private readonly persist: (credentials: Credentials | undefined) => Promise<void>;
	private readonly appStateSubscription;
	constructor(persist: (credentials: Credentials | undefined) => Promise<void>) {
		this.persist = persist;
		this.appStateSubscription = AppState.addEventListener("change", (state) => {
			this.paused = state !== "active";
			if (this.paused) this.disconnect();
			else this.connect();
		});
	}
	subscribe(listener: (event: Event) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(event: Event) {
		for (const listener of this.listeners) listener(event);
	}
	private setState(state: ConnectionState) {
		this.state = state;
		this.emit({ kind: "state", state });
	}
	async restore(credentials: Credentials | undefined): Promise<void> {
		this.credentials = credentials;
		if (credentials) this.connect();
		else this.setState("unpaired");
	}
	async pair(text: string): Promise<void> {
		const pairing = parsePairing(text);
		const device = keyPair(random);
		this.disconnect();
		this.credentials = { pairing, secretKey: encode(device.secretKey), publicKey: encode(device.publicKey), paired: false };
		await this.persist(this.credentials);
		this.connect();
	}
	async forget(): Promise<void> {
		this.disconnect();
		this.credentials = undefined;
		this.selected = "";
		this.snapshots.clear();
		this.streamBuffers.clear();
		await this.persist(undefined);
		this.setState("unpaired");
	}
	seed(snapshot: RemoteSnapshot): void {
		this.snapshots.set(snapshot.sessionId, snapshot);
	}
	getSnapshot(sessionId: string): RemoteSnapshot | undefined {
		return this.snapshots.get(sessionId);
	}
	refresh(): void {
		this.retry = 0;
		this.disconnect();
		this.connect();
	}
	private disconnect(): void {
		this.capabilities.clear();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(pending.mutation ? "DELIVERY_UNKNOWN" : "CONNECTION_LOST"));
		}
		this.pending.clear();
		if (this.credentials) this.setState("offline");
	}
	private derivedKey(): Uint8Array {
		if (!this.credentials) throw new Error("UNPAIRED");
		return sharedKey(decode(this.credentials.pairing.hostKey), decode(this.credentials.secretKey));
	}
	private connect(): void {
		if (this.disposed || this.paused || !this.credentials || this.socket) return;
		const credentials = this.credentials;
		this.setState("connecting");
		const socket = new WebSocket(`${credentials.pairing.relay}/${credentials.pairing.room}/phone`, ["tpa-v1", credentials.pairing.token]);
		this.socket = socket;
		let tail = Promise.resolve();
		socket.onopen = () => {
			if (this.socket === socket) this.setState("waiting");
		};
		socket.onmessage = (event) => {
			if (this.socket !== socket || typeof event.data !== "string") return;
			const data = event.data;
			tail = tail
				.then(() => this.receive(data, socket))
				.catch(() => {
					if (this.socket !== socket) return;
					this.emit({ kind: "error", code: "CHANNEL_REJECTED" });
					this.setState("error");
					socket.close();
				});
		};
		socket.onerror = () => {
			if (this.socket === socket) this.setState("offline");
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.disconnect();
			if (!this.paused && !this.disposed) this.timer = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)) + Math.floor(Math.random() * 500));
		};
	}
	private async receive(data: string, socket: WebSocket): Promise<void> {
		if (this.socket !== socket) return;
		if (data.length > 2_000_000) throw new Error("PACKET_TOO_LARGE");
		if (!this.credentials) return;
		const raw: unknown = JSON.parse(data);
		if (isRecord(raw) && raw.relay === "peer") {
			if (raw.online === false) this.setState("offline");
			return;
		}
		let packet: Record<string, unknown>;
		try {
			packet = open(data, this.derivedKey());
		} catch {
			if (this.credentials.paired || this.credentials.pairing.expiresAt < Date.now()) throw new Error("PAIRING_EXPIRED");
			packet = open(data, decode(this.credentials.pairing.key));
		}
		if (packet.kind === "challenge" && typeof packet.challenge === "string" && packet.challenge.length <= 100) {
			this.challenge = packet.challenge;
			this.socket?.send(seal({ kind: "authenticate", challenge: this.challenge, deviceKey: this.credentials.publicKey, deviceName: "Android · TPA" }, packet.paired === true ? this.derivedKey() : decode(this.credentials.pairing.key), random));
			this.setState("waiting");
			return;
		}
		if (packet.kind === "authenticated" && packet.challenge === this.challenge) {
			this.capabilities = new Set(Array.isArray(packet.capabilities) ? packet.capabilities.filter((item): item is string => typeof item === "string").slice(0, 32) : []);
			const previous = this.credentials;
			const next = { ...previous, paired: true };
			await this.persist(next);
			if (this.socket !== socket || this.credentials !== previous) return;
			this.credentials = next;
			this.retry = 0;
			this.setState("connected");
			void this.reconcileOutstanding().catch(() => this.emit({ kind: "error", code: "DELIVERY_UNKNOWN" }));
			if (this.selected) void this.select(this.selected).catch(() => this.emit({ kind: "error", code: "SYNC_FAILED" }));
			return;
		}
		if (this.state !== "connected") return;
		if (packet.kind === "sessions") {
			this.emit({ kind: "sessions", sessions: parseSessions(packet.sessions) });
			return;
		}
		if (packet.kind === "snapshot") {
			const snapshot = parseSnapshot(packet.snapshot);
			if (snapshot.sessionId === this.selected) this.emit({ kind: "snapshot", snapshot });
			return;
		}
		if (packet.kind === "stream") {
			const patch = parsePatch(packet);
			if (patch.sessionId !== this.selected) return;
			if (this.syncing.has(patch.sessionId)) {
				const buffer = this.streamBuffers.get(patch.sessionId) ?? [];
				if (buffer.length >= 128) throw new Error("STREAM_OVERFLOW");
				buffer.push(patch);
				this.streamBuffers.set(patch.sessionId, buffer);
				return;
			}
			try {
				this.acceptPatch(patch);
			} catch {
				this.snapshots.delete(patch.sessionId);
				void this.select(patch.sessionId).catch(() => this.emit({ kind: "error", code: "SYNC_FAILED" }));
			}
			return;
		}
		if (packet.kind === "response" && typeof packet.id === "string") {
			const pending = this.pending.get(packet.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(packet.id);
			const uncertain = packet.error === "DELIVERY_UNKNOWN" || (isRecord(packet.result) && packet.result.unknown === true);
			if (pending.mutation && !uncertain && this.credentials.outstanding?.id === packet.id) {
				try {
					const previous = this.credentials;
					const next = { ...previous, outstanding: undefined };
					await this.persist(next);
					if (this.socket !== socket || this.credentials !== previous) {
						pending.reject(new Error("DELIVERY_UNKNOWN"));
						return;
					}
					this.credentials = next;
				} catch {
					pending.reject(new Error("DELIVERY_UNKNOWN"));
					return;
				}
				void this.request("commands.ack", { commandId: packet.id }).catch(() => undefined);
			}
			if (packet.ok === true) pending.resolve(packet.result);
			else pending.reject(new Error(typeof packet.error === "string" ? packet.error : "REQUEST_FAILED"));
		}
	}
	/** Persist command identity before transmission; a manual retry reuses the same host receipt. */
	private async request(method: string, fields: Record<string, unknown> = {}): Promise<unknown> {
		if (this.state !== "connected" || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OFFLINE"));
		const sourceSocket = this.socket;
		const mutation = MUTATIONS.has(method);
		let id = [...random(16)].map((value) => value.toString(16).padStart(2, "0")).join("");
		if (mutation) {
			if (this.preparingMutation) throw new Error("DELIVERY_UNKNOWN");
			this.preparingMutation = true;
			try {
				const signature = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, commandIdentity(method, fields));
				if (sourceSocket !== this.socket || this.state !== "connected") throw new Error("OFFLINE");
				const credentials = this.credentials;
				if (!credentials) throw new Error("UNPAIRED");
				const previous = credentials.outstanding;
				if (previous) {
					if (previous.signature !== signature || previous.method !== method) throw new Error("DELIVERY_UNKNOWN");
					id = previous.id;
				} else {
					const outstanding: OutstandingCommand = {
						id,
						method,
						signature,
						...(fields.model ? { model: parseModelChoice(fields.model) } : {}),
						...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
						...(typeof fields.projectId === "string" ? { projectId: fields.projectId } : {}),
						...(fields.target ? { target: parseTarget(fields.target) } : {}),
					};
					const next = { ...credentials, outstanding };
					await this.persist(next);
					if (sourceSocket !== this.socket || this.credentials !== credentials) throw new Error("DELIVERY_UNKNOWN");
					this.credentials = next;
				}
			} finally {
				this.preparingMutation = false;
			}
		}
		if (sourceSocket !== this.socket || this.state !== "connected" || this.socket?.readyState !== WebSocket.OPEN) throw new Error(mutation ? "DELIVERY_UNKNOWN" : "OFFLINE");
		return new Promise((resolve, reject) => {
			if (this.pending.has(id)) {
				reject(new Error("DELIVERY_UNKNOWN"));
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(mutation ? "DELIVERY_UNKNOWN" : "REQUEST_TIMEOUT"));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer, mutation });
			try {
				this.socket?.send(seal({ kind: "request", id, challenge: this.challenge, issuedAt: Date.now(), method, ...fields }, this.derivedKey(), random));
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(mutation ? "DELIVERY_UNKNOWN" : "SEND_FAILED"));
			}
		});
	}
	private async reconcileOutstanding(): Promise<void> {
		const credentials = this.credentials;
		const command = credentials?.outstanding;
		if (!credentials || !command) return;
		const status = await this.request("commands.status", { commandId: command.id });
		if (isRecord(status) && status.state === "missing") {
			this.emit({ kind: "error", code: "COMMAND_NOT_RECEIVED" });
			return;
		}
		if (!isRecord(status) || status.state !== "done" || !isRecord(status.reply) || status.reply.error === "DELIVERY_UNKNOWN" || (isRecord(status.reply.result) && status.reply.result.unknown === true)) {
			this.emit({ kind: "error", code: "DELIVERY_UNKNOWN" });
			return;
		}
		if (this.credentials !== credentials) return;
		const next = { ...credentials, outstanding: undefined };
		await this.persist(next);
		if (this.credentials !== credentials) return;
		this.credentials = next;
		void this.request("commands.ack", { commandId: command.id }).catch(() => undefined);
		this.emit({ kind: "receipt", command, ok: status.reply.ok === true, result: status.reply.result });
	}
	async list(): Promise<void> {
		this.emit({ kind: "sessions", sessions: parseSessions(await this.request("sessions.list")) });
	}
	async projects(): Promise<RemoteProject[]> {
		return parseProjects(await this.request("projects.list"));
	}
	async tasks(): Promise<RemoteTask[]> {
		return parseTasks(await this.request("tasks.list"));
	}
	async history(sessionId: string, before?: number, beforeEntryId?: string): Promise<RemoteHistoryPage> {
		return parseHistory(await this.request("session.history", { sessionId, before, beforeEntryId }), sessionId);
	}
	async createTask(task: RemoteTaskInput): Promise<string> {
		const result = await this.request("tasks.create", { task });
		if (!isRecord(result) || typeof result.id !== "string") throw new Error("INVALID_TASK");
		return result.id;
	}
	async createSession(projectId: string, text: string, model?: ModelChoice): Promise<{ sessionId: string; accepted: boolean; unknown: boolean }> {
		if (model && !this.capabilities.has("session.model")) throw new Error("UPDATE_REQUIRED");
		const result = await this.request("session.create", { projectId, text, ...(model ? { model } : {}) });
		if (!isRecord(result) || typeof result.sessionId !== "string") throw new Error("INVALID_SESSION");
		// A failed read after successful creation must not become a retryable creation.
		void this.list().catch(() => this.emit({ kind: "error", code: "CATALOG_FAILED" }));
		return { sessionId: result.sessionId, accepted: result.accepted === true, unknown: result.unknown === true };
	}
	private publishSnapshot(snapshot: RemoteSnapshot): void {
		this.snapshots.set(snapshot.sessionId, snapshot);
		if (this.snapshots.size > 8) {
			const oldest = this.snapshots.keys().next().value;
			if (oldest && oldest !== snapshot.sessionId) this.snapshots.delete(oldest);
		}
		if (this.selected === snapshot.sessionId) this.emit({ kind: "snapshot", snapshot });
	}
	private acceptPatch(patch: RemotePatch): void {
		const previous = this.snapshots.get(patch.sessionId);
		if (!previous) throw new Error("STREAM_GAP");
		this.publishSnapshot(applyPatch(previous, patch));
	}
	async select(sessionId: string): Promise<void> {
		this.selected = sessionId;
		if (this.syncing.has(sessionId)) return;
		this.syncing.add(sessionId);
		this.streamBuffers.set(sessionId, []);
		try {
			const result = await this.request("session.read", { sessionId, cursor: this.snapshots.get(sessionId)?.cursor });
			if (isRecord(result) && result.kind === "sync" && Array.isArray(result.patches)) {
				if (result.snapshot) this.publishSnapshot(parseSnapshot(result.snapshot));
				for (const patch of result.patches) this.acceptPatch(parsePatch(patch));
				const snapshot = this.snapshots.get(sessionId);
				if (snapshot && this.selected === sessionId) this.emit({ kind: "snapshot", snapshot });
			} else this.publishSnapshot(parseSnapshot(result));
			for (const patch of this.streamBuffers.get(sessionId) ?? []) this.acceptPatch(patch);
		} finally {
			this.syncing.delete(sessionId);
			this.streamBuffers.delete(sessionId);
		}
	}
	/** 显式发送是激活入口：没有运行时目标时由主机激活，拿到新目标后并入当前视图。 */
	async send(snapshot: RemoteSnapshot, text: string, model?: ModelChoice): Promise<void> {
		if (model && !this.capabilities.has("session.model")) throw new Error("UPDATE_REQUIRED");
		const result = await this.request("session.send", { sessionId: snapshot.sessionId, ...(snapshot.target ? { target: snapshot.target } : {}), text, ...(model ? { model } : {}) });
		if (isRecord(result) && result.accepted === true && result.target) {
			const target = parseTarget(result.target);
			const current = this.snapshots.get(snapshot.sessionId) ?? snapshot;
			this.publishSnapshot({ ...current, target });
		}
	}
	/** 结果已进入可见区域：绑定当前结果身份确认已读（另一端随即清除同一结果的未读）。 */
	async acknowledge(sessionId: string, completionId: string): Promise<void> {
		await this.request("attention.ack", { sessionId, completionId });
	}

	async abort(snapshot: RemoteSnapshot): Promise<void> {
		await this.request("session.abort", { sessionId: snapshot.sessionId, target: snapshot.target });
	}
	async answer(snapshot: RemoteSnapshot, questionId: string, answer: boolean | string): Promise<void> {
		await this.request("ui.respond", { sessionId: snapshot.sessionId, target: snapshot.target, questionId, answer });
	}
	async artifacts(sessionId: string): Promise<RemoteArtifact[]> {
		return parseArtifacts(await this.request("artifacts.list", { sessionId }));
	}
	async messagePart(sessionId: string, messageId: string, channel: MessageChannel, offset: number, entryId?: string, version?: string): Promise<RemoteMessagePart> {
		return parseMessagePart(await this.request("message.read", { sessionId, messageId, channel, offset, entryId, version }), messageId, channel, offset, version);
	}
	async download(artifact: RemoteArtifact, progress: (received: number) => void): Promise<Uint8Array> {
		return downloadRemoteArtifact(artifact, (fields) => this.request("artifact.read", fields), progress);
	}
	async models(sessionId?: string, projectId?: string): Promise<RemoteModel[]> {
		if (!this.capabilities.has("models.list")) throw new Error("UPDATE_REQUIRED");
		return parseModels(await this.request("models.list", { sessionId, projectId }));
	}
	async fork(snapshot: RemoteSnapshot, entryId: string): Promise<{ sessionId: string; text: string }> {
		if (!this.capabilities.has("session.fork")) throw new Error("UPDATE_REQUIRED");
		const result = await this.request("session.fork", { sessionId: snapshot.sessionId, target: snapshot.target, entryId });
		if (!isRecord(result) || typeof result.sessionId !== "string" || typeof result.text !== "string") throw new Error("FORK_UNAVAILABLE");
		return { sessionId: result.sessionId, text: result.text };
	}

	dispose(): void {
		this.disposed = true;
		this.appStateSubscription.remove();
		this.disconnect();
		this.listeners.clear();
	}
}
