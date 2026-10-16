/**
 * 用量统计域服务：探测 / 增量刷新 / 查询聚合视图。
 *
 * 数据源（只读，采集由 pi-tracker 扩展负责）：
 *  - pi：<agentDir>/analytics/usage.jsonl（append-only）
 *
 * 增量缓存；文件不存在不算错误。
 *
 * 缓存策略（两层，按日志路径隔离）：
 *  - 内存 memoryState（权威）：进程内连续刷新走增量合并，O(新增行)
 *  - 磁盘 SessionSummaryCache（冷启动恢复）：version 一致时零 IO 恢复中间态
 *  - SessionSummaryCache.get 在版本不匹配时会删除旧条目，因此旧游标只能
 *    来自 memoryState；冷启动遇文件已变更 → 全量重扫一次（正确降级）
 *
 * 错误语义：文件不存在 = 「该源未安装」；其他 IO 失败一律抛结构化错误
 * （跨 IPC 由 handler 传播，渲染层进 error 态），不吞成「无数据」。
 *
 * 视图（today/周/月/热力图）每次按当前时间从中间态重建，跨刷新时间漂移安全。
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageAggregated, UsageStatsDetectResult, UsageStatsRefreshResult } from "../../shared/types/usageStats";
import { SessionSummaryCache, type SessionFileVersion } from "../sessions/sessionSummaryCache";
import { buildAggregatedView, intermediateFromRecords, mergeIntermediates, type UsageStatsIntermediate } from "./usageStatsAggregator";
import { UsageLogReader, type LogFileState } from "./UsageLogReader";

/** 缓存结构版本：dayBuckets 含 byModel/byProject 明细后升到 2（旧结构直接弃用触发全量重扫）。 */
const CACHE_SCHEMA_VERSION = 2;

/** 缓存值：结构版本 + 游标 + 可序列化中间态（视图按 now 派生，不落盘）。 */
type CachedUsageStats = {
	schemaVersion: number;
	fileState: LogFileState;
	intermediate: UsageStatsIntermediate;
};

/** 内存态（含文件版本，用于增量路径与冷启动恢复）。 */
type MemoryState = {
	version: SessionFileVersion;
	cached: CachedUsageStats;
};

export type UsageStatsServiceDeps = {
	/** pi agent 目录 host 路径（WSL 场景已由装配层转换为 host 路径） */
	agentDir: string;
	/** 缓存目录（测试注入；默认 electron userData） */
	userDataDir?: string;
	logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
};

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function versionEqual(a: SessionFileVersion, b: SessionFileVersion): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

class UsageLogSource {
	private memoryState: MemoryState | null = null;

	constructor(
		private readonly label: string,
		private readonly reader: UsageLogReader,
		private readonly cache: SessionSummaryCache<CachedUsageStats>,
		private readonly logger?: UsageStatsServiceDeps["logger"],
	) {}

	clearMemory(): void {
		this.memoryState = null;
	}

	async detect(logPath: string): Promise<{
		present: boolean;
		recordCount: number | null;
		firstRecordAt: number | null;
		lastRecordAt: number | null;
	}> {
		const fileStat = await statLogOrMissing(logPath, this.logger);
		if (!fileStat) {
			return { present: false, recordCount: null, firstRecordAt: null, lastRecordAt: null };
		}
		const version = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
		const state = await this.loadState(logPath, version);
		if (state) {
			const { intermediate } = state.cached;
			const hasData = intermediate.recordCount > 0;
			return {
				present: true,
				recordCount: intermediate.recordCount,
				firstRecordAt: hasData ? intermediate.window.since : null,
				lastRecordAt: hasData ? intermediate.window.to : null,
			};
		}
		return { present: true, recordCount: null, firstRecordAt: null, lastRecordAt: null };
	}

	async refresh(logPath: string): Promise<UsageStatsRefreshResult> {
		const fileStat = await statLogOrMissing(logPath, this.logger);
		if (!fileStat) return emptyRefresh();

		const version = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
		const state = await this.loadState(logPath, version);
		if (state) return emptyRefresh();

		const prev = this.memoryState?.cached.fileState ?? null;
		const result = await this.reader.readIncremental(logPath, prev);
		if (!result.fileState) return emptyRefresh();
		if (result.truncated) {
			this.logger?.warn?.(`[UsageStats:${this.label}] log exceeds read cap; data may be incomplete (${result.newRecords.length} records read)`);
		}

		if (result.fullRescan) {
			// 全量重扫：无论新记录多少都整体替换（0 条 = 文件被清空，必须提交空态，
			// 否则旧中间态会在新版本下复活，文件再长回来时增量合并 → 双计）
			const intermediate = intermediateFromRecords(result.newRecords);
			this.commitState(logPath, version, {
				schemaVersion: CACHE_SCHEMA_VERSION,
				fileState: result.fileState,
				intermediate,
			});
			this.logger?.info?.(`[UsageStats:${this.label}] full rescan: ${result.newRecords.length} records${result.truncated ? " (truncated)" : ""}`);
		} else if (result.newRecords.length > 0) {
			const delta = intermediateFromRecords(result.newRecords);
			const intermediate = this.memoryState ? mergeIntermediates(this.memoryState.cached.intermediate, delta) : delta;
			this.commitState(logPath, version, {
				schemaVersion: CACHE_SCHEMA_VERSION,
				fileState: result.fileState,
				intermediate,
			});
			this.logger?.info?.(`[UsageStats:${this.label}] refreshed: +${result.newRecords.length} records`);
		} else if (this.memoryState) {
			// 文件变了但没有新记录（如 mtime 抖动）：仅更新游标
			this.commitState(logPath, version, { ...this.memoryState.cached, fileState: result.fileState });
		}

		return {
			fullRescan: result.fullRescan,
			parsedRecords: result.newRecords.length,
			skippedLines: result.skippedLines,
		};
	}

	async getIntermediate(logPath: string): Promise<UsageStatsIntermediate | null> {
		const fileStat = await statLogOrMissing(logPath, this.logger);
		if (!fileStat) return null;

		const version = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
		let state = await this.loadState(logPath, version);
		if (!state) {
			await this.refresh(logPath);
			state = this.memoryState && versionEqual(this.memoryState.version, version) ? this.memoryState : null;
		}
		return state?.cached.intermediate ?? null;
	}

	private async loadState(logPath: string, version: SessionFileVersion): Promise<MemoryState | null> {
		if (this.memoryState && versionEqual(this.memoryState.version, version)) {
			return this.memoryState;
		}
		await this.cache.ensureLoaded();
		const cached = this.cache.get(logPath, version);
		if (!cached) return null;
		if (cached.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
		this.memoryState = { version, cached };
		return this.memoryState;
	}

	private commitState(logPath: string, version: SessionFileVersion, cached: CachedUsageStats): void {
		this.memoryState = { version, cached };
		this.cache.set(logPath, version, {
			schemaVersion: CACHE_SCHEMA_VERSION,
			fileState: cached.fileState,
			intermediate: cached.intermediate,
		});
	}
}

function emptyRefresh(): UsageStatsRefreshResult {
	return { fullRescan: false, parsedRecords: 0, skippedLines: 0 };
}

/** stat 日志文件；ENOENT 返回 null（= 该源未安装），其他错误抛结构化异常。 */
async function statLogOrMissing(logPath: string, logger?: UsageStatsServiceDeps["logger"]): Promise<{ mtimeMs: number; size: number } | null> {
	try {
		return await stat(logPath);
	} catch (error) {
		if (isMissingFileError(error)) return null;
		logger?.warn?.(`[UsageStats] stat failed: ${String(error)}`);
		throw error;
	}
}

export class UsageStatsService {
	private agentDir: string;
	private readonly piSource: UsageLogSource;
	/** 单飞：重叠 refresh 共享同一次执行，防止同一批记录被合并两次。 */
	private refreshPromise: Promise<UsageStatsRefreshResult> | null = null;

	constructor(deps: UsageStatsServiceDeps) {
		this.agentDir = deps.agentDir;
		this.logger = deps.logger;
		// 独立缓存文件：与 session-summary-cache 互不干扰。
		const cache = new SessionSummaryCache<CachedUsageStats>("usage-stats-cache.json", deps.userDataDir);
		this.piSource = new UsageLogSource("pi", new UsageLogReader(), cache, deps.logger);
	}

	private readonly logger?: UsageStatsServiceDeps["logger"];

	private get piLogPath(): string {
		return join(this.agentDir, "analytics", "usage.jsonl");
	}

	/** WSL 环境后置配置：装配层在 syncWslEnvironment 时调用（host 路径）。 */
	setAgentDir(agentDir: string): void {
		if (agentDir === this.agentDir) return;
		this.agentDir = agentDir;
		this.piSource.clearMemory();
	}

	/** 探测日志状态（轻量：只 stat + 读缓存，不触发全量读）。 */
	async detect(): Promise<UsageStatsDetectResult> {
		const piPath = this.piLogPath;
		const pi = await this.piSource.detect(piPath);
		return {
			installed: pi.present,
			piInstalled: pi.present,
			logPath: pi.present ? piPath : null,
			recordCount: pi.recordCount,
			firstRecordAt: pi.firstRecordAt,
			lastRecordAt: pi.lastRecordAt,
		};
	}

	/** 增量刷新：返回本次解析统计；缓存已最新时零 IO。 */
	refresh(): Promise<UsageStatsRefreshResult> {
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.piSource.refresh(this.piLogPath).finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	/** 查询聚合视图；未缓存/过期时先刷新。日志不存在返回 null。 */
	async getAggregated(): Promise<UsageAggregated | null> {
		const pi = await this.piSource.getIntermediate(this.piLogPath);
		return pi ? buildAggregatedView(pi) : null;
	}
}
