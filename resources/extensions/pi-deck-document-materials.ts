/**
 * TPA 独立文稿：材料读取工具（`tpa_read_material`）。
 *
 * 只接受绑定工作里的 `materialId`——不接受任意命令、任意输出路径，也不接受"已转换"
 * 之类的自报。拿到 materialId 后：解析到本轮输出根内的真实文件 → 校验指纹（与绑定时
 * 登记的一致）→ 纯文本直接返回，其他格式用**固定 argv**（`anydoc <in> -o <out>`，
 * `shell: false`）转换到本轮 staging 的 `_tpa/materials/` 缓存里。
 *
 * 缓存键包含原件指纹与转换器版本；原件在转换期间变化、转换器非零退出、超时或输出
 * 缺失都返回错误，**不写缓存也不写"已读"**。主进程只有拿到这里的成功结果才会认为
 * 材料真的被读过。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_PROTOCOL, contentDigest, isRecord, type DocumentWorkBindingPayload } from "./pi-deck-document-work-protocol";

/** 单次返回给模型的正文字符上限：材料可能很长，但一次工具结果不该压垮上下文。 */
const MAX_RETURNED_CHARACTERS = 200_000;
const TEXT_LIKE = [".md", ".markdown", ".mdx", ".txt", ".text", ".json", ".csv", ".tsv", ".html", ".htm", ".xml", ".yml", ".yaml"];

export type MaterialConversionRunner = (command: { file: string; args: string[]; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string } | { failure: string }>;

export type MaterialToolDeps = {
	getBinding: () => DocumentWorkBindingPayload | undefined;
	/** 测试注入点：不真的起子进程。 */
	runConversion?: MaterialConversionRunner;
	resolveExecutable?: () => string | undefined;
};

/** anydoc 可执行文件解析：环境变量覆盖优先，否则按平台默认名交给 spawn 解析 PATH。 */
export function resolveAnydocExecutable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.PIDECK_ANYDOC_PATH?.trim();
	if (override) return override;
	return platform === "win32" ? "anydoc.cmd" : "anydoc";
}

/** 固定 argv：永不做 shell 拼接，参数以数组形式交给 spawn。 */
export function buildConversionCommand(input: { executable: string; sourcePath: string; outputPath: string; timeoutMs: number }): { file: string; args: string[]; timeoutMs: number } {
	return { file: input.executable, args: [input.sourcePath, "-o", input.outputPath], timeoutMs: input.timeoutMs };
}

function defaultRunner(command: { file: string; args: string[]; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string } | { failure: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill();
			} catch {
				// 进程可能已经退出；超时本身已经是要报告的事实。
			}
			resolve({ failure: "the converter timed out" });
		}, command.timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < 8000) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 8000) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ failure: error.message });
		});
		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

/** 路径逃逸校验：真实路径必须仍在输出根内（junction/符号链接都会在这里露出来）。 */
function resolveInsideRoot(rootPath: string, relativePath: string): { ok: true; absolutePath: string } | { ok: false; reason: string } {
	if (relativePath.includes("\0") || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath) || relativePath.split("/").some((segment) => segment === ".." || segment === "")) return { ok: false, reason: "the material path is not a bounded relative path" };
	let rootReal: string;
	try {
		rootReal = realpathSync(rootPath);
	} catch {
		return { ok: false, reason: "the output root is not readable" };
	}
	const absolute = join(rootReal, ...relativePath.split("/"));
	if (!existsSync(absolute)) return { ok: false, reason: "the material is no longer on disk" };
	let targetReal: string;
	try {
		targetReal = realpathSync(absolute);
	} catch {
		return { ok: false, reason: "the material path cannot be resolved" };
	}
	const normalizedRoot = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
	const normalizedTarget = process.platform === "win32" ? targetReal.toLowerCase() : targetReal;
	if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot.endsWith("\\") || normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
		return { ok: false, reason: "the material resolves outside the authorized output root" };
	}
	return { ok: true, absolutePath: targetReal };
}

export function registerMaterialTool(pi: ExtensionAPI, deps: MaterialToolDeps): void {
	const runner = deps.runConversion ?? defaultRunner;
	const resolveExecutable = deps.resolveExecutable ?? (() => resolveAnydocExecutable());
	pi.registerTool({
		name: DOCUMENT_WORK_PROTOCOL.materialTool,
		label: "Read a registered document material",
		description: "Read one material registered for the current document work round. Pass the materialId from the injected work context; text files come back directly, office documents are converted with anydoc into this round's cache. This tool cannot read arbitrary paths or run arbitrary commands.",
		parameters: Type.Object({ materialId: Type.String({ maxLength: 80 }) }, { additionalProperties: false }),
		async execute(_id, params: { materialId: string }) {
			const binding = deps.getBinding();
			if (!binding) return { content: [{ type: "text", text: "No document work round is bound to this session; materials cannot be read yet." }], isError: true };
			const material = binding.materials.find((item) => item.materialId === params.materialId);
			if (!material) return { content: [{ type: "text", text: `materialId ${params.materialId} is not registered for this round.` }], isError: true };
			const resolved = resolveInsideRoot(binding.outputRootPath, material.relativePath);
			if (!resolved.ok) return { content: [{ type: "text", text: `Material rejected: ${resolved.reason}` }], isError: true };
			let stat;
			try {
				stat = statSync(resolved.absolutePath);
			} catch {
				return { content: [{ type: "text", text: "Material rejected: the file is not readable." }], isError: true };
			}
			if (!stat.isFile() || stat.size === 0) return { content: [{ type: "text", text: "Material rejected: not a non-empty regular file." }], isError: true };
			if (stat.size > DOCUMENT_WORK_PROTOCOL.budgets.materialBytes) return { content: [{ type: "text", text: "Material rejected: the file exceeds the conversion byte budget." }], isError: true };
			const data = readFileSync(resolved.absolutePath);
			const sourceSha256 = contentDigest(data);
			if (sourceSha256 !== material.sha256) return { content: [{ type: "text", text: "Material rejected: the file changed after it was registered for this round. Report the change instead of converting the new bytes." }], isError: true };
			const extension = (basename(material.relativePath).match(/\.[^.]+$/) ?? [""])[0].toLowerCase();
			if (TEXT_LIKE.includes(extension)) return { content: [{ type: "text", text: bound(data.toString("utf8")) }], details: { materialId: material.materialId, sourceSha256, converter: "text" } };
			const executable = resolveExecutable();
			if (!executable) return { content: [{ type: "text", text: "Material not converted: the anydoc converter is not available on this machine." }], isError: true };
			const cacheDir = join(binding.outputRootPath, binding.stagingRelativeDir, "_tpa", "materials");
			const outputPath = join(cacheDir, `${material.materialId}.md`);
			const metaPath = join(cacheDir, `${material.materialId}.meta.json`);
			const cached = readCache(metaPath, outputPath, sourceSha256);
			if (cached !== undefined) return { content: [{ type: "text", text: bound(cached) }], details: { materialId: material.materialId, sourceSha256, converter: DOCUMENT_WORK_PROTOCOL.converterVersion, cacheHit: true } };
			try {
				mkdirSync(cacheDir, { recursive: true });
			} catch {
				return { content: [{ type: "text", text: "Material not converted: the conversion cache directory is not writable." }], isError: true };
			}
			const outcome = await runner(buildConversionCommand({ executable, sourcePath: resolved.absolutePath, outputPath, timeoutMs: DOCUMENT_WORK_PROTOCOL.budgets.conversionMs }));
			if ("failure" in outcome) return { content: [{ type: "text", text: `Material not converted: ${outcome.failure}. Report this honestly instead of quoting the file's contents.` }], isError: true };
			if (outcome.code !== 0) return { content: [{ type: "text", text: `Material not converted: anydoc exited with code ${outcome.code}. ${outcome.stderr.slice(0, 500)}`.trim() }], isError: true };
			let after: Buffer;
			try {
				after = readFileSync(resolved.absolutePath);
			} catch {
				return { content: [{ type: "text", text: "Material not converted: the file disappeared during conversion." }], isError: true };
			}
			if (contentDigest(after) !== sourceSha256) return { content: [{ type: "text", text: "Material not converted: the file changed during conversion; the result was discarded." }], isError: true };
			if (!existsSync(outputPath)) return { content: [{ type: "text", text: "Material not converted: the converter produced no output file." }], isError: true };
			const markdown = readFileSync(outputPath, "utf8");
			if (!markdown.trim()) return { content: [{ type: "text", text: "Material not converted: the converter produced an empty document." }], isError: true };
			try {
				writeFileSync(metaPath, JSON.stringify({ schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion, sourceSha256, converterVersion: DOCUMENT_WORK_PROTOCOL.converterVersion, outputSha256: contentDigest(markdown) }), "utf8");
			} catch {
				// 缓存写失败不影响本次结果；下一次会重新转换。
			}
			return { content: [{ type: "text", text: bound(markdown) }], details: { materialId: material.materialId, sourceSha256, converter: DOCUMENT_WORK_PROTOCOL.converterVersion, cacheHit: false } };
		},
	});
}

function bound(text: string): string {
	if (text.length <= MAX_RETURNED_CHARACTERS) return text;
	return `${text.slice(0, MAX_RETURNED_CHARACTERS)}\n\n[...material truncated at ${MAX_RETURNED_CHARACTERS} characters; ask for a specific part if you need more...]`;
}

/** 缓存命中需要三件事同时成立：原件指纹、转换器版本、输出指纹。 */
function readCache(metaPath: string, outputPath: string, sourceSha256: string): string | undefined {
	if (!existsSync(metaPath) || !existsSync(outputPath)) return undefined;
	try {
		const meta: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
		if (!isRecord(meta) || meta.sourceSha256 !== sourceSha256 || meta.converterVersion !== DOCUMENT_WORK_PROTOCOL.converterVersion || typeof meta.outputSha256 !== "string") return undefined;
		const output = readFileSync(outputPath, "utf8");
		return contentDigest(output) === meta.outputSha256 ? output : undefined;
	} catch {
		return undefined;
	}
}
