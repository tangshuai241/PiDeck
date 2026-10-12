/**
 * 文稿域的文件原语：指纹、原子写入、真实路径边界检查。
 *
 * 为什么单独成文件：版本归档、基稿冻结、材料转换和检查都要用同一套字节语义，
 * 复制一份到各处迟早会出现「一处用 realpath、一处用字符串前缀」的逃逸漏洞。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const FILE_DIGEST_ALGORITHM = "sha256";

export type FileFingerprint = { digest: string; bytes: number };

/** 程序生成的记录 id：前缀 + 24 位随机十六进制，便于日志里识别类型。 */
export function insertId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function hashText(text: string): string {
	return createHash(FILE_DIGEST_ALGORITHM).update(text, "utf8").digest("hex");
}

export function hashBytes(bytes: Uint8Array): string {
	return createHash(FILE_DIGEST_ALGORITHM).update(bytes).digest("hex");
}

/** 流式哈希：预算上限由调用方给出，超限返回 undefined 而不是读爆内存。 */
export async function fingerprintFile(path: string, byteBudget = Number.POSITIVE_INFINITY): Promise<FileFingerprint | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
	} catch {
		return undefined;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return undefined;
		if (info.size > byteBudget) return undefined;
		const hash = createHash(FILE_DIGEST_ALGORITHM);
		const stream = createReadStream(path, { highWaterMark: 1 << 20 });
		let bytes = 0;
		for await (const chunk of stream) {
			const buffer = chunk as Buffer;
			bytes += buffer.byteLength;
			if (bytes > byteBudget) return undefined;
			hash.update(buffer);
		}
		return { digest: hash.digest("hex"), bytes };
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function isReadableFile(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isFile();
	} catch {
		return false;
	}
}

export async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/**
 * 原子写入：先写同目录临时文件再 rename，避免断电/崩溃留下半截 JSON。
 * 覆盖前把旧内容留成 `.bak`，读取侧在 JSON 损坏时能回退一个可用版本。
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
	await ensureDirectory(dirname(path));
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, data, "utf8");
	try {
		const existing = await readFile(path).catch(() => undefined);
		if (existing !== undefined) await writeFile(`${path}.bak`, existing);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** 读取 JSON 时把损坏的主文件降级到 `.bak`；两者都坏则返回 undefined（调用方 fail-closed）。 */
/**
 * 带健康度的 JSON 读取：主文件损坏与「文件不存在」是两回事。
 *
 * 为什么必须区分（评审要求）：`.bak` 只能当只读恢复证据。把损坏的主档当不存在，
 * 会让 `create` 重建一件工作、让 CAS 从旧版本继续、让已被拒绝的 `start` 重新获权。
 */
export type JsonReadResult = { kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "corrupt"; recovered?: unknown };

export async function readJsonWithHealth(path: string): Promise<JsonReadResult> {
	const primary = await readFile(path, "utf8").catch(() => undefined);
	if (primary === undefined) return { kind: "missing" };
	try {
		return { kind: "ok", value: JSON.parse(primary) as unknown };
	} catch {
		// 主档存在但读不动：旧备份只作证据交给调用方，绝不在这里替它做主。
		const backup = await readFile(`${path}.bak`, "utf8").catch(() => undefined);
		if (backup === undefined) return { kind: "corrupt" };
		try {
			return { kind: "corrupt", recovered: JSON.parse(backup) as unknown };
		} catch {
			return { kind: "corrupt" };
		}
	}
}

/** 只读恢复证据：主档正常用主档，损坏时用备份，缺失时 undefined。 */
export async function readJsonResilient(path: string): Promise<unknown> {
	const result = await readJsonWithHealth(path);
	if (result.kind === "ok") return result.value;
	if (result.kind === "corrupt") return result.recovered;
	return undefined;
}

/** 存在性判断不抛异常，避免调用方漏 catch；不可读与不存在在这里等价处理。 */
export async function pathExists(path: string): Promise<boolean> {
	return access(path, constants.F_OK).then(
		() => true,
		() => false,
	);
}

/**
 * 真实路径归一：对目标本身做 realpath，目标不存在时对最近的已存在祖先做 realpath，
 * 再把剩余段拼回去。Windows 的 junction 与 POSIX 的符号链接都会在这里被解析，
 * 因此逃逸检查不能用字符串前缀代替。
 */
export async function resolveRealPath(path: string): Promise<string> {
	const absolute = resolve(path);
	let current = absolute;
	const tail: string[] = [];
	for (let depth = 0; depth < 64; depth++) {
		try {
			const real = await realpath(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolute;
			tail.push(
				current
					.slice(parent.length + 1)
					.split(sep)
					.join(sep),
			);
			current = parent;
		}
	}
	return absolute;
}

export type ContainmentResult = { ok: true; realPath: string } | { ok: false; reason: "escaped" | "denied" };

/** 绝对路径 + 真实路径双重检查：拒绝 `..` 逃逸、符号链接/junction 逃逸与盘符切换。 */
export async function containPath(root: string, candidate: string): Promise<ContainmentResult> {
	if (!isAbsolute(candidate)) return { ok: false, reason: "denied" };
	const realRoot = await resolveRealPath(root);
	const realCandidate = await resolveRealPath(candidate);
	if (realRoot === realCandidate) return { ok: true, realPath: realCandidate };
	const relativePath = relative(realRoot, realCandidate);
	if (relativePath.length === 0) return { ok: true, realPath: realCandidate };
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return { ok: false, reason: "escaped" };
	return { ok: true, realPath: realCandidate };
}

/** 版本目录内的相对路径：再走一次纯字符串校验，双保险挡住绝对路径与 `..`。 */
export function resolveInsideDirectory(directory: string, relativePath: string): string | undefined {
	const normalized = relativePath.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
	return join(directory, ...segments);
}

/** 材料根检查：只接受用户授权目录或项目目录内的路径，其余一律拒绝。 */
export async function isPathInsideAnyRoot(roots: readonly string[], candidate: string): Promise<boolean> {
	for (const root of roots) {
		const containment = await containPath(root, candidate);
		if (containment.ok) return true;
	}
	return false;
}

export function directoryLabel(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}
