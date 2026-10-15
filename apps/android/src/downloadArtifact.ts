import * as Crypto from "expo-crypto";
import { decode, isRecord } from "../../../packages/tpa-remote/src/crypto";
import type { RemoteArtifact } from "../../../packages/tpa-remote/src/types";

/** Verify bounded encrypted chunks and the final digest before exposing a downloaded artifact. */
export async function downloadRemoteArtifact(artifact: RemoteArtifact, read: (fields: { sessionId: string; artifactId: string; offset: number }) => Promise<unknown>, progress: (received: number) => void): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let offset = 0;
	if (artifact.bytes < 0 || artifact.bytes > 10_000_000 || !Number.isSafeInteger(artifact.bytes)) throw new Error("INVALID_FILE");
	while (offset < artifact.bytes) {
		const result = await read({ sessionId: artifact.sessionId, artifactId: artifact.id, offset });
		if (!isRecord(result) || result.offset !== offset || typeof result.data !== "string") throw new Error("INVALID_FILE");
		const bytes = decode(result.data);
		if (!bytes.length || bytes.length > 96_000 || offset + bytes.length > artifact.bytes) throw new Error("INVALID_FILE");
		parts.push(bytes);
		offset += bytes.length;
		progress(offset);
	}
	const file = new Uint8Array(offset);
	let position = 0;
	for (const part of parts) {
		file.set(part, position);
		position += part.length;
	}
	const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, file));
	if ([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") !== artifact.digest) throw new Error("FILE_CHANGED");
	return file;
}
