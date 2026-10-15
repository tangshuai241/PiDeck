import { decode, encode, isRecord, keyPair } from "../../../packages/tpa-remote/src/crypto";

export type RemoteHostConfig = {
	version: 1;
	enabled: boolean;
	relay: string;
	room: string;
	hostToken: string;
	phoneToken: string;
	hostPublicKey: string;
	hostSecretKey: string;
	invite?: { key: string; expiresAt: number };
	phone?: { publicKey: string; name: string };
};

/** Validate local provisioning as strictly as encrypted settings before any connection opens. */
export function parseRemoteHostSettings(value: unknown): RemoteHostConfig {
	if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.relay !== "string" || typeof value.room !== "string" || typeof value.hostToken !== "string" || typeof value.phoneToken !== "string" || typeof value.hostPublicKey !== "string" || typeof value.hostSecretKey !== "string")
		throw new Error("INVALID_CONFIG");
	const url = new URL(value.relay);
	if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{32,64}$/.test(value.room) || !/^[a-f0-9]{64}$/.test(value.hostToken) || !/^[a-f0-9]{64}$/.test(value.phoneToken) || decode(value.hostPublicKey).length !== 32 || decode(value.hostSecretKey).length !== 32)
		throw new Error("INVALID_CONFIG");
	const secret = decode(value.hostSecretKey);
	if (encode(keyPair(() => secret).publicKey) !== value.hostPublicKey) throw new Error("INVALID_CONFIG");
	let invite: RemoteHostConfig["invite"];
	if (value.invite !== undefined) {
		if (!isRecord(value.invite) || typeof value.invite.key !== "string" || typeof value.invite.expiresAt !== "number" || !Number.isSafeInteger(value.invite.expiresAt) || decode(value.invite.key).length !== 32) throw new Error("INVALID_CONFIG");
		invite = { key: value.invite.key, expiresAt: value.invite.expiresAt };
	}
	let phone: RemoteHostConfig["phone"];
	if (value.phone !== undefined) {
		if (!isRecord(value.phone) || typeof value.phone.publicKey !== "string" || decode(value.phone.publicKey).length !== 32 || typeof value.phone.name !== "string" || !value.phone.name.trim() || value.phone.name.length > 80) throw new Error("INVALID_CONFIG");
		phone = { publicKey: value.phone.publicKey, name: value.phone.name };
	}
	return { version: 1, enabled: value.enabled, relay: url.href.replace(/\/$/, ""), room: value.room, hostToken: value.hostToken, phoneToken: value.phoneToken, hostPublicKey: value.hostPublicKey, hostSecretKey: value.hostSecretKey, invite, phone };
}
