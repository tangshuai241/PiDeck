/**
 * TPA 独立文稿：材料读取工具（`tpa_read_material`）。
 *
 * 只接受绑定工作里的 `materialId`——不接受任意命令、任意输出路径，也不接受"已转换"
 * 之类的自报。拿到 materialId 后：按 `rootId` 在**本轮授权的材料根**（成果目录或
 * 会话项目目录）里解析真实文件 → 校验指纹（与绑定时登记的一致）→ 纯文本直接返回，
 * 其他格式用 anydoc 转换到本轮 staging 的 `_tpa/materials/` 缓存。
 *
 * Windows 现实（审查修正项 4）：
 * - npm 全局安装的 CLI 是 `anydoc.cmd` shim，`spawn("anydoc")` → ENOENT，
 *   `spawn("anydoc.cmd", …, {shell:false})` → 同步 EINVAL；
 * - 因此先把可执行体解析成"能直接 spawn 的东西"：优先 `.exe`，其次从 `.cmd` shim 里
 *   取出真实 JS 入口，用 `process.execPath` 跑（**完全不经 shell**）；
 * - 解析不到就如实报错，不假装转换成功。
 *
 * 缓存键包含原件指纹与转换器版本；原件在转换期间变化、转换器非零退出、超时或输出
 * 缺失都不写缓存、不标"已读"。并发上限 2，超时 120s。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_PROTOCOL, contentDigest, isRecord, type DocumentWorkBindingPayload } from "./pi-deck-document-work-protocol";

/** 单次返回给模型的正文字符上限：材料可能很长，但一次工具结果不该压垮上下文。 */
const MAX_RETURNED_CHARACTERS = 200_000;
const TEXT_LIKE = [".md", ".markdown", ".mdx", ".txt", ".text", ".json", ".csv", ".tsv", ".html", ".htm", ".xml", ".yml", ".yaml"];
/** 转换并发上限（共享预算镜像）。 */
const MAX_CONCURRENT_CONVERSIONS = DOCUMENT_WORK_PROTOCOL.budgets.concurrentConversions;

/** 能被 `spawn(file, [...argsPrefix, ...args])` 直接执行的启动描述。 */
export type ConverterLaunch = { file: string; argsPrefix: string[]; source: string };

export type ConverterResolveInput = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** PATH 条目（按顺序）。 */
	pathEntries: readonly string[];
	exists: (path: string) => boolean;
	readText: (path: string) => string | undefined;
	/** 运行 node 脚本用的解释器（生产为 process.execPath）。 */
	nodeExecutable: string;
};

/** 从 npm 的 `.cmd` shim 里取出真实 JS 入口：末个引号里的 .js/.cjs/.mjs 路径。 */
export function nodeEntryFromShim(shimPath: string, content: string): string | undefined {
	const matches = [...content.matchAll(/["']([^"']+\.(?:c?js|mjs))["']/gi)];
	const last = matches.at(-1)?.[1];
	if (!last) return undefined;
	const resolved = last.replace(/%~dp0\\?/gi, `${dirname(shimPath)}\\`).replace(/%dp0%\\?/gi, `${dirname(shimPath)}\\`).replace(/\\/g, process.platform === "win32" ? "\\" : "/");
	return existsSync(resolved) ? resolved : undefined;
}

/**
 * 解析转换器启动方式。顺序：显式环境变量 → PATH 里的真实可执行体 → `.cmd` shim 的 JS 入口。
 * 解析不到返回 undefined（调用方如实报"转换器不可用"）。
 */
export function resolveConverterLaunch(input: ConverterResolveInput): ConverterLaunch | undefined {
	const override = input.env.PIDECK_ANYDOC_PATH?.trim();
	if (override) {
		if (!input.exists(override)) return undefined;
		return /\.(?:c?js|mjs)$/i.test(override) ? { file: input.nodeExecutable, argsPrefix: [override], source: "env:js" } : { file: override, argsPrefix: [], source: "env:bin" };
	}
	// Windows 上不要接受"无扩展名"的文件：npm 生成的同名文件是 bash shim，
	// `spawn` 它会直接 ENOENT（实测）。只认真正可执行的 .exe 或可解析出 JS 入口的 .cmd/.bat。
	const suffixes = input.platform === "win32" ? [".exe", ".cmd", ".bat"] : ["", ".cmd"];
	for (const entry of input.pathEntries) {
		if (!entry) continue;
		for (const suffix of suffixes) {
			const candidate = join(entry, `anydoc${suffix}`);
			if (!input.exists(candidate)) continue;
			if (suffix === ".cmd" || suffix === ".bat") {
				// shim 不能直接 spawn（EINVAL）：取出真实 JS 入口交给 node。
				const content = input.readText(candidate);
				const nodeEntry = content === undefined ? undefined : nodeEntryFromShim(candidate, content);
				if (nodeEntry) return { file: input.nodeExecutable, argsPrefix: [nodeEntry], source: `shim:${suffix}` };
				continue;
			}
			return { file: candidate, argsPrefix: [], source: `bin:${suffix || "plain"}` };
		}
	}
	return undefined;
}

/** 固定 argv：`anydoc <input> -o <output>`。数组形式交给 spawn，永不做 shell 拼接。 */
export function buildConversionCommand(launch: ConverterLaunch, input: { sourcePath: string; outputPath: string; timeoutMs: number }): { file: string; args: string[]; timeoutMs: number; source: string } {
	return { file: launch.file, args: [...launch.argsPrefix, input.sourcePath, "-o", input.outputPath], timeoutMs: input.timeoutMs, source: launch.source };
}

export type MaterialConversionRunner = (command: { file: string; args: string[]; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string } | { failure: string }>;

/** 真进程执行：同步 spawn 失败、error 事件、超时 kill、退出码全都结算成结果。 */
export function spawnConversion(command: { file: string; args: string[]; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string } | { failure: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome: { code: number; stdout: string; stderr: string } | { failure: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		let child: ReturnType<typeof spawn>;
		const timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				// 进程可能已退出；超时本身已经是要报告的事实。
			}
			finish({ failure: "the converter timed out" });
		}, command.timeoutMs);
		timer.unref?.();
		try {
			child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			// Windows 上 spawn .cmd/.bat 会同步抛 EINVAL；这里必须结算而不是让 Promise 悬空。
			finish({ failure: error instanceof Error ? error.message : String(error) });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < 8000) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 8000) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => finish({ failure: error.message }));
		child.on("close", (code: number | null) => finish({ code: code ?? -1, stdout, stderr }));
	});
}

export type MaterialToolDeps = {
	getBinding: () => DocumentWorkBindingPayload | undefined;
	/** 测试注入点：不真的起子进程。 */
	runConversion?: MaterialConversionRunner;
	/** 解析启动方式；默认用 process.env.PATH 与真实文件系统。 */
	resolveLaunch?: () => ConverterLaunch | undefined;
};

/** 默认 PATH 条目：只来自环境变量与系统默认，不额外探测用户目录。 */
export function defaultPathEntries(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter((entry) => entry.length > 0);
}

export function defaultResolveLaunch(): ConverterLaunch | undefined {
	return resolveConverterLaunch({
		platform: process.platform,
		env: process.env,
		pathEntries: defaultPathEntries(process.env),
		exists: (path) => existsSync(path),
		readText: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		nodeExecutable: process.execPath,
	});
}

/** 路径逃逸校验：真实路径必须仍在指定根内（junction/符号链接都会在这里露出来）。 */
function resolveInsideRoot(rootPath: string, relativePath: string): { ok: true; absolutePath: string } | { ok: false; reason: string } {
	if (relativePath.includes("\0") || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath) || relativePath.includes("\\")) return { ok: false, reason: "the material path is not a bounded relative path" };
	if (relativePath.split("/").some((segment) => segment === ".." || segment === "")) return { ok: false, reason: "the material path escapes its root" };
	let rootReal: string;
	try {
		rootReal = realpathSync(rootPath);
	} catch {
		return { ok: false, reason: "the material root is not readable" };
	}
	const absolute = join(rootReal, ...relativePath.split("/"));
	if (!existsSync(absolute)) return { ok: false, reason: "the material is no longer on disk" };
	let targetReal: string;
	try {
		targetReal = realpathSync(absolute);
	} catch {
		return { ok: false, reason: "the material path cannot be resolved" };
	}
	const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const base = normalize(rootReal);
	const target = normalize(targetReal);
	const separator = process.platform === "win32" ? "\\" : "/";
	if (target !== base && !target.startsWith(base.endsWith(separator) ? base : `${base}${separator}`)) return { ok: false, reason: "the material resolves outside the authorized root" };
	return { ok: true, absolutePath: targetReal };
}

export function registerMaterialTool(pi: ExtensionAPI, deps: MaterialToolDeps): void {
	const runner = deps.runConversion ?? spawnConversion;
	const resolveLaunch = deps.resolveLaunch ?? defaultResolveLaunch;
	let active = 0;
	const queue: Array<() => void> = [];
	const acquire = async () => {
		if (active < MAX_CONCURRENT_CONVERSIONS) {
			active++;
			return;
		}
		await new Promise<void>((resolve) => queue.push(resolve));
		active++;
	};
	const release = () => {
		active = Math.max(0, active - 1);
		const next = queue.shift();
		if (next) next();
	};

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
			const root = binding.materialRoots.find((candidate) => candidate.rootId === material.rootId);
			if (!root) return { content: [{ type: "text", text: "Material rejected: its authorized root is not part of this round." }], isError: true };
			const resolved = resolveInsideRoot(root.path, material.relativePath);
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
			const launch = resolveLaunch();
			if (!launch) return { content: [{ type: "text", text: "Material not converted: the anydoc converter could not be resolved on this machine (checked PIDECK_ANYDOC_PATH and PATH)." }], isError: true };
			const outputRoot = binding.materialRoots.find((candidate) => candidate.rootId === binding.outputRootId);
			if (!outputRoot) return { content: [{ type: "text", text: "Material not converted: this round has no output root to cache into." }], isError: true };
			const cacheDir = join(outputRoot.path, binding.stagingRelativeDir, "_tpa", "materials");
			const outputPath = join(cacheDir, `${material.materialId}.md`);
			const metaPath = join(cacheDir, `${material.materialId}.meta.json`);
			const cached = readCache(metaPath, outputPath, sourceSha256);
			if (cached !== undefined) return { content: [{ type: "text", text: bound(cached) }], details: { materialId: material.materialId, sourceSha256, converter: DOCUMENT_WORK_PROTOCOL.converterVersion, cacheHit: true } };
			try {
				mkdirSync(cacheDir, { recursive: true });
			} catch {
				return { content: [{ type: "text", text: "Material not converted: the conversion cache directory is not writable." }], isError: true };
			}
			await acquire();
			let outcome: { code: number; stdout: string; stderr: string } | { failure: string };
			try {
				outcome = await runner(buildConversionCommand(launch, { sourcePath: resolved.absolutePath, outputPath, timeoutMs: DOCUMENT_WORK_PROTOCOL.budgets.conversionMs }));
			} finally {
				release();
			}
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

/** 只读目录列举（诊断/测试）：不参与转换路径。 */
export function listDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}
