/**
 * 旧阅读历史的分页与呈现规则（纯函数）。
 *
 * 契约（desktop-reading-contract「历史」）：两个 source 各自独立分页、都要能真实回看；
 * `unattributed` 单独标注；坏文件原样报错；同 id 不同 source 不许合并去重；
 * 列表页的「还有更多」只由 `nextCursor` 决定，不用条数猜。
 */
import type { ReadingHistoryListResult, ReadingHistorySession, ReadingHistorySource, ReadingHistorySourceName } from "../../../shared/types/reading";
import type { TranslationKey } from "../i18n";

/** 会话的完整身份：source 参与 key，保证同 id 不同来源各自保留。 */
export function readingHistorySessionKey(session: { source: ReadingHistorySourceName; id: string }): string {
	return JSON.stringify([session.source, session.id]);
}

/**
 * 合并一页到已加载列表：按完整身份去重（保留先到的，维持服务端顺序），
 * 不跨 source 合并——source 不同即不同条目。
 */
export function mergeReadingHistoryPage(previous: readonly ReadingHistorySession[], page: readonly ReadingHistorySession[]): ReadingHistorySession[] {
	const seen = new Set(previous.map((session) => readingHistorySessionKey(session)));
	const merged = [...previous];
	for (const session of page) {
		const key = readingHistorySessionKey(session);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(session);
	}
	return merged;
}

/** 归属角标：只有 `unattributed` 标注；bound 不占位（正常归属不需要提醒）。 */
export function readingHistoryAttributionKey(attribution: ReadingHistorySession["attribution"]): TranslationKey | null {
	return attribution === "unattributed" ? "reading.historyUnattributed" : null;
}

/** 不可读文件：列表里保留并显示原因；原因文本来自服务端，原样展示，不改写不吞掉。 */
export function readingHistoryUnreadable(session: ReadingHistorySession): boolean {
	return session.readable === false;
}

/** 列表状态：unsupported（接口未部署）与 empty（确实没有）必须分开。 */
export type ReadingHistoryListState = "loading" | "unsupported" | "empty" | "rows";

export function resolveReadingHistoryListState(input: { loading: boolean; unsupported: boolean; sessionCount: number }): ReadingHistoryListState {
	if (input.unsupported) return "unsupported";
	if (input.sessionCount > 0) return "rows";
	if (input.loading) return "loading";
	return "empty";
}

/** 「加载更多」是否可用：只看服务端游标（没有游标就不猜还有）。 */
export function readingHistoryHasMore(result: (Pick<ReadingHistoryListResult, "ok"> & { nextCursor?: string | null }) | null): boolean {
	if (result === null || !result.ok) return false;
	return typeof result.nextCursor === "string" && result.nextCursor.length > 0;
}

/** 来源能力说明：readable=false 时说明该来源当前不可读（仍有条数），不阻止阅读正文。 */
export function readingHistorySourceStateKey(source: ReadingHistorySource): TranslationKey | null {
	if (source.readable) return null;
	return source.count > 0 ? "reading.historySourceUnreadable" : "reading.historySourceEmpty";
}

/** 会话摘要里可展示的计数：只取服务端的数字键，界面不加工。 */
export function readingHistoryCountEntries(session: ReadingHistorySession): { key: string; value: number }[] {
	const counts = session.counts;
	if (counts === null) return [];
	return Object.entries(counts)
		.filter(([, value]) => typeof value === "number" && Number.isFinite(value))
		.map(([key, value]) => ({ key, value }));
}

/** 原始 JSON 回看：原文逐字节来自本次响应，界面只做只读展示（不是 Pi 消息，也不改写）。 */
export function readingHistoryRawAvailable(result: { ok: true; raw: string } | { ok: false } | null): boolean {
	return result !== null && result.ok && result.raw.length > 0;
}
