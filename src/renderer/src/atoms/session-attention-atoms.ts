/**
 * 会话状态摘要的渲染层单点：启动拉取 + 订阅推送 + 已读确认。
 *
 * 数据由主进程统一派生（运行/待回答/最近结果/未读），渲染层不在本地重复推断；
 * 组件按 sessionId 从 atom 取摘要，未订阅的会话只保留最近一次推送。
 */
import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import { useEffect } from "react";
import type { SessionAttentionSummary } from "../../../shared/types/sessionAttention";
import { desktopApi } from "../desktopApi";

export const sessionAttentionByIdAtom = atom<Record<string, SessionAttentionSummary>>({});

/** 点击「未读结果」入口时的定位请求：打开会话后滚到最新结果（只在可见后确认已读）。 */
export const sessionScrollToLatestRequestAtom = atom<{ sessionId: string; at: number } | null>(null);

export const sessionAttentionForSessionAtomFamily = atomFamily((sessionId: string) => selectAtom(sessionAttentionByIdAtom, (byId) => byId[sessionId], Object.is));

/** 应用级单点挂载：拉取全量摘要并订阅增量推送（App.tsx 调用一次）。 */
export function useSessionAttentionSync(): void {
	const setAttention = useSetAtom(sessionAttentionByIdAtom);
	useEffect(() => {
		let mounted = true;
		void desktopApi.sessions
			.attentionList()
			.then((items) => {
				if (!mounted) return;
				setAttention(Object.fromEntries(items.map((item) => [item.sessionId, item])));
			})
			.catch(() => undefined);
		const unsubscribe = desktopApi.sessions.onAttentionChanged((summary) => {
			setAttention((current) => ({ ...current, [summary.sessionId]: summary }));
		});
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [setAttention]);
}

export function useSessionAttention(sessionId: string | undefined): SessionAttentionSummary | undefined {
	return useAtomValue(sessionAttentionForSessionAtomFamily(sessionId ?? ""));
}

/** 结果在可见区域出现后确认已读；只提交当前结果身份。 */
export function useMarkSessionAttentionRead(): (sessionId: string, completionId: string) => void {
	const setAttention = useSetAtom(sessionAttentionByIdAtom);
	return (sessionId, completionId) => {
		void desktopApi.sessions
			.markAttentionRead({ sessionId, completionId })
			.then((summary) => {
				if (summary) setAttention((current) => ({ ...current, [summary.sessionId]: summary }));
			})
			.catch(() => undefined);
	};
}
