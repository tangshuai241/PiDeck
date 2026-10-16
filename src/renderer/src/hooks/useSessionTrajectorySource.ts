import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { SessionProcessEvent } from "../../../shared/types/trajectory";
import type { SessionRecord } from "../../../shared/types";
import { isModelTraceLogData } from "../../../shared/types/rpcLog";
import { prependSessionHistoryPageAtom, prependSessionMessagePageAtom, sessionMessageCacheBySessionIdAtomFamily, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, type SessionMessageCacheEntry, type SessionRuntimeViewState } from "../atoms";
import { sessionHistoryUnavailableState } from "../utils/sessionHistoryAvailability";
import { isLiveRuntimeStatus } from "../utils/sessionCommands";
import { parseModelTracePayload } from "../utils/modelTraceParse";
import type { TrajectoryModelTraceSummary } from "../components/session/trajectory/buildTrajectory";

/** 与时间线 runtime 翻页对齐：一次补 3 轮，复用同一份消息缓存。 */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;

const EMPTY_CACHE_ATOM = atom<SessionMessageCacheEntry | undefined>(undefined);
const EMPTY_RECORD_ATOM = atom<SessionRecord | undefined>(undefined);
const EMPTY_RUNTIME_ATOM = atom<SessionRuntimeViewState | undefined>(undefined);

/**
 * 轨迹抽屉的数据源：只订本会话 cache family，把 runtime 历史前缀与窗口段拼成一条账本。
 * 翻页写回同一 atom，时间线与抽屉共享已加载历史，不另开 IPC 通道。
 */
export function useSessionTrajectorySource(sessionId: string | undefined) {
	const cachedEntry = useAtomValue(sessionId ? sessionMessageCacheBySessionIdAtomFamily(sessionId) : EMPTY_CACHE_ATOM);
	const runtime = useAtomValue(sessionId ? sessionRuntimeBySessionIdAtomFamily(sessionId) : EMPTY_RUNTIME_ATOM);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [processEvents, setProcessEvents] = useState<SessionProcessEvent[]>([]);
	const [systemPrompt, setSystemPrompt] = useState<string | undefined>(undefined);
	const [modelTraces, setModelTraces] = useState<TrajectoryModelTraceSummary[]>([]);
	const loadSequenceRef = useRef(0);
	const processSequenceRef = useRef(0);
	const traceSequenceRef = useRef(0);

	useEffect(() => {
		if (!sessionId) {
			setProcessEvents([]);
			return;
		}
		const sequence = ++processSequenceRef.current;
		void desktopApi.sessions
			.readProcessEvents(sessionId)
			.then((events) => {
				if (processSequenceRef.current !== sequence) return;
				setProcessEvents(events);
			})
			.catch(() => {
				if (processSequenceRef.current === sequence) setProcessEvents([]);
			});
	}, [sessionId, cachedEntry?.revision, cachedEntry?.updatedAt]);

	// 模型请求快照（model-trace）：账本补充数据源（拉取 effect 在 messages 之后声明，
	// 重拉触发器之一是 messages.length）。
	// 活运行时传 target（主进程校验后按 agent 过滤）；历史/已停止会话不传 target 会拿到
	// 全部 agent 的日志，再按会话最后已知 agentId 客户端过滤（重启前的旧 agent 世代快照
	// 暂无法归属，接受缺失——快照保留 30 天，近期会话不受影响）。
	const runtimeAgentId = runtime?.agentId;
	const lastKnownAgentId = runtimeAgentId;

	// 系统提示：优先用最近一次模型请求快照里的真实 system（含技能上下文，与发给供应商
	// 的请求体同源）；无快照/解析失败退回 pi-system 模板参考。
	useEffect(() => {
		if (!sessionId) {
			setSystemPrompt(undefined);
			return;
		}
		let cancelled = false;
		const loadPiTemplate = () => {
			if (cancelled) return;
			void desktopApi.prompts
				.list()
				.then((result) => {
					if (cancelled) return;
					const prompt = result.templates.find((item) => item.name === "pi-system");
					setSystemPrompt(prompt?.content);
				})
				.catch(() => {
					if (!cancelled) setSystemPrompt(undefined);
				});
		};
		const latest = modelTraces.at(-1);
		if (!latest?.agentId) {
			loadPiTemplate();
			return () => {
				cancelled = true;
			};
		}
		void desktopApi.rpcLogs
			.getModelTrace({ agentId: latest.agentId, traceId: latest.traceId })
			.then((traceRecord) => {
				if (cancelled) return;
				const systemText = traceRecord ? parseModelTracePayload(traceRecord.payloadJson).system?.text : undefined;
				if (systemText && systemText.trim()) setSystemPrompt(systemText);
				else loadPiTemplate();
			})
			.catch(() => {
				if (!cancelled) loadPiTemplate();
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, modelTraces]);

	const messages = useMemo(() => {
		if (!cachedEntry) return [];
		if (cachedEntry.source === "runtime" && cachedEntry.history) {
			return [...cachedEntry.history.messages, ...cachedEntry.messages];
		}
		return cachedEntry.messages;
	}, [cachedEntry]);

	useEffect(() => {
		if (!sessionId) {
			setModelTraces([]);
			return;
		}
		const sequence = ++traceSequenceRef.current;
		const live = isLiveRuntimeStatus(runtime?.status);
		const options = live && runtimeAgentId ? { target: { sessionId, agentId: runtimeAgentId, runtimeGeneration: runtime?.runtimeGeneration ?? 0 }, days: 30, limit: 10000 } : { days: 30, limit: 10000 };
		void desktopApi.rpcLogs
			.get(options)
			.then((entries) => {
				if (traceSequenceRef.current !== sequence) return;
				const summaries: TrajectoryModelTraceSummary[] = [];
				for (const entry of entries) {
					if (entry.direction !== "model" || !isModelTraceLogData(entry.data) || entry.data.kind !== "request") continue;
					if (!lastKnownAgentId || entry.agentId !== lastKnownAgentId) continue;
					summaries.push({
						traceId: entry.data.traceId,
						agentId: entry.agentId,
						time: entry.time,
						model: entry.data.model,
						provider: entry.data.provider,
						messageCount: entry.data.messageCount,
						toolCount: entry.data.toolCount,
						payloadBytes: entry.data.payloadBytes,
						truncated: entry.data.truncated,
					});
				}
				summaries.sort((left, right) => left.time - right.time);
				setModelTraces(summaries);
			})
			.catch(() => {
				if (traceSequenceRef.current === sequence) setModelTraces([]);
			});
	}, [sessionId, runtime?.status, runtimeAgentId, runtime?.runtimeGeneration, lastKnownAgentId, messages.length]);

	const diskPage = cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	const runtimeHistory = cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	// slideOut 重建前缀时 nextBefore 可能为 null；nextBeforeEntryId 仍是有效续页锚点。
	const hasMore = diskPage ? diskPage.nextBefore !== null : Boolean(cachedEntry?.source === "runtime" && (runtimeHistory ? runtimeHistory.nextBefore !== null || Boolean(runtimeHistory.nextBeforeEntryId) : (cachedEntry.windowStart ?? 0) > 0));

	const loadMore = useCallback(() => {
		if (!sessionId || !cachedEntry || isLoadingMore) return;
		const sequence = ++loadSequenceRef.current;
		const expectedRevision = cachedEntry.revision;

		if (diskPage) {
			const before = diskPage.nextBefore;
			if (before === null) return;
			setIsLoadingMore(true);
			void desktopApi.sessions
				.readRecordMessagePage(sessionId, before, 100)
				.then((page) => {
					if (loadSequenceRef.current !== sequence) return;
					// 「暂时读不了」的空页（历史不可用）：不能当前缀写进缓存，否则 total 归零、
					// 游标被清空，「加载更多」消失且无法重试。保持现状即可。
					if (sessionHistoryUnavailableState(page)) return;
					prependMessagePage({ sessionId, before, expectedRevision, page });
				})
				.finally(() => {
					if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
				});
			return;
		}

		if (cachedEntry.source !== "runtime") return;
		const before = runtimeHistory?.nextBefore;
		const anchorMessage = !runtimeHistory ? cachedEntry.messages.find((message) => typeof message.meta?.entryId === "string") : undefined;
		const anchorEntryId = typeof anchorMessage?.meta?.entryId === "string" ? anchorMessage.meta.entryId : undefined;
		const anchorFilePos = !runtimeHistory && !anchorEntryId ? (typeof cachedEntry.windowStartFilePos === "number" ? cachedEntry.windowStartFilePos : undefined) : undefined;
		if (!runtimeHistory && !anchorEntryId && anchorFilePos === undefined) return;

		setIsLoadingMore(true);
		void desktopApi.sessions
			.readRecordMessagePage(sessionId, before ?? (anchorFilePos !== undefined ? anchorFilePos : undefined), RUNTIME_HISTORY_TURN_PAGE_SIZE, {
				beforeEntryId: anchorEntryId ?? runtimeHistory?.nextBeforeEntryId ?? undefined,
			})
			.then((page) => {
				if (loadSequenceRef.current !== sequence) return;
				// 与 disk 翻页同源：不可用的空页不是新历史（否则同样的游标/total 损坏）。
				if (sessionHistoryUnavailableState(page)) return;
				prependHistoryPage({ sessionId, expectedRevision, before, page });
			})
			.finally(() => {
				if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
			});
	}, [cachedEntry, diskPage, isLoadingMore, prependHistoryPage, prependMessagePage, runtimeHistory, sessionId]);

	return {
		messages,
		processEvents,
		systemPrompt,
		modelTraces,
		hasMoreMessages: hasMore,
		isLoadingMoreMessages: hasMore ? isLoadingMore : false,
		loadMore,
	};
}
