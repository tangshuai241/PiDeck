/**
 * pi-deck-cloud-memory-log —— 观测 JSONL 的有界写入与配置状态去重记录。
 *
 * 为什么独立：轮换/大小上限/「同 session 只记一次配置状态」是纯 IO 策略，
 * wrapper 只提供路径与 runId；这里不做任何网络或记忆内容处理。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { buildLogRecord, MAX_LOG_BYTES, type CloudMemoryLogRecord, type CloudMemoryRecordStatus } from "./pi-deck-cloud-memory-policy";

export type ObservationLog = {
	append: (logFile: string, record: CloudMemoryLogRecord) => void;
	reportOnce: (sessionId: string | null, status: CloudMemoryRecordStatus, reason: string | null, logFile: string) => void;
};

export function createObservationLog(options: { makeRunId: () => string }): ObservationLog {
	/** 同一 session 的 unconfigured/disabled/配置错误只记一次，避免每次工具调用刷日志。 */
	const reportedStatuses = new Set<string>();

	/** 日志有界：到达上限轮换到 `<log>.1`（覆盖旧备份），总占用不超过约 2×上限。 */
	function append(logFile: string, record: CloudMemoryLogRecord): void {
		try {
			mkdirSync(dirname(logFile), { recursive: true });
			if (existsSync(logFile) && statSync(logFile).size >= MAX_LOG_BYTES) {
				const rotated = `${logFile}.1`;
				try {
					rmSync(rotated, { force: true });
				} catch {
					// 备份删不掉也要继续轮换主文件；最终写入失败会被外层 catch 吞掉。
				}
				renameSync(logFile, rotated);
			}
			appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
		} catch {
			// 观察模块失败只表现为这一行缺席，绝不影响 pi 会话。
		}
	}

	function reportOnce(sessionId: string | null, status: CloudMemoryRecordStatus, reason: string | null, logFile: string): void {
		const key = `${sessionId ?? "-"}\u0000${status}\u0000${reason ?? ""}`;
		if (reportedStatuses.has(key)) return;
		if (reportedStatuses.size > 200) reportedStatuses.clear();
		reportedStatuses.add(key);
		append(
			logFile,
			buildLogRecord({
				kind: "status",
				ts: new Date().toISOString(),
				runId: options.makeRunId(),
				sessionId,
				status,
				reason,
			}),
		);
	}

	return { append, reportOnce };
}
