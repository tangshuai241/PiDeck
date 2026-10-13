/**
 * TPA 材料读取工具（pi 侧）：默认用 anydoc 把材料转成 Markdown 后读入。
 *
 * 边界（方案第 5、7 节）：
 * - 工具只接受绑定工作里的 `materialId`，不接受任意命令、任意输出路径或 shell 片段；
 * - anydoc 用固定 argv 直接 spawn，不经 shell，不拼接用户输入；
 * - 本机 anydoc 是 npm 的 .cmd/.ps1 shim：shell:false 下 spawn("anydoc") 是 ENOENT、
 *   spawn("anydoc.cmd") 是 EINVAL，所以先解析真实 Node CLI 入口，再 `node <cli.js> …`；
 * - 转换时限 120 秒；缓存在「内容指纹 + 转换器版本 + 登记输出指纹」三者一致时才命中；
 * - 失败如实返回错误，不假装转换成功；普通 bash 仍按原权限可用。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_BINDING_ENTRY_TYPE, decodeBinding, isRecord, type DocumentWorkBinding } from "./pi-deck-document-work-types";

/** 转换器版本：升级 anydoc 行为或调用方式时手动递增，缓存随之失效。 */
export const ANYDOC_CONVERTER_VERSION = "anydoc-node-cli-2";
export const MATERIAL_BYTE_BUDGET = 64 * 1024 * 1024;
/** 方案第 7 节：转换时限 120 秒。 */
export const ANYDOC_TIMEOUT_MS = 120_000;
/** npm 包内 CLI 入口的相对路径（npm shim 的 bin 映射也指向它）。 */
export const ANYDOC_CLI_RELATIVE_PATH = "@firecrawl/anydoc/cli.js";

export type MaterialRunner = (argv: string[], options: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type MaterialConversionResult = { status: "converted"; markdown: string; digest: string; converterVersion: string; cached: boolean } | { status: "failed"; error: string };

export type AnydocCli = { nodeExecPath: string; cliPath: string; version: string };

export type MaterialConverterDeps = {
	cacheRoot: string;
	run: MaterialRunner;
	fingerprint(path: string): Promise<string | undefined>;
	readText(path: string): Promise<string | undefined>;
	writeText(path: string, text: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	/** 解析 anydoc 的 Node CLI 入口；解析不到就如实失败，不用 shim 硬试。 */
	resolveAnydocCli(): Promise<AnydocCli | undefined>;
};

/** 固定 argv：`node <cli.js> <源文件> -o <输出>`；argv 各段都由程序给出，不拼 shell。 */
export function buildAnydocArgv(resolved: AnydocCli, sourcePath: string, outputPath: string): string[] {
	return [resolved.nodeExecPath, resolved.cliPath, sourcePath, "-o", outputPath];
}

/** npm 全局根下的候选路径：npm prefix、%APPDATA%\npm 与常见 HOME 布局。 */
export function anydocCliCandidates(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string[] {
	const candidates: string[] = [];
	const npmPrefix = env.npm_config_prefix || env.PREFIX;
	if (npmPrefix) candidates.push(join(npmPrefix, "node_modules", ANYDOC_CLI_RELATIVE_PATH));
	if (env.APPDATA) candidates.push(join(env.APPDATA, "npm", "node_modules", ANYDOC_CLI_RELATIVE_PATH));
	candidates.push(join(homeDir, ".npm-global", "node_modules", ANYDOC_CLI_RELATIVE_PATH));
	candidates.push(join("/usr", "local", "lib", "node_modules", ANYDOC_CLI_RELATIVE_PATH));
	candidates.push(join("/usr", "lib", "node_modules", ANYDOC_CLI_RELATIVE_PATH));
	return [...new Set(candidates)];
}

/**
 * 解析 anydoc 的真实 Node CLI 入口：先确认 node 可用，再对候选路径跑 `--version`。
 * 只有实际跑通 `--version` 的入口才被采用，避免把「文件存在但装坏了」当成可用。
 */
export async function resolveAnydocCli(input: { run: MaterialRunner; exists: (path: string) => Promise<boolean>; candidates: readonly string[]; nodeExecPath?: string }): Promise<AnydocCli | undefined> {
	const nodeExecPath = input.nodeExecPath ?? process.execPath;
	const probe = await input.run([nodeExecPath, "--version"], { timeoutMs: 10_000 });
	if (probe.code !== 0) return undefined;
	for (const candidate of input.candidates) {
		if (!(await input.exists(candidate))) continue;
		const version = await input.run([nodeExecPath, candidate, "--version"], { timeoutMs: 30_000 });
		if (version.code === 0) return { nodeExecPath, cliPath: candidate, version: version.stdout.trim().slice(0, 40) };
	}
	return undefined;
}

function cacheDirectory(deps: MaterialConverterDeps, digest: string, converterVersion: string): string {
	return join(deps.cacheRoot, digest, createHash("sha256").update(converterVersion).digest("hex").slice(0, 16));
}

/**
 * 转换一步：命中缓存直接返回；否则固定 argv 调 anydoc，成功后写 Markdown 与元数据。
 * 元数据同时记源指纹、转换器版本与输出指纹，三者都对上才算命中。
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
			// 只重算现有 Markdown 的 hash 会把被改坏的缓存当成命中；必须与登记输出指纹比较。
			if (isRecord(parsed) && parsed.sourceDigest === input.digest && parsed.converterVersion === converterVersion && typeof parsed.outputDigest === "string") {
				const digest = await deps.fingerprint(markdownPath);
				if (digest && digest === parsed.outputDigest) return { status: "converted", markdown: cached, digest, converterVersion, cached: true };
			}
		} catch {
			// 元数据损坏按未命中处理，重新转换而不是使用来源不明的缓存。
		}
	}
	await deps.ensureDirectory(directory);
	const resolved = await deps.resolveAnydocCli();
	if (!resolved) return { status: "failed", error: "anydoc_cli_not_found" };
	const outputPath = join(directory, "material.converted.md");
	await deps.remove(outputPath);
	const outcome = await deps.run(buildAnydocArgv(resolved, input.sourcePath, outputPath), { timeoutMs: ANYDOC_TIMEOUT_MS });
	if (outcome.code !== 0) {
		const reason = (outcome.stderr || outcome.stdout || `exit ${outcome.code ?? "unknown"}`).trim().slice(0, 300);
		return { status: "failed", error: reason || "anydoc_failed" };
	}
	const converted = await deps.readText(outputPath);
	if (converted === undefined || converted.length === 0) return { status: "failed", error: "conversion_empty" };
	// 转换成功后再校验一次原件指纹：转换期间原件变化的输出不能登记成这一版的缓存。
	const sourceAfter = await deps.fingerprint(input.sourcePath);
	if (!sourceAfter || sourceAfter !== input.digest) return { status: "failed", error: "source_changed_during_conversion" };
	const digest = await deps.fingerprint(outputPath);
	if (!digest) return { status: "failed", error: "conversion_unverifiable" };
	await deps.writeText(markdownPath, converted);
	await deps.writeText(metaPath, JSON.stringify({ sourceDigest: input.digest, converterVersion, outputDigest: digest, convertedAt: Date.now() }));
	return { status: "converted", markdown: converted, digest, converterVersion, cached: false };
}

/** 固定 argv 的进程调用：不经 shell，超时或异常都结算成非零退出。 */
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
		// 未挂 error 监听的子进程会让 pi 主进程直接崩溃；ENOENT/EINVAL 时按失败结算。
		child.on("error", (error: Error) => finish(error.message.includes("abort") ? null : -1));
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
	function boundBinding(ctx: ExtensionContext): DocumentWorkBinding | undefined {
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
		description: "Convert and read one material declared by the bound TPA document work. Pass the materialId from the binding. Documents are converted with anydoc; the result is cached by content digest, converter version and output digest. This tool cannot read arbitrary paths or run arbitrary commands.",
		parameters: Type.Object({ materialId: Type.String({ maxLength: 40 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const binding = boundBinding(ctx);
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
					resolveAnydocCli: () =>
						resolveAnydocCli({
							run: runAnyDoc,
							exists: async (path) =>
								stat(path).then(
									(info) => info.isFile(),
									() => false,
								),
							candidates: anydocCliCandidates(),
						}),
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
