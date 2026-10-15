import { createHash, randomBytes } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import { decode, encode, isRecord, open, seal, sharedKey } from "../../../packages/tpa-remote/src/crypto";
import { MUTATIONS, parseRequest } from "../../../packages/tpa-remote/src/request";
import type { RemoteCompanionConfig, RemoteHostConfig } from "../config/RemoteCompanionConfig";
import type { RemoteCompanionResult, RemoteCompanionStatus } from "../../shared/types/remoteCompanion";
import type { RemoteGateway } from "./RemoteSessionGateway";
import type { RemoteCommandLedger } from "./RemoteCommandLedger";
import { RemoteSessionFeed } from "./RemoteSessionFeed";
import { interactionError } from "./RemoteInteractionGateway";

type Dependencies = { config: RemoteCompanionConfig; ledger: RemoteCommandLedger; gateway: RemoteGateway; confirmDevice: (name: string) => Promise<boolean>; log: (event: string) => void };
const random = (length: number) => new Uint8Array(randomBytes(length));

/** Owns a single private host/phone channel, its pairing and every socket/timer cleanup. */
export class RemoteCompanionService {
	private readonly deps: Dependencies;
	private config: RemoteHostConfig | undefined;
	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly feed: RemoteSessionFeed;
	private unsubscribe: (() => void) | undefined;
	private stopped = false;
	private authenticated = false;
	private challenge = "";
	private selected = "";
	private key: Uint8Array | undefined;
	private generation = 0;
	private retry = 0;
	private configTail: Promise<unknown> = Promise.resolve();
	private error: string | undefined;
	constructor(deps: Dependencies) {
		this.deps = deps;
		this.feed = new RemoteSessionFeed(
			(sessionId) => deps.gateway.snapshot(sessionId),
			(patch) => {
				if (this.authenticated && this.selected === patch.sessionId) this.send(patch);
			},
			() => {
				this.error = "SYNC_FAILED";
			},
		);
	}
	async start(): Promise<void> {
		await this.deps.ledger.load();
		this.config = await this.deps.config.read();
		if (this.config?.enabled) this.connect();
		this.unsubscribe = this.deps.gateway.subscribe?.((sessionId) => this.feed.invalidate(sessionId));
	}
	status(): RemoteCompanionStatus {
		return { configured: !!this.config, enabled: this.config?.enabled ?? false, connected: this.socket?.readyState === WebSocket.OPEN, paired: !!this.config?.phone, deviceName: this.config?.phone?.name, ...(this.error ? { error: this.error } : {}) };
	}
	createInvitation(): Promise<RemoteCompanionResult> {
		const generation = this.generation;
		return this.mutateConfig(() => this.createInvitationNow(generation));
	}
	private async createInvitationNow(generation: number): Promise<RemoteCompanionResult> {
		if (generation !== this.generation || this.stopped) return { ok: false, error: "PAIRING_CANCELLED" };
		if (!this.config) return { ok: false, error: "NOT_CONFIGURED" };
		if (this.config.phone) return { ok: false, error: "ALREADY_PAIRED" };
		const phoneToken = randomBytes(32).toString("hex");
		await this.rotatePhoneToken(phoneToken);
		if (generation !== this.generation || this.stopped) return { ok: false, error: "PAIRING_CANCELLED" };
		const config = { ...this.config, phoneToken, enabled: true, invite: { key: encode(random(32)), expiresAt: Date.now() + 10 * 60_000 } };
		await this.deps.config.write(config);
		if (generation !== this.generation || this.stopped) return { ok: false, error: "PAIRING_CANCELLED" };
		this.config = config;
		this.restartConnection();
		const pairing = JSON.stringify({ v: 1, relay: config.relay, room: config.room, token: config.phoneToken, hostKey: config.hostPublicKey, key: config.invite.key, expiresAt: config.invite.expiresAt });
		return { ok: true, status: this.status(), pairing };
	}
	async revoke(): Promise<RemoteCompanionResult> {
		if (!this.config) return { ok: false, error: "NOT_CONFIGURED" };
		this.generation++;
		this.disconnect();
		this.config = { ...this.config, enabled: false, phone: undefined, invite: undefined };
		this.feed.clear();
		return this.mutateConfig(async () => {
			if (!this.config) return { ok: false, error: "NOT_CONFIGURED" };
			await this.deps.config.write(this.config);
			try {
				await this.rotatePhoneToken(randomBytes(32).toString("hex"));
			} catch {
				this.error = "ROUTE_REVOCATION_PENDING";
			}
			return { ok: true, status: this.status() };
		});
	}
	private mutateConfig(action: () => Promise<RemoteCompanionResult>): Promise<RemoteCompanionResult> {
		const work = this.configTail.then(action);
		this.configTail = work.catch(() => undefined);
		return work;
	}
	dispose(): void {
		this.stopped = true;
		this.generation++;
		this.disconnect();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.feed.dispose();
	}
	private disconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.authenticated = false;
		this.selected = "";
		this.key = undefined;
		const old = this.socket;
		this.socket = undefined;
		old?.close();
	}
	private restartConnection(): void {
		this.generation++;
		this.disconnect();
		this.retry = 0;
		this.connect();
	}
	private connect(): void {
		const config = this.config;
		if (this.stopped || !config?.enabled) return;
		const socket = new WebSocket(`${config.relay}/${config.room}/host`, ["tpa-v1", config.hostToken]);
		this.socket = socket;
		let tail = Promise.resolve();
		socket.addEventListener("open", () => {
			if (this.socket !== socket) return;
			this.retry = 0;
			this.error = undefined;
			this.deps.log("relay_connected");
		});
		socket.addEventListener("message", (event) => {
			if (this.socket !== socket || typeof event.data !== "string") return;
			const data = event.data;
			tail = tail
				.then(() => this.receive(data, socket))
				.catch(() => {
					this.error = "CHANNEL_REJECTED";
					this.authenticated = false;
					socket.close(1008, "invalid channel");
				});
		});
		socket.addEventListener("error", () => {
			if (this.socket === socket) this.error = "CONNECTION_FAILED";
		});
		socket.addEventListener("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.authenticated = false;
			this.selected = "";
			if (!this.stopped && this.config?.enabled) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)) + Math.floor(Math.random() * 500));
		});
	}
	private send(value: unknown): void {
		if (this.key && this.socket?.readyState === WebSocket.OPEN) this.socket.send(seal(value, this.key, random));
	}
	private beginChallenge(): void {
		this.authenticated = false;
		this.selected = "";
		const config = this.config;
		if (!config?.enabled) return;
		if (config.phone) this.key = sharedKey(decode(config.phone.publicKey), decode(config.hostSecretKey));
		else if (config.invite && config.invite.expiresAt > Date.now()) this.key = decode(config.invite.key);
		else return;
		this.challenge = encode(random(32));
		this.send({ kind: "challenge", challenge: this.challenge, paired: !!config.phone });
	}
	private async receive(data: string, socket: WebSocket): Promise<void> {
		if (this.socket !== socket) return;
		if (data.length > 2_000_000) throw new Error("PACKET_TOO_LARGE");
		const raw: unknown = JSON.parse(data);
		if (isRecord(raw) && raw.relay === "peer") {
			if (raw.online === true) this.beginChallenge();
			else {
				this.authenticated = false;
				this.selected = "";
			}
			return;
		}
		if (!this.key || !this.config?.enabled || this.socket !== socket) return;
		const packet = open(data, this.key);
		if (packet.kind === "authenticate") {
			if (packet.challenge !== this.challenge || typeof packet.deviceKey !== "string" || decode(packet.deviceKey).length !== 32 || typeof packet.deviceName !== "string" || packet.deviceName.length > 80) throw new Error("INVALID_AUTHENTICATION");
			const generation = this.generation;
			const config = this.config;
			if (config.phone && config.phone.publicKey !== packet.deviceKey) throw new Error("DEVICE_REVOKED");
			const derived = sharedKey(decode(packet.deviceKey), decode(config.hostSecretKey));
			if (!config.phone) {
				if (!config.invite || config.invite.expiresAt < Date.now() || !(await this.deps.confirmDevice(packet.deviceName))) throw new Error("PAIRING_REJECTED");
				if (generation !== this.generation || this.socket !== socket || !this.config?.enabled) return;
				const updated = { ...config, phone: { publicKey: packet.deviceKey, name: packet.deviceName }, invite: undefined };
				await this.deps.config.write(updated);
				if (generation !== this.generation || this.socket !== socket || !this.config?.enabled) return;
				this.config = updated;
			}
			if (generation !== this.generation || this.socket !== socket) return;
			this.key = derived;
			this.authenticated = true;
			this.send({ kind: "authenticated", challenge: this.challenge, hostName: "TPA", capabilities: ["models.list", "session.model", "session.fork"] });
			this.send({ kind: "sessions", sessions: this.deps.gateway.list() });
			return;
		}
		if (!this.authenticated) throw new Error("UNAUTHENTICATED");
		const request = parseRequest(packet, this.challenge);
		const generation = this.generation;
		const execute = async () => {
			if (this.socket !== socket || !this.authenticated || generation !== this.generation) return { kind: "response" as const, id: request.id, ok: false, error: "DEVICE_REVOKED" };
			try {
				if (request.method === "commands.status" && request.commandId) return { kind: "response" as const, id: request.id, ok: true, result: this.deps.ledger.status(request.commandId) };
				if (request.method === "commands.ack" && request.commandId) {
					await this.deps.ledger.acknowledge(request.commandId);
					return { kind: "response" as const, id: request.id, ok: true };
				}
				if (request.method === "session.read" && request.sessionId) {
					// Only an explicit phone read may activate a session. Passive feed refreshes
					// must not restart a process that was stopped on the computer.
					await this.deps.gateway.snapshot(request.sessionId, true);
					this.selected = request.sessionId;
					return { kind: "response" as const, id: request.id, ok: true, result: await this.feed.synchronize(request.sessionId, request.cursor) };
				}
				const result = await this.deps.gateway.execute(request);
				if (result.ok && request.sessionId && MUTATIONS.has(request.method)) this.feed.invalidate(request.sessionId);
				return result;
			} catch (error) {
				return { kind: "response" as const, id: request.id, ok: false, error: interactionError(error) ?? (MUTATIONS.has(request.method) ? "DELIVERY_UNKNOWN" : "REQUEST_FAILED") };
			}
		};
		const reply = MUTATIONS.has(request.method) ? await this.deps.ledger.run(request, execute) : await execute();
		if (this.socket !== socket || generation !== this.generation || !this.authenticated) return;
		if (request.method === "session.read" && reply.ok) this.selected = request.sessionId ?? "";
		this.send(reply);
	}
	private async rotatePhoneToken(phoneToken: string): Promise<void> {
		if (!this.config) throw new Error("NOT_CONFIGURED");
		const config = this.config;
		const endpoint = config.relay.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
		const response = await fetch(`${endpoint}/${config.room}/route`, { method: "PUT", headers: { Authorization: `Bearer ${config.hostToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ phoneHash: createHash("sha256").update(phoneToken).digest("hex") }), signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error("ROUTE_UPDATE_FAILED");
	}
}
