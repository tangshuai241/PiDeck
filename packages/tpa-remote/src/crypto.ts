import nacl from "tweetnacl";
import { fromByteArray, toByteArray } from "base64-js";
import type { Pairing } from "./types.ts";

export type RandomSource = (length: number) => Uint8Array;
export const MAX_PACKET_BYTES = 2_000_000;

/** Cross-platform base64 without Node Buffer or browser globals. */
export function encode(bytes: Uint8Array): string {
	return fromByteArray(bytes);
}
export function decode(value: string): Uint8Array {
	if (value.length > MAX_PACKET_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("INVALID_BASE64");
	return toByteArray(value);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Use XSalsa20-Poly1305 as implemented by TweetNaCl, with a fresh 192-bit nonce. */
export function seal(value: unknown, key: Uint8Array, random: RandomSource): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	if (bytes.length > 1_000_000) throw new Error("PACKET_TOO_LARGE");
	const nonce = random(nacl.secretbox.nonceLength);
	return JSON.stringify({ v: 1, nonce: encode(nonce), box: encode(nacl.secretbox(bytes, nonce, key)) });
}

/** Authentication must succeed before any packet field is used as a command. */
export function open(packet: string, key: Uint8Array): Record<string, unknown> {
	if (packet.length > MAX_PACKET_BYTES) throw new Error("PACKET_TOO_LARGE");
	const wire: unknown = JSON.parse(packet);
	if (!isRecord(wire) || wire.v !== 1 || typeof wire.nonce !== "string" || typeof wire.box !== "string") throw new Error("INVALID_PACKET");
	const plain = nacl.secretbox.open(decode(wire.box), decode(wire.nonce), key);
	if (!plain) throw new Error("AUTHENTICATION_FAILED");
	const value: unknown = JSON.parse(new TextDecoder().decode(plain));
	if (!isRecord(value) || typeof value.kind !== "string") throw new Error("INVALID_PACKET");
	return value;
}

/** Long-lived device keys are separate from the one-time pairing secret. */
export function keyPair(random: RandomSource): nacl.BoxKeyPair {
	return nacl.box.keyPair.fromSecretKey(random(32));
}
export function sharedKey(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
	if (publicKey.length !== 32 || secretKey.length !== 32 || nacl.scalarMult(secretKey, publicKey).every((byte) => byte === 0)) throw new Error("INVALID_DEVICE_KEY");
	return nacl.box.before(publicKey, secretKey);
}

/** Pairing data is password-equivalent; callers never include it in logs. */
export function parsePairing(text: string, now = Date.now()): Pairing {
	if (text.length > 4096) throw new Error("INVALID_PAIRING");
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.v !== 1 || typeof value.relay !== "string" || typeof value.room !== "string" || typeof value.token !== "string" || typeof value.key !== "string" || typeof value.hostKey !== "string" || typeof value.expiresAt !== "number") throw new Error("INVALID_PAIRING");
	const url = new URL(value.relay);
	if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{32,64}$/.test(value.room) || !/^[a-f0-9]{64}$/.test(value.token) || decode(value.key).length !== 32 || decode(value.hostKey).length !== 32 || value.expiresAt <= now || value.expiresAt > now + 20 * 60_000)
		throw new Error("INVALID_PAIRING");
	return { v: 1, relay: url.href.replace(/\/$/, ""), room: value.room, token: value.token, key: value.key, hostKey: value.hostKey, expiresAt: value.expiresAt };
}
