/**
 * TPA 独立文稿：成果归档的字节层。
 *
 * 只做三件事，全部有界：算指纹、把字节复制进新版本目录、把原始字节快照进 TPA 管理目录。
 * 版本目录用排他创建（`mkdir` 不 recursive），目标已存在就失败——程序正常归档路径
 * 绝不覆盖旧版。复制前后各算一次指纹：复制中变化返回 `BASE_CHANGED`，不报告归档完成。
 *
 * 注意边界：这里保证的是"TPA 的归档路径不覆盖旧版"，不是操作系统级禁止写入。
 * 放开 bash 后任意命令仍可能改到旧文件，方案不宣称提供强制沙箱。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isHexDigest, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactFile } from "../../shared/types/documentWork";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";

export type DocumentWorkLayout = {
	/** 工作相对目录（相对成果根）：`<workId>`。 */
	workRelativeDir: string;
	workAbsoluteDir: string;
	versionsRelativeDir: string;
	snapshotsRelativeDir: string;
};

export type DocumentArtifactStorePorts = {
	fs: DocumentPathFsPort;
	/** 成果根（用户显式选择）。 */
	outputRootPath: string;
	/** TPA 管理的快照根（userData 下，不受用户编辑影响）。 */
	snapshotRootPath: string;
	maxArtifactBytes: number;
};

export function hashBuffer(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export class DocumentArtifactStore {
	private readonly ports: DocumentArtifactStorePorts;

	constructor(ports: DocumentArtifactStorePorts) {
		this.ports = ports;
	}

	get outputRootPath(): string {
		return this.ports.outputRootPath;
	}

	get snapshotRootPath(): string {
		return this.ports.snapshotRootPath;
	}

	/** 工作目录按稳定 workId 命名：标题只用于显示，身份由程序生成。 */
	layout(workId: string): DocumentWorkLayout {
		return {
			workRelativeDir: workId,
			workAbsoluteDir: join(this.ports.outputRootPath, workId),
			versionsRelativeDir: `${workId}/versions`,
			snapshotsRelativeDir: `${workId}/snapshots`,
		};
	}

	stagingRelativeDir(workId: string, attemptId: string): string {
		return `${workId}/staging/${attemptId}`;
	}

	/** 创建 staging 与 versions 骨架；已存在时只复用目录，不删除里面任何文件。 */
	ensureLayout(workId: string): WorkResult<DocumentWorkLayout> {
		const layout = this.layout(workId);
		try {
			this.ports.fs.mkdirRecursive(layout.workAbsoluteDir);
			this.ports.fs.mkdirRecursive(join(layout.workAbsoluteDir, "versions"));
			this.ports.fs.mkdirRecursive(join(layout.workAbsoluteDir, "staging"));
			this.ports.fs.mkdirRecursive(join(this.ports.snapshotRootPath, workId));
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to prepare the work directories" });
		}
		// 真实路径必须仍在成果根内：junction 指向根外时整件工作拒绝服务。
		const resolved = resolveWithinRoot(this.ports.fs, this.ports.outputRootPath, layout.workRelativeDir);
		if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
		return workOk(layout);
	}

	/** 本轮 staging：同一 attemptId 重复创建是幂等的（同一轮重试不换目录）。 */
	createStaging(workId: string, attemptId: string): WorkResult<{ relativeDir: string; absolutePath: string }> {
		const relativeDir = this.stagingRelativeDir(workId, attemptId);
		const resolved = resolveWithinRoot(this.ports.fs, this.ports.outputRootPath, relativeDir.split("/").slice(0, -1) ? relativeDir : relativeDir);
		if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
		try {
			this.ports.fs.mkdirRecursive(resolved.absolutePath);
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to create the staging directory" });
		}
		return workOk({ relativeDir, absolutePath: resolved.absolutePath });
	}

	/**
	 * 分配新版本目录。排他创建：`v0001` 已存在就试 `v0002`，绝不覆盖。
	 * 序号在失败重试时必然前进，因此不会把新稿写进旧版本目录。
	 */
	allocateVersionDir(workId: string, startOrdinal: number): WorkResult<{ ordinal: number; relativeDir: string; absolutePath: string }> {
		let ordinal = Math.max(1, Math.floor(startOrdinal));
		for (let attempt = 0; attempt < 10_000; attempt++) {
			const name = `v${String(ordinal).padStart(4, "0")}`;
			const relativeDir = `${workId}/versions/${name}`;
			const resolved = resolveWithinRoot(this.ports.fs, this.ports.outputRootPath, relativeDir);
			if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
			if (this.ports.fs.mkdirExclusive(resolved.absolutePath)) return workOk({ ordinal, relativeDir, absolutePath: resolved.absolutePath });
			if (!this.ports.fs.exists(resolved.absolutePath)) return workFail("IO_ERROR", true, { detail: "failed to create the version directory" });
			ordinal++;
		}
		return workFail("IO_ERROR", false, { detail: "no free version directory" });
	}

	/** 有界指纹：调用方保证只对预算内的文件调用（超预算只登记存在证据）。 */
	fingerprint(absolutePath: string): WorkResult<{ sha256: string; bytes: number }> {
		const data = this.ports.fs.readFile(absolutePath);
		if (!data) return workFail("IO_ERROR", true, { detail: "candidate file is not readable" });
		return workOk({ sha256: hashBuffer(data), bytes: data.byteLength });
	}

	/** 存在证据：预算外文件只登记大小与占位指纹，检查记未验证。 */
	evidence(absolutePath: string, relativePath: string): WorkResult<DocumentArtifactFile> {
		const stat = this.ports.fs.stat(absolutePath);
		if (!stat || !stat.isFile()) return workFail("PATH_DENIED", false, { detail: "candidate is not a regular file" });
		return workOk({ relativePath, sha256: hashBuffer(Buffer.from(`${relativePath}:${stat.size}`)), bytes: stat.size, existenceOnly: true });
	}

	/**
	 * 校验并复制单个文件。
	 *
	 * 三次指纹：复制前源、复制后目标、复制后再读源。源在复制中变化即 `BASE_CHANGED`
	 * （调用方可重试有界读取）；期望指纹与目标不一致同样拒绝归档。
	 */
	copyVerified(input: { sourceAbsolutePath: string; destinationAbsolutePath: string; expectedSha256?: string }): WorkResult<{ sha256: string; bytes: number }> {
		const before = this.fingerprint(input.sourceAbsolutePath);
		if ("error" in before) return before;
		if (input.expectedSha256 && before.value.sha256 !== input.expectedSha256) return workFail("BASE_CHANGED", true, { detail: "source bytes changed before copying" });
		try {
			this.ports.fs.copyFile(input.sourceAbsolutePath, input.destinationAbsolutePath);
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to copy the file into the version directory" });
		}
		const copied = this.fingerprint(input.destinationAbsolutePath);
		if ("error" in copied) return workFail("IO_ERROR", true, { detail: "archived file is not readable" });
		const after = this.fingerprint(input.sourceAbsolutePath);
		if ("error" in after) return workFail("BASE_CHANGED", true, { detail: "source disappeared during copy" });
		if (after.value.sha256 !== before.value.sha256) return workFail("BASE_CHANGED", true, { detail: "source changed while copying" });
		if (copied.value.sha256 !== before.value.sha256) return workFail("IO_ERROR", false, { detail: "archived bytes do not match the source" });
		return workOk(copied.value);
	}

	/** 原始字节快照（TPA 管理目录，路径不进成果根，用户手改成果文件不影响它）。 */
	snapshot(workId: string, versionName: string, sourceAbsolutePath: string, fileName: string): WorkResult<DocumentArtifactFile> {
		const relativeDir = `${workId}/snapshots/${versionName}`;
		const resolved = resolveWithinRoot(this.ports.fs, this.ports.snapshotRootPath, relativeDir);
		if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
		try {
			this.ports.fs.mkdirRecursive(resolved.absolutePath);
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to create the snapshot directory" });
		}
		const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "snapshot";
		const destination = join(resolved.absolutePath, safeName);
		const written = this.copyVerified({ sourceAbsolutePath, destinationAbsolutePath: destination });
		if ("error" in written) return written;
		return workOk({ relativePath: `${relativeDir}/${safeName}`, sha256: written.value.sha256, bytes: written.value.bytes });
	}

	/** 只读读取（检查用）；超过预算返回 undefined，不截断冒充完整内容。 */
	readBounded(absolutePath: string, maxBytes: number): Buffer | undefined {
		const stat = this.ports.fs.stat(absolutePath);
		if (!stat || !stat.isFile()) return undefined;
		if (stat.size > maxBytes) return undefined;
		return this.ports.fs.readFile(absolutePath);
	}

	/** 归档前确认目标版本目录里没有同名文件（防覆盖的最后一道检查）。 */
	reserveDestination(versionAbsoluteDir: string, fileName: string): WorkResult<string> {
		const destination = join(versionAbsoluteDir, fileName);
		if (this.ports.fs.exists(destination)) return workFail("IO_ERROR", false, { detail: "destination already exists; refusing to overwrite an archived version" });
		return workOk(destination);
	}

	isDigest(value: unknown): value is string {
		return isHexDigest(value);
	}
}
