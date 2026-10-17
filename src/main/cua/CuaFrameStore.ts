/**
 * CUA 截图落盘（轨迹回看用）：内容寻址 JPEG + 数量上限。
 *
 * 为什么单独一个目录：生图 blob 目录的孤儿回收以「生图会话 JSONL 里引用的 ref」为准，
 * CUA 截图没有那条引用账本，复用同一个目录会在一次生图清理后把回看截图删掉。
 * 这里复用 `ImageBlobStore` 的实现（sha256 命名、base64 校验、路径白名单、读取字节上限），
 * 只把目录和生命周期换成 CUA 自己的。
 *
 * 记录里只存 ref；`prune()` 按最近修改时间保留最近 `maxFrames` 张，避免无限增长。
 */

import { stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ImageBlobStore } from "../imagegen/ImageBlobStore";

export type CuaFrameStoreDeps = {
	/** 截图目录（userData/cua/frames）。 */
	getFramesPath: () => string;
	/** 最多保留多少张（默认 200）。 */
	maxFrames?: number;
};

export const DEFAULT_CUA_FRAME_LIMIT = 200;

export class CuaFrameStore {
	private readonly blobs: ImageBlobStore;
	private readonly getFramesPath: () => string;
	private readonly maxFrames: number;
	private pruning = false;

	constructor(deps: CuaFrameStoreDeps) {
		this.getFramesPath = deps.getFramesPath;
		this.maxFrames = Math.max(1, deps.maxFrames ?? DEFAULT_CUA_FRAME_LIMIT);
		this.blobs = new ImageBlobStore({ getBlobsPath: deps.getFramesPath });
	}

	/** 保存一张 JPEG，返回内容寻址引用；失败返回 null（截图主链路不受影响）。 */
	async save(base64: string, mimeType: string): Promise<string | null> {
		const ref = await this.blobs.put(base64, mimeType);
		if (!ref) return null;
		// 内容寻址会复用同一张旧文件：刷新 mtime，让「最近使用」的截图不被数量上限清掉。
		const path = this.blobs.resolvePath(ref);
		if (path) {
			try {
				const now = new Date();
				await utimes(path, now, now);
			} catch {
				// 刷新失败不影响保存结果
			}
		}
		void this.prune().catch(() => {});
		return ref;
	}

	/** 引用 → 绝对路径（白名单校验在 ImageBlobStore 内）。 */
	resolvePath(ref: string): string | null {
		return this.blobs.resolvePath(ref);
	}

	/** 保留最近 maxFrames 张，返回删除数量。并发调用时后到的直接跳过。 */
	async prune(): Promise<number> {
		if (this.pruning) return 0;
		this.pruning = true;
		try {
			const dir = this.getFramesPath();
			const refs = await this.blobs.listRefs();
			if (refs.length <= this.maxFrames) return 0;
			const entries: Array<{ ref: string; mtimeMs: number }> = [];
			for (const ref of refs) {
				const path = join(dir, ref);
				try {
					const info = await stat(path);
					entries.push({ ref, mtimeMs: info.mtimeMs });
				} catch {
					// 已被并发删除/不可读：跳过
				}
			}
			entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
			let removed = 0;
			for (const entry of entries.slice(this.maxFrames)) {
				const path = this.blobs.resolvePath(entry.ref);
				if (!path) continue;
				try {
					await unlink(path);
					removed += 1;
				} catch {
					// 删除失败不影响其余文件
				}
			}
			return removed;
		} finally {
			this.pruning = false;
		}
	}
}
