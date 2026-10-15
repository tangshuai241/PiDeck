import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import { decode, encode, isRecord, open, parsePairing, seal } from "../../../packages/tpa-remote/src/crypto";
import { parseSessions, parseSnapshot } from "../../../packages/tpa-remote/src/projection";
import { parseTarget } from "../../../packages/tpa-remote/src/projection";
import type { RemoteSession, RemoteSnapshot } from "../../../packages/tpa-remote/src/types";
import type { Credentials } from "./phoneClient";
import { parseMobilePreferences, type MobilePreferences } from "./mobilePreferences";
import { parseModelChoice } from "../../../packages/tpa-remote/src/models";

export type LocalCache = { sessions: RemoteSession[]; snapshot?: RemoteSnapshot; drafts: Record<string, string>; preferences: MobilePreferences };
const credentialsKey = "tpa.remote.device.v1";
const cacheKeyName = "tpa.remote.cache-key.v1";
const cachePath = `${FileSystem.documentDirectory}tpa-cache.bin`;
let writeTail = Promise.resolve();
let credentialsTail = Promise.resolve();

/** Android Keystore-backed storage holds only routing credentials and device keys. */
export function saveCredentials(value: Credentials | undefined): Promise<void> {
	// Removal must be ordered after any in-flight identity/receipt write.
	const work = credentialsTail.then(async () => {
		if (value) await SecureStore.setItemAsync(credentialsKey, JSON.stringify(value));
		else {
			await SecureStore.deleteItemAsync(credentialsKey);
			await writeTail;
			await FileSystem.deleteAsync(cachePath, { idempotent: true });
		}
	});
	credentialsTail = work.catch(() => undefined);
	return work;
}
export async function loadCredentials(): Promise<Credentials | undefined> {
	const text = await SecureStore.getItemAsync(credentialsKey);
	if (!text) return undefined;
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || !isRecord(value.pairing) || typeof value.secretKey !== "string" || typeof value.publicKey !== "string" || typeof value.paired !== "boolean" || typeof value.pairing.expiresAt !== "number" || decode(value.secretKey).length !== 32 || decode(value.publicKey).length !== 32)
		throw new Error("INVALID_CREDENTIALS");
	// Established credentials remain usable after the one-time invitation expires.
	const pairing = parsePairing(JSON.stringify(value.pairing), value.paired ? value.pairing.expiresAt - 1 : Date.now());
	const command = value.outstanding;
	if (command !== undefined && (!isRecord(command) || typeof command.id !== "string" || !/^[a-f0-9]{32}$/.test(command.id) || typeof command.method !== "string" || typeof command.signature !== "string" || !/^[a-f0-9]{64}$/.test(command.signature))) throw new Error("INVALID_CREDENTIALS");
	return {
		pairing,
		secretKey: value.secretKey,
		publicKey: value.publicKey,
		paired: value.paired,
		...(isRecord(command) && typeof command.id === "string" && typeof command.method === "string" && typeof command.signature === "string"
			? {
					outstanding: {
						id: command.id,
						method: command.method,
						signature: command.signature,
						...(command.model !== undefined ? { model: parseModelChoice(command.model) } : {}),
						...(typeof command.sessionId === "string" ? { sessionId: command.sessionId } : {}),
						...(typeof command.projectId === "string" ? { projectId: command.projectId } : {}),
						...(command.target ? { target: parseTarget(command.target) } : {}),
					},
				}
			: {}),
	};
}
async function cacheKey(): Promise<Uint8Array> {
	let value = await SecureStore.getItemAsync(cacheKeyName);
	if (!value) {
		value = encode(Crypto.getRandomBytes(32));
		await SecureStore.setItemAsync(cacheKeyName, value);
	}
	return decode(value);
}
/** Cache content is encrypted independently from transport and device identity keys. */
export function saveCache(cache: LocalCache): Promise<void> {
	const copy = { ...cache, drafts: Object.fromEntries(Object.entries(cache.drafts).slice(-5)) };
	const work = writeTail.then(async () => {
		const packet = seal({ kind: "cache", ...copy }, await cacheKey(), (length) => Crypto.getRandomBytes(length));
		await FileSystem.writeAsStringAsync(`${cachePath}.tmp`, packet);
		await FileSystem.moveAsync({ from: `${cachePath}.tmp`, to: cachePath });
	});
	writeTail = work.catch(() => undefined);
	return work;
}
export async function loadCache(): Promise<LocalCache> {
	const info = await FileSystem.getInfoAsync(cachePath);
	if (!info.exists) return { sessions: [], drafts: {}, preferences: { pins: {} } };
	if (info.isDirectory || info.size > 2_000_000) throw new Error("INVALID_CACHE");
	const value = open(await FileSystem.readAsStringAsync(cachePath), await cacheKey());
	const drafts: Record<string, string> = {};
	if (isRecord(value.drafts)) for (const [key, text] of Object.entries(value.drafts).slice(-20)) if (typeof text === "string" && text.length <= 20_000) drafts[key] = text;
	return { sessions: parseSessions(value.sessions), drafts, preferences: parseMobilePreferences(value.preferences), ...(value.snapshot ? { snapshot: parseSnapshot(value.snapshot) } : {}) };
}
