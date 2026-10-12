/**
 * TPA 独立文稿：路径边界校验。
 *
 * 文稿功能把用户选定的成果目录当作唯一可写的项目根（另外还有 TPA 管理的快照根）。
 * 候选文件来自模型汇报，属于不可信输入，因此每个路径都要过两道闸：
 *
 * 1. **相对路径形态**（`isSafeRelativePath`）：拒绝绝对路径、`..`、反斜杠、NUL、盘符。
 * 2. **真实路径包含**：把最近的已存在祖先做 `realpath`，确认解析后的真实路径仍在根内。
 *    Windows junction 和符号链接都会被 `realpath` 解析出来，从而挡住"看起来在根内、
 *    实际指向根外"的逃逸。
 *
 * 校验只读文件系统，不创建目录；创建由 ArtifactStore 在通过校验后执行。
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSafeRelativePath } from "../../shared/documentWork";

export type PathGuardStat = { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number };

/** 只读文件系统端口；测试注入假实现来构造 junction/符号链接与竞态。 */
export type DocumentPathFsPort = {
	realpath(path: string): string;
	stat(path: string): PathGuardStat | undefined;
	/** 按字节读取（有界由调用方控制）。 */
	readFile(path: string): Buffer | undefined;
	exists(path: string): boolean;
	mkdirExclusive(path: string): boolean;
	mkdirRecursive(path: string): void;
	copyFile(source: string, destination: string): void;
	remove(path: string): void;
	writeFile(path: string, data: Buffer): void;
	listDir(path: string): string[];
};

export type DocumentPathFailure = { code: "PATH_DENIED" | "IO_ERROR"; detail: string };
export type DocumentPathResolution = { ok: true; absolutePath: string; realPath: string } | { ok: false; error: DocumentPathFailure };

/** 根与候选的真实路径包含判定；Windows 下大小写不敏感。 */
export function isInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
	const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const normalizedRoot = normalize(resolve(rootRealPath));
	const normalizedCandidate = normalize(resolve(candidateRealPath));
	if (normalizedRoot === normalizedCandidate) return true;
	const rel = relative(normalizedRoot, normalizedCandidate);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 把已经过形态校验的相对路径解析成根内绝对路径，并核对真实路径。
 *
 * 关键点：目标可能还不存在（新版本目录）。这时逐级向上找到最近的已存在祖先，
 * 对祖先做 `realpath` 并检查包含关系——只要中间任何一段是逃逸链接就会被发现。
 */
export function resolveWithinRoot(fs: DocumentPathFsPort, rootPath: string, relativePath: string): DocumentPathResolution {
	if (!isSafeRelativePath(relativePath)) return { ok: false, error: { code: "PATH_DENIED", detail: "relative path is not a bounded in-root path" } };
	let rootReal: string;
	try {
		rootReal = fs.realpath(rootPath);
	} catch {
		return { ok: false, error: { code: "PATH_DENIED", detail: "output root is not readable" } };
	}
	const absolute = resolve(rootReal, ...relativePath.split("/"));
	let probe = absolute;
	for (let depth = 0; depth < 64; depth++) {
		if (fs.exists(probe)) break;
		const parent = dirname(probe);
		if (parent === probe) return { ok: false, error: { code: "PATH_DENIED", detail: "path has no existing ancestor inside the root" } };
		probe = parent;
	}
	let probeReal: string;
	try {
		probeReal = fs.realpath(probe);
	} catch {
		return { ok: false, error: { code: "PATH_DENIED", detail: "path resolution failed" } };
	}
	if (!isInsideRoot(rootReal, probeReal)) return { ok: false, error: { code: "PATH_DENIED", detail: "path escapes the allowed root (symlink or junction)" } };
	// 目标本身已存在时再核对一次：符号链接指向根外必须拒绝。
	if (probe === absolute) {
		let targetReal: string;
		try {
			targetReal = fs.realpath(absolute);
		} catch {
			return { ok: false, error: { code: "PATH_DENIED", detail: "target path is not readable" } };
		}
		if (!isInsideRoot(rootReal, targetReal)) return { ok: false, error: { code: "PATH_DENIED", detail: "target resolves outside the allowed root" } };
	}
	return { ok: true, absolutePath: absolute, realPath: probeReal };
}

/** 普通非空文件判定；目录、设备文件、空文件都不作为成果候选。 */
export function isRegularNonEmptyFile(fs: DocumentPathFsPort, absolutePath: string): boolean {
	const stat = fs.stat(absolutePath);
	return Boolean(stat && stat.isFile() && stat.size > 0);
}

/** 相对路径拼接（posix 语义），供版本目录与 staging 目录使用。 */
export function joinRelative(...segments: string[]): string {
	return segments.filter((segment) => segment.length > 0).join("/");
}

export function pathSegments(absolutePath: string): string[] {
	return absolutePath.split(sep);
}
