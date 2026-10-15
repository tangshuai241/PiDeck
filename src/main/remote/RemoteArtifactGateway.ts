import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DocumentWorkDomain } from "../document-work";
import { containPath, fingerprintFile, resolveInsideDirectory } from "../document-work/documentWorkPaths";
import type { RemoteArtifact, Request } from "../../../packages/tpa-remote/src/types";

/** Exposes immutable archived versions by opaque identity, never a phone-supplied path. */
export function createRemoteArtifactGateway(getDomain: () => DocumentWorkDomain | null) {
	const MAX_FILE_BYTES = 10_000_000;
	const allowed = new Map<string, { sessionId: string; path: string; root: string; digest: string; bytes: number }>();
	async function list(sessionId: string): Promise<RemoteArtifact[]> {
		const domain = getDomain();
		if (!domain) return [];
		const result: RemoteArtifact[] = [];
		for (const work of (await domain.service.listForSession(sessionId)).slice(0, 20)) {
			for (const item of work.versions.slice(0, 10)) {
				const version = await domain.store.getVersion(work.workId, item.versionId);
				if (!version) continue;
				const root = domain.artifacts.snapshotDirectory(work.workId, item.versionId);
				for (const file of version.artifacts.filter((entry) => entry.role === "primary").slice(0, 3)) {
					if (file.bytes > MAX_FILE_BYTES) continue;
					const id = createHash("sha256")
						.update(JSON.stringify([sessionId, work.workId, item.versionId, file.relativePath, file.digest]))
						.digest("hex");
					const path = resolveInsideDirectory(root, file.relativePath);
					if (!path) continue;
					if (allowed.size >= 1000) allowed.clear();
					allowed.set(id, { sessionId, path, root, digest: file.digest, bytes: file.bytes });
					result.push({ id, sessionId, title: work.title, fileName: basename(file.relativePath), version: item.ordinal, bytes: file.bytes, digest: file.digest });
				}
			}
		}
		return result;
	}
	async function read(request: Request): Promise<{ offset: number; data: string; done: boolean }> {
		const item = request.artifactId ? allowed.get(request.artifactId) : undefined;
		if (!item || item.sessionId !== request.sessionId || request.offset === undefined) throw new Error("ARTIFACT_UNAVAILABLE");
		const containment = await containPath(item.root, item.path);
		if (!containment.ok) throw new Error("ARTIFACT_UNAVAILABLE");
		const info = await stat(containment.realPath);
		if (!info.isFile() || info.size > MAX_FILE_BYTES || info.size !== item.bytes || request.offset > info.size) throw new Error("ARTIFACT_CHANGED");
		if (request.offset === 0 && (await fingerprintFile(containment.realPath, MAX_FILE_BYTES))?.digest !== item.digest) throw new Error("ARTIFACT_CHANGED");
		const file = await open(containment.realPath, "r");
		try {
			const buffer = Buffer.alloc(Math.min(96_000, info.size - request.offset));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, request.offset);
			return { offset: request.offset, data: buffer.subarray(0, bytesRead).toString("base64"), done: request.offset + bytesRead >= info.size };
		} finally {
			await file.close();
		}
	}
	return { list, read };
}
