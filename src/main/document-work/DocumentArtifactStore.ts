/**
 * 成果归档与基稿快照。
 *
 * 硬性不变量：
 * - 版本目录用排他创建（EEXIST 即换下一个序号），已存在的版本永不被覆盖；
 * - 归档时同时保存「公开成果副本」和「原始字节快照」，快照不随用户手改变化；
 * - 复制前后各取一次指纹，源文件在复制中变化返回 BASE_CHANGED，不写半个版本；
 * - 失败时保留原件、新稿和输入（不删 staging、不删已写出的快照）。
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { containPath, ensureDirectory, fingerprintFile, hashText, resolveInsideDirectory, writeFileAtomic } from "./documentWorkPaths";
import { isSafeRelativePath } from "../../shared/documentWork";
import type { DocumentArtifactEntry, DocumentArtifactVersion, VersionUserAcceptance } from "../../shared/types/documentWork";
import { formatVersionDirectory } from "../../shared/documentWork";

export type ArtifactStoreFailure = { reason: "changed" | "io" | "denied" | "empty" | "too_large" };

export type StagedFile = { relativePath: string; digest: string; bytes: number };

export type ArchiveInput = {
	workId: string;
	versionId: string;
	ordinal: number;
	title: string;
	kind: DocumentArtifactVersion["kind"];
	workDirectory: string;
	snapshotDirectory: string;
	stagingDirectory: string;
	files: readonly { relativePath: string; role: DocumentArtifactEntry["role"] }[];
	parentVersionId?: string;
	baseVersionId?: string;
	baseDigest?: string;
	generation?: DocumentArtifactVersion["generation"];
};

/** 版本目录的排他创建：已存在就换下一个序号，绝不复用旧目录。 */
export async function createExclusiveVersionDirectory(workDirectory: string, startOrdinal: number): Promise<{ ordinal: number; directory: string } | undefined> {
	for (let ordinal = startOrdinal; ordinal < startOrdinal + 1000; ordinal++) {
		const directory = formatVersionDirectory(ordinal);
		try {
			await mkdir(join(workDirectory, "versions", directory), { recursive: false });
			return { ordinal, directory };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			// 父目录不存在时先补齐一次，再重试当前序号。
			await ensureDirectory(join(workDirectory, "versions"));
			try {
				await mkdir(join(workDirectory, "versions", directory), { recursive: false });
				return { ordinal, directory };
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

export class DocumentArtifactStore {
	constructor(private readonly rootDir: string) {}

	get directory(): string {
		return this.rootDir;
	}

	workPublicDirectory(outputRootPath: string, workFolder: string): string {
		return join(outputRootPath, workFolder);
	}

	stagingDirectory(workDirectory: string, attemptId: string): string {
		return join(workDirectory, "staging", attemptId);
	}

	frozenPath(workId: string, attemptId: string, fileName: string): string {
		return join(this.rootDir, "frozen", workId, attemptId, fileName);
	}

	snapshotDirectory(workId: string, versionId: string): string {
		return join(this.rootDir, "snapshots", workId, versionId);
	}

	/** 公开成果目录必须仍在用户选择的输出根内（junction / 符号链接同样拦住）。 */
	async ensureWorkDirectory(outputRootPath: string, workFolder: string): Promise<{ ok: true; value: string } | { ok: false; reason: "denied" }> {
		const candidate = this.workPublicDirectory(outputRootPath, workFolder);
		const containment = await containPath(outputRootPath, candidate);
		if (!containment.ok) return { ok: false, reason: "denied" };
		await ensureDirectory(containment.realPath);
		return { ok: true, value: containment.realPath };
	}

	async ensureStagingDirectory(workDirectory: string, attemptId: string): Promise<{ ok: true; value: string } | { ok: false; reason: "denied" }> {
		const candidate = this.stagingDirectory(workDirectory, attemptId);
		const containment = await containPath(workDirectory, candidate);
		if (!containment.ok) return { ok: false, reason: "denied" };
		await ensureDirectory(containment.realPath);
		return { ok: true, value: containment.realPath };
	}

	/**
	 * 冻结本轮基稿副本：读前指纹 → 复制 → 读后指纹，两值不同就有限重试一次，
	 * 仍不一致返回 changed（调用方转 BASE_CHANGED，让用户重新发起）。
	 */
	async freezeBase(input: { workId: string; attemptId: string; sourcePath: string; fileName: string }): Promise<{ ok: true; value: { frozenPath: string; digest: string; bytes: number } } | { ok: false; reason: ArtifactStoreFailure["reason"] }> {
		const target = this.frozenPath(input.workId, input.attemptId, input.fileName);
		for (let attempt = 0; attempt < 2; attempt++) {
			const before = await fingerprintFile(input.sourcePath);
			if (!before) return { ok: false, reason: "io" };
			try {
				await ensureDirectory(dirname(target));
				await rm(target, { force: true });
				await cp(input.sourcePath, target);
			} catch {
				return { ok: false, reason: "io" };
			}
			const copied = await fingerprintFile(target);
			const after = await fingerprintFile(input.sourcePath);
			if (copied && after && copied.digest === before.digest && after.digest === before.digest) return { ok: true, value: { frozenPath: target, digest: before.digest, bytes: before.bytes } };
			await rm(target, { force: true }).catch(() => undefined);
			if (!after || !copied) return { ok: false, reason: "io" };
			if (after.digest !== before.digest) continue;
			return { ok: false, reason: "changed" };
		}
		return { ok: false, reason: "changed" };
	}

	/** 归档前把 staging 里的候选文件全部指纹化；空目录、超预算或读取失败都拒绝。 */
	async fingerprintStagedFiles(stagingDirectory: string, files: readonly { relativePath: string; role: DocumentArtifactEntry["role"] }[], byteBudget: number): Promise<{ ok: true; value: DocumentArtifactEntry[] } | { ok: false; reason: ArtifactStoreFailure["reason"] }> {
		const entries: DocumentArtifactEntry[] = [];
		for (const file of files) {
			if (!isSafeRelativePath(file.relativePath)) return { ok: false, reason: "denied" };
			const absolute = resolveInsideDirectory(stagingDirectory, file.relativePath);
			if (!absolute) return { ok: false, reason: "denied" };
			const containment = await containPath(stagingDirectory, absolute);
			if (!containment.ok) return { ok: false, reason: "denied" };
			const fingerprint = await fingerprintFile(containment.realPath, byteBudget);
			if (!fingerprint) return { ok: false, reason: "io" };
			if (fingerprint.bytes === 0) return { ok: false, reason: "empty" };
			entries.push({ relativePath: file.relativePath, role: file.role, digest: fingerprint.digest, bytes: fingerprint.bytes });
		}
		return { ok: true, value: entries };
	}

	async listStagingFiles(stagingDirectory: string, limit = 256): Promise<string[]> {
		const collected: string[] = [];
		async function walk(directory: string): Promise<void> {
			if (collected.length >= limit) return;
			const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				if (collected.length >= limit) return;
				const absolute = join(directory, entry.name);
				if (entry.isDirectory()) {
					await walk(absolute);
					continue;
				}
				if (entry.isFile()) collected.push(relative(stagingDirectory, absolute).split(sep).join("/"));
			}
		}
		await walk(stagingDirectory);
		return collected;
	}

	/**
	 * 落盘一个版本：指纹 → 排他目录 → 复制成果 → 复制快照 → 返回版本记录。
	 * 复制失败会清掉刚建的版本目录，但不触碰 staging、基稿冻结副本或已归档版本。
	 */
	async archiveVersion(input: ArchiveInput, byteBudget: number): Promise<{ ok: true; value: DocumentArtifactVersion } | { ok: false; reason: ArtifactStoreFailure["reason"] }> {
		const created = await createExclusiveVersionDirectory(input.workDirectory, input.ordinal);
		if (!created) return { ok: false, reason: "io" };
		const versionDirectory = join(input.workDirectory, "versions", created.directory);
		const snapshotDirectory = this.snapshotDirectory(input.workId, input.versionId);
		try {
			const fingerprinted = await this.fingerprintStagedFiles(input.stagingDirectory, input.files, byteBudget);
			if (!fingerprinted.ok) {
				await rm(versionDirectory, { recursive: true, force: true });
				return { ok: false, reason: fingerprinted.reason };
			}
			for (const entry of fingerprinted.value) {
				const source = resolveInsideDirectory(input.stagingDirectory, entry.relativePath);
				if (!source) {
					await rm(versionDirectory, { recursive: true, force: true });
					return { ok: false, reason: "denied" };
				}
				const target = join(versionDirectory, ...entry.relativePath.split("/"));
				await ensureDirectory(dirname(target));
				await cp(source, target);
				// 复制后再取一次指纹：源在复制中变化时不能把半个文件登记成成果。
				const copied = await fingerprintFile(target);
				const current = await fingerprintFile(source);
				if (!copied || !current || copied.digest !== entry.digest || current.digest !== entry.digest) {
					await rm(versionDirectory, { recursive: true, force: true });
					return { ok: false, reason: "changed" };
				}
				const snapshotTarget = join(snapshotDirectory, ...entry.relativePath.split("/"));
				await ensureDirectory(dirname(snapshotTarget));
				await cp(source, snapshotTarget);
			}
			const version: DocumentArtifactVersion = {
				schemaVersion: 1,
				versionId: input.versionId,
				ordinal: created.ordinal,
				workId: input.workId,
				...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
				kind: input.kind,
				title: input.title,
				directory: created.directory,
				artifacts: fingerprinted.value,
				snapshotDirectory,
				...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
				...(input.baseDigest ? { baseDigest: input.baseDigest } : {}),
				...(input.generation ? { generation: input.generation } : {}),
				modelRisks: [],
				userAcceptance: "not_collected" satisfies VersionUserAcceptance,
				createdAt: Date.now(),
			};
			return { ok: true, value: version };
		} catch {
			await rm(versionDirectory, { recursive: true, force: true }).catch(() => undefined);
			return { ok: false, reason: "io" };
		}
	}

	async writeVersionRecord(version: DocumentArtifactVersion): Promise<void> {
		await writeFileAtomic(join(this.rootDir, "works", version.workId, "versions", `${version.versionId}.json`), JSON.stringify(version, null, 2));
	}

	/** 公开成果目录文件的当前指纹：用于发现用户在成果目录里的手工修改。 */
	async observedDigestInDirectory(directory: string, relativePath: string, byteBudget: number): Promise<string | undefined> {
		const absolute = resolveInsideDirectory(directory, relativePath);
		if (!absolute) return undefined;
		const containment = await containPath(directory, absolute);
		if (!containment.ok) return undefined;
		const fingerprint = await fingerprintFile(containment.realPath, byteBudget);
		return fingerprint?.digest;
	}

	async directoryExists(path: string): Promise<boolean> {
		return stat(path).then(
			(info) => info.isDirectory(),
			() => false,
		);
	}

	async writeStagingReadme(stagingDirectory: string, lines: readonly string[]): Promise<void> {
		await writeFile(join(stagingDirectory, "TPA-工作说明.txt"), `${lines.join("\n")}\n`, "utf8");
	}

	/** 材料转换缓存的键：内容指纹 + 转换器版本，任一变化即失效。 */
	materialCachePath(digest: string, converterVersion: string, extension: string): string {
		return join(this.rootDir, "materials", digest, `${hashText(converterVersion).slice(0, 16)}${extension}`);
	}
}
