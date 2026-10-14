/**
 * 旧阅读历史域 hook（唯一 owner）：两个 source 的来源能力 + 各自分页 + 只读回看。
 *
 * 规则来源（desktop-reading-contract §历史）：
 * - 两个 source 各自分页、各自独立：列表 atom 按 source 分族，绝不把同 id 的会话跨来源合并；
 * - `unattributed` 只标注、不猜归属；坏文件保留在列表里并原样显示原因；
 * - `unsupported`（接口未部署）是明确状态，不拿示例数据顶替；
 * - 原文只在「读了这一条」时按需拉取（不预取整页），页内明确 more / truncated；
 * - 首屏读取替换列表快照，续读才合并——重新读第一页时不该留着已经不在服务端的旧条目。
 *
 * 历史不可用不阻挡阅读正文：本 hook 的错误只影响历史面板自己。
 */
import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReadingErrorInfo, ReadingHistorySessionResult, ReadingHistorySource, ReadingHistorySourceName } from "../../../shared/types/reading";
import { readingHistoryAtomFamily, readingHistoryReadAtom, readingHistorySourcesAtom, type ReadingHistoryReadState, type ReadingHistorySourcesState, type ReadingHistoryState } from "../atoms/reading-atoms";
import type { ReadingClient } from "./useReadingCore";
import { callReading } from "../utils/readingCall";
import { mergeReadingHistoryPage, readingHistorySessionKey } from "../utils/readingHistory";

/** 每页条数：契约允许 1..100，默认 30；界面固定用 30，不暴露无意义的数字选项。 */
export const READING_HISTORY_PAGE_SIZE = 30;

/** 连接变化/断开时的空状态（与 atom 初值同形）。 */
const EMPTY_SOURCES_STATE: ReadingHistorySourcesState = { sources: [], loading: false, error: null, unsupported: false };
const EMPTY_HISTORY_STATE: ReadingHistoryState = { sessions: [], nextCursor: null, loading: false, loadingMore: false, unsupported: false, error: null };
const EMPTY_READ_STATE: ReadingHistoryReadState = { key: null, result: null, loading: false };

export type ReadingHistoryController = {
	clientAvailable: boolean;
	sources: ReadingHistorySource[];
	sourcesLoading: boolean;
	sourcesError: ReadingErrorInfo | null;
	unsupported: boolean;
	stateFor: (source: ReadingHistorySourceName) => ReadingHistoryState;
	reloadSources: () => Promise<void>;
	loadSource: (source: ReadingHistorySourceName) => Promise<void>;
	loadMore: (source: ReadingHistorySourceName) => Promise<void>;
	readSession: (source: ReadingHistorySourceName, id: string) => Promise<void>;
	clearRead: () => void;
	readState: import("../atoms/reading-atoms").ReadingHistoryReadState;
};

export function useReadingHistory(input: { client: ReadingClient | null /** 连接身份（ready 时传 baseUrl；null=未启用）：变化即作废在飞票据并清空旧地址状态。 */; connectionKey?: string | null }): ReadingHistoryController {
	const { client } = input;
	const connectionKey = input.connectionKey ?? null;
	const sourcesState = useAtomValue(readingHistorySourcesAtom);
	const setSourcesState = useSetAtom(readingHistorySourcesAtom);
	const readState = useAtomValue(readingHistoryReadAtom);
	const setReadState = useSetAtom(readingHistoryReadAtom);

	const currentState = useAtomValue(readingHistoryAtomFamily("deepread-current"));
	const legacyState = useAtomValue(readingHistoryAtomFamily("deepread-legacy"));
	const setCurrentState = useSetAtom(readingHistoryAtomFamily("deepread-current"));
	const setLegacyState = useSetAtom(readingHistoryAtomFamily("deepread-legacy"));

	const sourceSeqRef = useRef<Record<ReadingHistorySourceName, number>>({ "deepread-current": 0, "deepread-legacy": 0 });
	const sourcesSeqRef = useRef(0);
	const readSeqRef = useRef(0);
	/** 上一次生效的连接身份（undefined=尚未运行）；用于区分「首次挂载」与「换地址/断开」。 */
	const lastKeyRef = useRef<string | null | undefined>(undefined);

	const stateOf = useCallback((source: ReadingHistorySourceName): ReadingHistoryState => (source === "deepread-current" ? currentState : legacyState), [currentState, legacyState]);
	const setterOf = useCallback((source: ReadingHistorySourceName) => (source === "deepread-current" ? setCurrentState : setLegacyState), [setCurrentState, setLegacyState]);

	/** 来源能力：页面打开时读一次（不轮询）。带轮次守卫：切地址/断开后旧响应不回写。 */
	const reloadSources = useCallback(async (): Promise<void> => {
		if (!client) return;
		const seq = sourcesSeqRef.current + 1;
		sourcesSeqRef.current = seq;
		setSourcesState((previous) => ({ ...previous, loading: true, error: null }));
		const result = await callReading(() => client.historySources());
		if (sourcesSeqRef.current !== seq) return;
		if (result.ok) {
			setSourcesState({ sources: result.sources, loading: false, error: null, unsupported: false });
			return;
		}
		setSourcesState({ sources: [], loading: false, error: result.error, unsupported: result.error.code === "unsupported" });
	}, [client, setSourcesState]);

	useEffect(() => {
		// 连接身份快照：未启用=null，启用后按 baseUrl 区分（缺省给内部占位，不把 null 当同一连接）
		const activeKey = client ? (connectionKey ?? "__connected__") : null;
		const changed = lastKeyRef.current !== undefined && lastKeyRef.current !== activeKey;
		lastKeyRef.current = activeKey;
		if (changed) {
			// 换地址/断开：在飞票据全部作废，并把旧连接下的来源/列表/原话清空，不让旧结果回填
			sourcesSeqRef.current += 1;
			sourceSeqRef.current["deepread-current"] += 1;
			sourceSeqRef.current["deepread-legacy"] += 1;
			readSeqRef.current += 1;
			setSourcesState(EMPTY_SOURCES_STATE);
			setCurrentState(EMPTY_HISTORY_STATE);
			setLegacyState(EMPTY_HISTORY_STATE);
			setReadState(EMPTY_READ_STATE);
		}
		if (client) void reloadSources();
		return () => {
			// 卸载 / 重跑（关页、换连接）：推进全部票据 seq，旧挂载的迟到响应不得写共享 Jotai
			sourcesSeqRef.current += 1;
			sourceSeqRef.current["deepread-current"] += 1;
			sourceSeqRef.current["deepread-legacy"] += 1;
			readSeqRef.current += 1;
		};
	}, [client, connectionKey, reloadSources, setCurrentState, setLegacyState, setReadState, setSourcesState]);

	/** 读取来源的第一页（替换快照）。 */
	const loadSource = useCallback(
		async (source: ReadingHistorySourceName): Promise<void> => {
			if (!client) return;
			const setState = setterOf(source);
			const seq = sourceSeqRef.current[source] + 1;
			sourceSeqRef.current[source] = seq;
			setState((previous) => ({ ...previous, loading: true, loadingMore: false, error: null }));
			const result = await callReading(() => client.listHistory({ source, limit: READING_HISTORY_PAGE_SIZE }));
			if (sourceSeqRef.current[source] !== seq) return;
			if (!result.ok) {
				const unsupported = result.error.code === "unsupported";
				// 接口未部署时清空列表：旧数据不能继续冒充当前来源的事实
				setState((previous) => ({ ...previous, loading: false, loadingMore: false, unsupported, error: result.error, sessions: unsupported ? [] : previous.sessions, nextCursor: unsupported ? null : previous.nextCursor }));
				return;
			}
			setState({ sessions: result.sessions, nextCursor: result.nextCursor, loading: false, loadingMore: false, unsupported: false, error: null });
		},
		[client, setterOf],
	);

	/** 续读下一页：游标只在成功后前进；合并按完整身份去重。 */
	const loadMore = useCallback(
		async (source: ReadingHistorySourceName): Promise<void> => {
			if (!client) return;
			const state = stateOf(source);
			if (state.nextCursor === null || state.loadingMore) return;
			const setState = setterOf(source);
			const seq = sourceSeqRef.current[source] + 1;
			sourceSeqRef.current[source] = seq;
			setState((previous) => ({ ...previous, loadingMore: true, error: null }));
			const result = await callReading(() => client.listHistory({ source, cursor: state.nextCursor, limit: READING_HISTORY_PAGE_SIZE }));
			if (sourceSeqRef.current[source] !== seq) return;
			if (!result.ok) {
				setState((previous) => ({ ...previous, loadingMore: false, error: result.error }));
				return;
			}
			setState((previous) => ({ ...previous, sessions: mergeReadingHistoryPage(previous.sessions, result.sessions), nextCursor: result.nextCursor, loadingMore: false, error: null }));
		},
		[client, setterOf, stateOf],
	);

	/** 回看一条：原文与摘要都来自本次响应；不预取、不缓存成第二份历史主账。 */
	const readSession = useCallback(
		async (source: ReadingHistorySourceName, id: string): Promise<void> => {
			if (!client) return;
			const key = readingHistorySessionKey({ source, id });
			const seq = readSeqRef.current + 1;
			readSeqRef.current = seq;
			setReadState({ key, result: null, loading: true });
			const result: ReadingHistorySessionResult = await callReading(() => client.readHistorySession(source, id));
			if (readSeqRef.current !== seq) return;
			setReadState({ key, result, loading: false });
		},
		[client, setReadState],
	);

	const clearRead = useCallback(() => setReadState({ key: null, result: null, loading: false }), [setReadState]);

	return {
		clientAvailable: client !== null,
		sources: sourcesState.sources,
		sourcesLoading: sourcesState.loading,
		sourcesError: sourcesState.error,
		unsupported: sourcesState.unsupported,
		stateFor: stateOf,
		reloadSources,
		loadSource,
		loadMore,
		readSession,
		clearRead,
		readState,
	};
}
