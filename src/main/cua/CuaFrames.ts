/**
 * 最近截图帧的短期缓存（frameId → 几何 + 原生 JPEG）。
 *
 * 为什么需要：`cua_click` / `cua_scroll` / `cua_zoom` 要引用「模型刚看到的那张图」，
 * 而模型只拿到 `frameId`。帧描述必须和截图的时刻绑定，缓存在宿主主进程里，不写会话账本。
 *
 * 资源边界（AGENTS.md 稳定性约束）：
 * - 只保留最近 `maxFrames` 帧（LRU），并有 `ttlMs` 过期，不保留无限历史帧；
 * - 每帧最多持有「交付 JPEG」与「原生 JPEG」各一份，原生 JPEG 用于细节裁剪；
 * - `dispose()` 清空，CuaService 停止时调用，同模块内有明确清理路径。
 */

import type { CuaFrameGeometry } from "./CuaGeometry";

export type CuaRegisteredFrame = {
	geometry: CuaFrameGeometry;
	/** 原生分辨率 JPEG（`cua_zoom` 的裁剪来源）。 */
	nativeJpeg: Buffer;
	/** 发起截图的会话（工具带 sessionId 时记录），仅作追溯。 */
	sessionId?: string;
	/** 该帧交付 JPEG 的落盘引用（轨迹回看用）；未启用落盘时缺省。 */
	screenshotRef?: string;
	/** 最近一次被读取的时间（LRU/TTL 依据）。 */
	touchedAtMs: number;
};

export type CuaFrameRegistryOptions = {
	/** 最多保留多少帧（默认 6：一次任务通常只需前后几张）。 */
	maxFrames?: number;
	/** 帧的存活时间（默认 10 分钟）。 */
	ttlMs?: number;
	/** 时钟注入（测试用）。 */
	now?: () => number;
};

export const DEFAULT_FRAME_LIMIT = 6;
export const DEFAULT_FRAME_TTL_MS = 10 * 60 * 1000;

export class CuaFrameRegistry {
	private readonly frames = new Map<string, CuaRegisteredFrame>();
	private readonly maxFrames: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: CuaFrameRegistryOptions = {}) {
		this.maxFrames = Math.max(1, options.maxFrames ?? DEFAULT_FRAME_LIMIT);
		this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_FRAME_TTL_MS);
		this.now = options.now ?? Date.now;
	}

	register(entry: { geometry: CuaFrameGeometry; nativeJpeg: Buffer; sessionId?: string; screenshotRef?: string }): void {
		this.prune();
		// Map 迭代序 = 插入序：重名（同一 frameId 再次登记）时先删再插，保持 LRU 语义。
		this.frames.delete(entry.geometry.frameId);
		this.frames.set(entry.geometry.frameId, { ...entry, touchedAtMs: this.now() });
		while (this.frames.size > this.maxFrames) {
			const oldest = this.frames.keys().next().value;
			if (oldest === undefined) break;
			this.frames.delete(oldest);
		}
	}

	/** 取帧并标记最近使用；过期帧返回 undefined（不静默返回旧几何）。 */
	get(frameId: string): CuaRegisteredFrame | undefined {
		this.prune();
		const entry = this.frames.get(frameId);
		if (!entry) return undefined;
		entry.touchedAtMs = this.now();
		return entry;
	}

	/** 丢弃过期帧。每次登记/读取/显式检查时调用，避免后台定时器。 */
	prune(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [frameId, entry] of this.frames) {
			if (entry.touchedAtMs < cutoff) this.frames.delete(frameId);
		}
	}

	size(): number {
		this.prune();
		return this.frames.size;
	}

	dispose(): void {
		this.frames.clear();
	}
}
