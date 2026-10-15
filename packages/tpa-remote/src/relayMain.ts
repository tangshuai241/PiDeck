import { readFile, writeFile, rename } from "node:fs/promises";
import { createRelay } from "./relay.ts";
import { isRecord } from "./crypto.ts";

/** Fixed-release entrypoint; configuration is private and never echoed. */
async function main() {
	const raw: unknown = JSON.parse(await readFile(process.env.TPA_RELAY_CONFIG ?? "/etc/tpa-relay/config.json", "utf8"));
	if (!isRecord(raw) || !Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 20 || typeof raw.bind !== "string" || !Number.isSafeInteger(raw.port) || typeof raw.port !== "number" || raw.port < 1024 || raw.port > 65535) throw new Error("INVALID_CONFIG");
	const rooms = raw.rooms.map((room: unknown) => {
		if (!isRecord(room) || typeof room.id !== "string" || !/^[a-f0-9]{32,64}$/.test(room.id) || typeof room.hostHash !== "string" || !/^[a-f0-9]{64}$/.test(room.hostHash) || typeof room.phoneHash !== "string" || !/^[a-f0-9]{64}$/.test(room.phoneHash)) throw new Error("INVALID_CONFIG");
		return { id: room.id, hostHash: room.hostHash, phoneHash: room.phoneHash };
	});
	const statePath = process.env.TPA_RELAY_STATE ?? "/var/lib/tpa-relay/routes.json";
	try {
		const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
		if (isRecord(state))
			for (const room of rooms) {
				const hash = state[room.id];
				if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) room.phoneHash = hash;
			}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
	}
	let writeTail = Promise.resolve();
	const relay = createRelay({
		rooms,
		persistRotation: (roomId, phoneHash) => {
			const work = writeTail.then(async () => {
				const state = Object.fromEntries(rooms.map((room) => [room.id, room.id === roomId ? phoneHash : room.phoneHash]));
				await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
				await rename(`${statePath}.tmp`, statePath);
			});
			writeTail = work.catch(() => undefined);
			return work;
		},
	});
	relay.server.once("error", () => {
		process.stderr.write("Relay listener failed\n");
		process.exitCode = 1;
		void relay.dispose();
	});
	relay.server.listen(raw.port, raw.bind);
	for (const signal of ["SIGINT", "SIGTERM"])
		process.once(signal, () => {
			void relay.dispose().then(() => {
				process.exitCode = 0;
			});
		});
}
void main().catch(() => {
	process.stderr.write("Relay startup failed\n");
	process.exitCode = 1;
});
