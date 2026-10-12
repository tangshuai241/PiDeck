/**
 * TPA 独立文稿：材料登记与转换缓存。
 *
 * 材料读取的唯一入口是 Pi 工具 `tpa_read_material`，它接收绑定工作中的 `materialId`
 * ——**不接收任意命令和输出路径**。本模块负责那半边：把 materialId 映射到工作目录下
 * 的真实文件、用固定 argv 调 anydoc（永不经过 shell）、把结果写进 TPA 管理的缓存。
 *
 * 缓存键 = 原件 SHA-256 + 转换器版本 + 输出校验。原件未变才有命中；转换器版本变化、
 * 缓存损坏或原件在转换中变化都算未命中，并且**不写"已读"记录**——模型说"已转换"
 * 不能作为事实源，只有这里成功返回才算。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DOCUMENT_WORK_CONVERTER_VERSION, isHexDigest, isNonNegativeInteger, isWorkId, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import { isTextLikeExtension } from "./DocumentOoxml";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";

/** 固定 argv：`anydoc <input> -o <output>`。数组形式交给 spawn，永不做 shell 拼接。 */
export type MaterialCommand = { file: string; args: string[]; timeoutMs: number };

export function buildMaterialCommand(input: { executable: string; inputAbsolutePath: string; outputAbsolutePath: string; timeoutMs: number }): MaterialCommand {
	return { file: input.executable, args: [input.inputAbsolutePath, "-o", input.outputAbsolutePath], timeoutMs: input.timeoutMs };
}

export type MaterialCacheEntry = {
	schemaVersion: 1;
	materialId: string;
	sourceSha256: string;
	converterVersion: string;
	outputSha256: string;
	bytes: number;
	createdAt: number;
};

export type MaterialConversionOutcome = { code: number; stdout: string; stderr: string } | { failure: string };

export type DocumentMaterialPorts = {
	fs: DocumentPathFsPort;
	/** 缓存根（userData/document-work/materials）。 */
	cacheRootPath: string;
	/** 转换执行器；生产用 spawn（shell:false），测试注入假实现。 */
	runConversion?: (command: MaterialCommand) => Promise<MaterialConversionOutcome>;
	now?: () => number;
	/** 转换器版本（进缓存键）；默认取共享常量。 */
	converterVersion?: string;
	/** anydoc 可执行文件解析结果；未安装时返回 undefined，调用方如实报错。 */
	resolveExecutable?: () => string | undefined;
	maxSourceBytes: number;
	timeoutMs: number;
};

export type MaterialConversionResult = {
	materialId: string;
	sourceSha256: string;
	markdown: string;
	cacheHit: boolean;
	bytes: number;
	converterVersion: string;
};

export class DocumentMaterialCache {
	private readonly ports: DocumentMaterialPorts;
	private readonly converterVersion: string;

	constructor(ports: DocumentMaterialPorts) {
		this.ports = ports;
		this.converterVersion = ports.converterVersion ?? DOCUMENT_WORK_CONVERTER_VERSION;
	}

	/** materialId → 源文件绝对路径；只允许工作目录内的注册材料。 */
	resolveSource(outputRootPath: string, relativePath: string): WorkResult<string> {
		const resolved = resolveWithinRoot(this.ports.fs, outputRootPath, relativePath);
		if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
		if (!this.ports.fs.exists(resolved.absolutePath)) return workFail("INVALID_INPUT", false, { detail: "the material is no longer on disk" });
		return workOk(resolved.absolutePath);
	}

	private cacheDir(sourceSha256: string): WorkResult<string> {
		if (!isHexDigest(sourceSha256)) return workFail("INVALID_INPUT", false, { detail: "invalid material fingerprint" });
		const relative = `${sourceSha256.slice(0, 2)}/${sourceSha256}`;
		const resolved = resolveWithinRoot(this.ports.fs, this.ports.cacheRootPath, relative);
		if (!resolved.ok) return workFail(resolved.error.code, false, { detail: resolved.error.detail });
		return workOk(resolved.absolutePath);
	}

	/** 读取缓存；任何一处不符（原件、转换器、输出校验）都算未命中，不"尽力复用"。 */
	readCache(materialId: string, sourceSha256: string): WorkResult<MaterialConversionResult> | undefined {
		const dir = this.cacheDir(sourceSha256);
		if ("error" in dir) return undefined;
		const outputPath = join(dir.value, `${materialId}.md`);
		const metaRaw = this.ports.fs.readFile(join(dir.value, `${materialId}.meta.json`));
		const outputBuffer = this.ports.fs.readFile(outputPath);
		if (metaRaw === undefined || outputBuffer === undefined) return undefined;
		let meta: unknown;
		try {
			meta = JSON.parse(metaRaw.toString("utf8"));
		} catch {
			return undefined;
		}
		if (typeof meta !== "object" || meta === null) return undefined;
		const entry = meta as Partial<MaterialCacheEntry>;
		if (entry.sourceSha256 !== sourceSha256 || entry.converterVersion !== this.converterVersion || !isHexDigest(entry.outputSha256)) return undefined;
		// 字节级校验：缓存被外部截断/改写时不得复用。
		if (createHash("sha256").update(outputBuffer).digest("hex") !== entry.outputSha256) return undefined;
		return workOk({ materialId, sourceSha256, markdown: outputBuffer.toString("utf8"), cacheHit: true, bytes: outputBuffer.byteLength, converterVersion: this.converterVersion });
	}

	/**
	 * 转换材料。
	 *
	 * 步骤：算源指纹 → 查缓存 → 固定 argv 转换 → 复查源指纹 → 写缓存并回读校验。
	 * 源在转换中变化、转换器非零退出、超时、输出缺失都返回结构化错误，
	 * 不写缓存也不写"已读"。
	 */
	async convert(input: { materialId: string; sourceAbsolutePath: string; relativePath: string }): Promise<WorkResult<MaterialConversionResult>> {
		if (!isWorkId(input.materialId)) return workFail("INVALID_INPUT", false, { detail: "materialId is not a bounded id" });
		const stat = this.ports.fs.stat(input.sourceAbsolutePath);
		if (!stat || !stat.isFile() || stat.size === 0) return workFail("INVALID_INPUT", false, { detail: "the material is not a non-empty regular file" });
		if (stat.size > this.ports.maxSourceBytes) return workFail("INVALID_INPUT", false, { detail: "the material exceeds the conversion byte budget" });
		const sourceData = this.ports.fs.readFile(input.sourceAbsolutePath);
		if (!sourceData) return workFail("IO_ERROR", true, { detail: "the material could not be read" });
		const sourceSha256 = createHash("sha256").update(sourceData).digest("hex");
		// 已经是纯文本的材料直接返回，不调转换器也不写缓存。
		const extensionIndex = input.relativePath.lastIndexOf(".");
		const extension = extensionIndex < 0 ? "" : input.relativePath.slice(extensionIndex).toLowerCase();
		if (isTextLikeExtension(extension)) {
			return workOk({ materialId: input.materialId, sourceSha256, markdown: sourceData.toString("utf8"), cacheHit: false, bytes: sourceData.byteLength, converterVersion: this.converterVersion });
		}
		const cached = this.readCache(input.materialId, sourceSha256);
		if (cached && "ok" in cached) return cached;
		const executable = this.ports.resolveExecutable?.();
		if (!executable) return workFail("INVALID_INPUT", false, { detail: "the anydoc converter is not available" });
		const dir = this.cacheDir(sourceSha256);
		if ("error" in dir) return dir;
		const outputPath = join(dir.value, `${input.materialId}.md`);
		try {
			this.ports.fs.mkdirRecursive(dir.value);
		} catch {
			return workFail("IO_ERROR", true, { detail: "failed to prepare the conversion cache directory" });
		}
		const command = buildMaterialCommand({ executable, inputAbsolutePath: input.sourceAbsolutePath, outputAbsolutePath: outputPath, timeoutMs: this.ports.timeoutMs });
		const outcome = await this.ports.runConversion?.(command);
		if (!outcome || "failure" in outcome) return workFail("IO_ERROR", true, { detail: "the converter did not run" });
		if (outcome.code !== 0) return workFail("IO_ERROR", true, { detail: `the converter exited with code ${outcome.code}` });
		// 原件在转换期间变化：结果不对应当前指纹，拒绝采用。
		const after = this.ports.fs.readFile(input.sourceAbsolutePath);
		if (!after) return workFail("BASE_CHANGED", true, { detail: "the material disappeared during conversion" });
		if (createHash("sha256").update(after).digest("hex") !== sourceSha256) return workFail("BASE_CHANGED", true, { detail: "the material changed during conversion" });
		const output = this.ports.fs.readFile(outputPath);
		if (output === undefined || output.byteLength === 0) return workFail("IO_ERROR", true, { detail: "the converter produced no readable output" });
		const outputSha256 = createHash("sha256").update(output).digest("hex");
		const entry: MaterialCacheEntry = { schemaVersion: 1, materialId: input.materialId, sourceSha256, converterVersion: this.converterVersion, outputSha256, bytes: output.byteLength, createdAt: (this.ports.now ?? (() => Date.now()))() };
		try {
			this.ports.fs.writeFile(join(dir.value, `${input.materialId}.meta.json`), Buffer.from(JSON.stringify(entry), "utf8"));
		} catch {
			// 缓存写失败不影响本次读取结果；下一次会重新转换。
		}
		return workOk({ materialId: input.materialId, sourceSha256, markdown: output.toString("utf8"), cacheHit: false, bytes: output.byteLength, converterVersion: this.converterVersion });
	}

	/** 缓存统计（设置页显示占用）；只统计 md/meta 文件。 */
	getCacheSize(): number {
		let total = 0;
		try {
			for (const shard of this.ports.fs.listDir(this.ports.cacheRootPath)) {
				for (const name of this.ports.fs.listDir(join(this.ports.cacheRootPath, shard))) {
					const stat = this.ports.fs.stat(join(this.ports.cacheRootPath, shard, name));
					if (stat?.isFile() && isNonNegativeInteger(stat.size)) total += stat.size;
				}
			}
		} catch {
			return total;
		}
		return total;
	}
}
