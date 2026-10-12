/**
 * TPA 材料读取工具（pi 侧）：默认用 anydoc 把材料转成 Markdown 后读入。
 *
 * 边界（方案第 5 节）：
 * - 工具只接受绑定工作里的 `materialId`，不接受任意命令、任意输出路径或 shell 片段；
 * - anydoc 用固定 argv 直接 spawn，不经 shell，不拼接用户输入；
 * - 转换缓存在「内容指纹 + 转换器版本」下有效性判定，任一变化即重新转换；
 * - 失败如实返回错误，不假装转换成功；普通 bash 仍按原权限可用。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_BINDING_ENTRY_TYPE, decodeBinding, isRecord, type DocumentWorkBinding } from "./pi-deck-document-work-types";

/** 转换器版本：升级 anydoc 行为或调用方式时手动递增，缓存随之失效。 */
export const ANYDOC_CONVERTER_VERSION = "anydoc-argv-1";
export const MATERIAL_BYTE_BUDGET = 64 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 5 * 60_000;

export type MaterialRunner = (argv: string[], options: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type MaterialConversionResult = { status: "converted"; markdown: string; digest: string; converterVersion: string; cached: boolean } | { status: "failed"; error: string };

export type MaterialConverterDeps = {
	cacheRoot: string;
	run: MaterialRunner;
	fingerprint(path: string): Promise<string | undefined>;
	readText(path: string): Promise<string | undefined>;
	writeText(path: string, text: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	remove(path: string): Promise<void>;
};

function cacheDirectory(deps: MaterialConverterDeps, digest: string, converterVersion: string): string {
	return join(deps.cacheRoot, digest, createHash("sha256").update(converterVersion).digest("hex").slice(0, 16));
}

/**
 * 转换一步：命中缓存直接返回；否则固定 argv 调 anydoc，成功后写 Markdown 与元数据。
 * 元数据里同时记源指纹与转换器版本，读取缓存时两个都必须匹配。
 */
export async function convertMaterialWithAnyDoc(deps: MaterialConverterDeps, input: { sourcePath: string; digest: string; converterVersion?: string }): Promise<MaterialConversionResult> {
	const converterVersion = input.converterVersion ?? ANYDOC_CONVERTER_VERSION;
	const directory = cacheDirectory(deps, input.digest, converterVersion);
	const markdownPath = join(directory, "material.md");
	const metaPath = join(directory, "meta.json");
	const cached = await deps.readText(markdownPath);
	if (cached !== undefined && cached.length > 0) {
		const meta = await deps.readText(metaPath);
		try {
			const parsed: unknown = meta === undefined ? undefined : JSON.parse(meta);
			if (isRecord(parsed) && parsed.sourceDigest === input.digest && parsed.converterVersion === converterVersion) {
				const digest = await deps.fingerprint(markdownPath);
				if (digest) return { status: "converted", markdown: cached, digest, converterVersion, cached: true };
			}
		} catch {
			// 元数据损坏按未命中处理，重新转换而不是使用来源不明的缓存。
		}
	}
	await deps.ensureDirectory(directory);
	const outputPath = join(directory, "material.converted.md");
	await deps.remove(outputPath);
	const outcome = await deps.run(["anydoc", input.sourcePath, "-o", outputPath], { timeoutMs: CONVERT_TIMEOUT_MS });
	if (outcome.code !== 0) {
		const reason = (outcome.stderr || outcome.stdout || `exit ${outcome.code ?? "unknown"}`).trim().slice(0, 300);
		return { status: "failed", error: reason || "anydoc_failed" };
	}
	const converted = await deps.readText(outputPath);
	if (converted === undefined || converted.length === 0) return { status: "failed", error: "conversion_empty" };
	await deps.writeText(markdownPath, converted);
	await deps.writeText(metaPath, JSON.stringify({ sourceDigest: input.digest, converterVersion, convertedAt: Date.now() }));
	const digest = await deps.fingerprint(markdownPath);
	if (!digest) return { status: "failed", error: "conversion_unverifiable" };
	return { status: "converted", markdown: converted, digest, converterVersion, cached: false };
}

/** 固定 argv 的 anydoc 调用：不经 shell，超时或异常都结算成非零退出。 */
export function runAnyDoc(argv: string[], options: { timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = delay(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ code: null, stdout, stderr: `${stderr}\ntimeout`.trim() });
		}, options.timeoutMs);
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearDelay(timer);
			resolve({ code, stdout, stderr });
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < 8000) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 8000) stderr += chunk.toString("utf8");
		});
		// 未挂 error 监听的子进程会让 pi 主进程直接崩溃；ENOENT 时按失败结算。
		child.on("error", (error: Error) => finish(error.name === "AbortError" ? null : -1));
		child.on("close", (code: number | null) => finish(code));
	});
}

async function fingerprintFile(path: string): Promise<string | undefined> {
	const hash = createHash("sha256");
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MATERIAL_BYTE_BUDGET) return undefined;
		for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

export default function piDeckDocumentMaterialsExtension(pi: ExtensionAPI): void {
	function boundMaterials(ctx: ExtensionContext): DocumentWorkBinding | undefined {
		const current = ctx.sessionManager.getSessionId();
		let binding: DocumentWorkBinding | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== DOCUMENT_WORK_BINDING_ENTRY_TYPE) continue;
			if (!isRecord(entry.data) || entry.data.sessionId !== current) continue;
			binding = decodeBinding(entry.data.binding) ?? binding;
		}
		return binding;
	}

	pi.registerTool({
		name: "tpa_read_material",
		label: "TPA read material",
		description: "Convert and read one material declared by the bound TPA document work. Pass the materialId from the binding. Documents are converted with anydoc; the result is cached by content digest and converter version. This tool cannot read arbitrary paths or run arbitrary commands.",
		parameters: Type.Object({ materialId: Type.String({ maxLength: 40 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const binding = boundMaterials(ctx);
			if (!binding) return { content: [{ type: "text", text: "No TPA document work is bound to this session." }], details: { material: { ok: false, error: "no_work" } } };
			const material = binding.materials.find((entry) => entry.materialId === params.materialId);
			if (!material) return { content: [{ type: "text", text: `Unknown materialId "${params.materialId}". Declared materials: ${binding.materials.map((entry) => entry.materialId).join(", ") || "none"}.` }], details: { material: { ok: false, error: "unknown_material" } } };
			const currentDigest = await fingerprintFile(material.path);
			if (!currentDigest) return { content: [{ type: "text", text: `Material ${material.materialId} (${material.label}) is unreadable or over budget; report this instead of guessing contents.` }], details: { material: { ok: false, error: "unreadable" } } };
			if (currentDigest !== material.digest) return { content: [{ type: "text", text: `Material ${material.materialId} (${material.label}) changed after it was declared; ask the user to re-confirm before using it.` }], details: { material: { ok: false, error: "changed" } } };
			const result = await convertMaterialWithAnyDoc(
				{
					cacheRoot: binding.materialCacheDirectory,
					run: runAnyDoc,
					fingerprint: fingerprintFile,
					readText: (path) => readFile(path, "utf8").catch(() => undefined),
					writeText: async (path, text) => {
						await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
						await writeFile(path, text, "utf8");
					},
					ensureDirectory: async (path) => {
						await mkdir(path, { recursive: true });
					},
					remove: async (path) => {
						await rm(path, { force: true }).catch(() => undefined);
					},
				},
				{ sourcePath: material.path, digest: material.digest },
			);
			if (result.status === "failed") {
				return { content: [{ type: "text", text: `Converting ${material.label} failed: ${result.error}. Do not claim its contents; ask the user for readable material or another format.` }], details: { material: { ok: false, error: "conversion_failed", detail: result.error } } };
			}
			return {
				content: [{ type: "text", text: `Material ${material.materialId} (${material.label})${result.cached ? " (cached)" : ""}:\n\n${result.markdown.slice(0, 200_000)}` }],
				details: { material: { ok: true, materialId: material.materialId, digest: result.digest, converterVersion: result.converterVersion, cached: result.cached, characters: result.markdown.length } },
			};
		},
	});
}
