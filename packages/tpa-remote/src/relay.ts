import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setInterval, clearInterval } from "node:timers";
import { WebSocketServer, WebSocket } from "ws";

export type RelayRoom = { id: string; hostHash: string; phoneHash: string };
export type RelayOptions = { rooms: RelayRoom[]; prefix?: string; persistRotation?: (roomId: string, phoneHash: string) => Promise<void> };

/** Opaque bounded forwarding only: keys, commands and message plaintext never enter the relay. */
export function createRelay(options: RelayOptions) {
	const prefix = options.prefix ?? "/tpa-relay/v1";
	const peers = new Map<string, { host?: WebSocket; phone?: WebSocket }>();
	const alive = new WeakSet<WebSocket>();
	const admission = new Map<string, { at: number; count: number }>();
	let closing = false;
	let rotationTail: Promise<void> = Promise.resolve();
	async function rotate(req: IncomingMessage, res: ServerResponse) {
		const roomId = req.url?.slice(`${prefix}/`.length).split("/")[0];
		const room = options.rooms.find((item) => item.id === roomId);
		const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		const actual = createHash("sha256").update(token).digest();
		const expected = Buffer.from(room?.hostHash ?? "", "hex");
		if (!room || !/^[a-f0-9]{64}$/.test(token) || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			res.writeHead(401).end();
			return;
		}
		let body = "";
		for await (const chunk of req) {
			body += chunk.toString();
			if (body.length > 512) {
				res.writeHead(413).end();
				return;
			}
		}
		const input: unknown = JSON.parse(body);
		if (typeof input !== "object" || !input || !("phoneHash" in input) || typeof input.phoneHash !== "string" || !/^[a-f0-9]{64}$/.test(input.phoneHash)) {
			res.writeHead(400).end();
			return;
		}
		const phoneHash = input.phoneHash;
		// Serialize persistence and publication together so concurrent rotations cannot
		// leave a persisted token different from the token accepted by this process.
		const rotation = rotationTail.then(async () => {
			await options.persistRotation?.(room.id, phoneHash);
			room.phoneHash = phoneHash;
			const roomPeers = peers.get(room.id);
			const old = roomPeers?.phone;
			if (roomPeers) delete roomPeers.phone;
			if (roomPeers?.host?.readyState === WebSocket.OPEN) roomPeers.host.send(JSON.stringify({ relay: "peer", online: false }));
			old?.close(4003, "revoked");
		});
		rotationTail = rotation.catch(() => undefined);
		await rotation;
		res.writeHead(204).end();
	}
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (req.method === "PUT" && req.url?.startsWith(`${prefix}/`) && new RegExp(`^${prefix}/[a-f0-9]{32,64}/route$`).test(req.url)) {
			void rotate(req, res).catch(() => {
				if (!res.headersSent) res.writeHead(400).end();
			});
			return;
		}
		if (req.url === `${prefix}/health`) {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ ok: !closing, version: "0.1.0" }));
		} else res.writeHead(404).end();
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000, perMessageDeflate: false, handleProtocols: () => "tpa-v1" });
	server.on("upgrade", (req, socket, head) => {
		const reject = () => {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		};
		if (closing || !req.url || req.url.includes("?") || req.url.length > 250) return reject();
		const parts = req.url.slice(prefix.length).split("/");
		if (!req.url.startsWith(`${prefix}/`) || parts.length !== 3) return reject();
		const roomId = parts[1];
		const role = parts[2];
		if (role !== "host" && role !== "phone") return reject();
		const room = options.rooms.find((item) => item.id === roomId);
		const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim());
		const token = protocols?.length === 2 && protocols[0] === "tpa-v1" ? protocols[1] : "";
		if (!room || !/^[a-f0-9]{64}$/.test(token)) return reject();
		const expected = Buffer.from(role === "host" ? room.hostHash : room.phoneHash, "hex");
		const actual = createHash("sha256").update(token).digest();
		if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return reject();
		const address = socket.remoteAddress ?? "unknown";
		const now = Date.now();
		const budget = admission.get(address);
		if (budget && now - budget.at < 60_000 && budget.count >= 120) return reject();
		if (admission.size > 1024) admission.clear();
		admission.set(address, budget && now - budget.at < 60_000 ? { ...budget, count: budget.count + 1 } : { at: now, count: 1 });
		wss.handleUpgrade(req, socket, head, (ws) => {
			const roomPeers = peers.get(roomId) ?? {};
			roomPeers[role]?.close(4001, "replaced");
			roomPeers[role] = ws;
			peers.set(roomId, roomPeers);
			alive.add(ws);
			const counterpart = () => (role === "host" ? roomPeers.phone : roomPeers.host);
			const notify = (target: WebSocket | undefined, online: boolean) => {
				if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify({ relay: "peer", online }));
			};
			notify(ws, counterpart()?.readyState === WebSocket.OPEN);
			notify(counterpart(), true);
			let windowAt = now;
			let messageCount = 0;
			ws.on("pong", () => alive.add(ws));
			ws.on("error", () => ws.terminate());
			ws.on("message", (data, binary) => {
				if (roomPeers[role] !== ws) return;
				if (Date.now() - windowAt > 1000) {
					windowAt = Date.now();
					messageCount = 0;
				}
				if (++messageCount > 100 || binary) {
					ws.close(1008, "rate or format");
					return;
				}
				const target = counterpart();
				if (!target || target.readyState !== WebSocket.OPEN) return;
				if (target.bufferedAmount > 4_000_000) {
					target.close(1013, "slow peer");
					return;
				}
				target.send(data, { binary: false });
			});
			ws.on("close", () => {
				if (roomPeers[role] !== ws) return;
				delete roomPeers[role];
				notify(counterpart(), false);
				if (!roomPeers.host && !roomPeers.phone) peers.delete(roomId);
			});
		});
	});
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (!alive.has(ws)) {
				ws.terminate();
				continue;
			}
			alive.delete(ws);
			ws.ping();
		}
	}, 25_000);
	heartbeat.unref();
	/** Close every listener and socket so tests and service shutdown leave no background handles. */
	async function dispose(): Promise<void> {
		closing = true;
		clearInterval(heartbeat);
		for (const ws of wss.clients) ws.terminate();
		await new Promise<void>((done) => wss.close(() => done()));
		if (server.listening) await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
	return { server, dispose };
}
