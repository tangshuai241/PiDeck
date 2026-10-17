/**
 * 会话结果与已读记录（`userData/session-attention.json`）。
 *
 * 只保存状态摘要需要的元数据：最近一轮结果身份、结果分类、已读确认、进行中的轮次。
 * 不复制聊天正文；聊天仍以 pi 会话文件为准。
 *
 * 规则（对应任务书 §5）：
 * - 结果身份 = 该轮的执行 id，开始执行时生成并落盘，跨重启稳定；
 * - 新结果只更新「最近结果」，不立即清掉上一轮未读；
 * - 主动停止保留结果类型，但直接标记已读（不产生完成提醒）；
 * - 启动加载时，进行中却没有运行时的轮次表达为中断；
 * - 老会话没有记录时保持为空，不批量把历史标记为未读。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { SESSION_ATTENTION_FILE_VERSION, type SessionCompletion, type SessionCompletionOutcome } from "../../../shared/types/sessionAttention";
import { renameWithRetry } from "../../utils/fsRetry";

export type SessionAttentionEntry = {
	completion?: SessionCompletion;
	handledCompletionId?: string;
	activeRunId?: string;
	runStartedAt?: number;
};

type AttentionFile = { version: number; sessions: Record<string, SessionAttentionEntry> };

const FLUSH_DEBOUNCE_MS = 400;
const MAX_SESSIONS = 500;

export class SessionAttentionStore {
	private entries = new Map<string, SessionAttentionEntry>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private writeTail: Promise<void> = Promise.resolve();
	private loadPromise: Promise<void> | undefined;

	constructor(
		private readonly deps: {
			getFilePath: () => string;
			log?: (level: "info" | "error", message: string, detail?: unknown) => void;
			now?: () => number;
		},
	) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/** 读盘并恢复；同一进程内只加载一次。 */
	load(): Promise<void> {
		this.loadPromise ??= this.loadOnce();
		return this.loadPromise;
	}

	private async loadOnce(): Promise<void> {
		let parsed: AttentionFile | undefined;
		try {
			const value: unknown = JSON.parse(await readFile(this.deps.getFilePath(), "utf8"));
			parsed = parseAttentionFile(value);
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code !== "ENOENT") this.deps.log?.("error", "session attention file unreadable, starting empty", { error: String(error) });
		}
		if (!parsed) return;
		for (const [sessionId, entry] of Object.entries(parsed.sessions)) this.entries.set(sessionId, entry);
		// 上次退出时仍在执行的轮次：对应运行时已不存在 → 中断。
		for (const [sessionId, entry] of this.entries) {
			if (!entry.activeRunId) continue;
			const finishedAt = this.now();
			this.entries.set(sessionId, { completion: { id: entry.activeRunId, outcome: "interrupted", finishedAt }, handledCompletionId: entry.handledCompletionId });
		}
		this.scheduleFlush();
	}

	get(sessionId: string): SessionAttentionEntry | undefined {
		return this.entries.get(sessionId);
	}

	/** 已记录状态的全部会话（供摘要列表合并，不暴露可变引用）。 */
	listEntries(): Array<[string, SessionAttentionEntry]> {
		return [...this.entries];
	}

	/** 新一轮开始：记录进行中的轮次身份；不触碰上一轮尚未查看的结果。 */
	beginRun(sessionId: string, at = this.now()): string {
		const existing = this.entries.get(sessionId);
		if (existing?.activeRunId) return existing.activeRunId;
		const runId = `${sessionId}:${at.toString(36)}:${randomUUID()}`;
		this.entries.set(sessionId, { ...existing, activeRunId: runId, runStartedAt: at });
		this.scheduleFlush();
		return runId;
	}

	/**
	 * 轮次结束：写入最近结果。
	 * 同一轮重复上报（settled 与兜底路径）只认第一次，避免覆盖已读状态。
	 * 主动停止直接视为已读：保留「已停止」结果类型，但不产生新的完成提醒。
	 */
	finishRun(sessionId: string, runId: string, outcome: SessionCompletionOutcome, at = this.now()): SessionAttentionEntry | undefined {
		const existing = this.entries.get(sessionId);
		if (!existing || existing.activeRunId !== runId) return undefined;
		const completion: SessionCompletion = { id: runId, outcome, finishedAt: at };
		const entry: SessionAttentionEntry = {
			completion,
			handledCompletionId: outcome === "aborted" ? runId : existing.handledCompletionId,
		};
		this.entries.set(sessionId, entry);
		this.pruneSessions();
		this.scheduleFlush();
		return entry;
	}

	/** 端上实际看到结果后确认已读；只认当前结果身份，旧结果的迟到确认不生效。 */
	acknowledge(sessionId: string, completionId: string): SessionAttentionEntry | undefined {
		const existing = this.entries.get(sessionId);
		if (!existing?.completion || existing.completion.id !== completionId || existing.handledCompletionId === completionId) return existing;
		const entry: SessionAttentionEntry = { ...existing, handledCompletionId: completionId };
		this.entries.set(sessionId, entry);
		this.scheduleFlush();
		return entry;
	}

	/** 当前进行中轮次（供摘要服务判断是否需要记录结束）。 */
	activeRunId(sessionId: string): string | undefined {
		return this.entries.get(sessionId)?.activeRunId;
	}

	private pruneSessions(): void {
		if (this.entries.size <= MAX_SESSIONS) return;
		const finished = [...this.entries].filter(([, entry]) => !entry.activeRunId).sort((left, right) => (left[1].completion?.finishedAt ?? 0) - (right[1].completion?.finishedAt ?? 0));
		for (const [sessionId] of finished) {
			if (this.entries.size <= MAX_SESSIONS) break;
			this.entries.delete(sessionId);
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush().catch(() => undefined);
		}, FLUSH_DEBOUNCE_MS);
		this.flushTimer.unref?.();
	}

	/** 立即写盘（防抖窗口合并；退出前由装配层兜底调用）。 */
	flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		const write = async (): Promise<void> => {
			const path = this.deps.getFilePath();
			await mkdir(dirname(path), { recursive: true });
			const temp = `${path}.${randomUUID()}.tmp`;
			const file: AttentionFile = { version: SESSION_ATTENTION_FILE_VERSION, sessions: Object.fromEntries(this.entries) };
			await writeFile(temp, JSON.stringify(file));
			await renameWithRetry(temp, path);
		};
		const next = this.writeTail.then(write, write);
		this.writeTail = next.catch(() => undefined);
		return next;
	}
}

/** 只接受本模块写出的格式；字段不全的记录丢弃，不阻断其余会话恢复。 */
function parseAttentionFile(value: unknown): AttentionFile | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { version?: unknown; sessions?: unknown };
	if (record.version !== SESSION_ATTENTION_FILE_VERSION || !record.sessions || typeof record.sessions !== "object") return undefined;
	const sessions: Record<string, SessionAttentionEntry> = {};
	for (const [sessionId, raw] of Object.entries(record.sessions as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const parsed: SessionAttentionEntry = {};
		const completion = entry.completion as Partial<SessionCompletion> | undefined;
		if (completion && typeof completion.id === "string" && isOutcome(completion.outcome) && typeof completion.finishedAt === "number") {
			parsed.completion = { id: completion.id, outcome: completion.outcome, finishedAt: completion.finishedAt };
		}
		if (typeof entry.handledCompletionId === "string") parsed.handledCompletionId = entry.handledCompletionId;
		if (typeof entry.activeRunId === "string") parsed.activeRunId = entry.activeRunId;
		if (typeof entry.runStartedAt === "number") parsed.runStartedAt = entry.runStartedAt;
		if (parsed.completion || parsed.activeRunId) sessions[sessionId] = parsed;
	}
	return { version: SESSION_ATTENTION_FILE_VERSION, sessions };
}

function isOutcome(value: unknown): value is SessionCompletionOutcome {
	return value === "succeeded" || value === "failed" || value === "aborted" || value === "interrupted";
}
