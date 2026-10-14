/**
 * 选区快照与引文核验规则（纯函数）——P04 的稳定入口，本节点不发 Pi 请求。
 *
 * 任务边界：P03 只给「选区身份 + 快照」一个稳定、可复现的构造入口，Pi 问答、会话绑定、
 * 工具注入全部留给 P04。因此这里只做三件事：
 *
 * 1. 把「当前版本 + 章节 + 选中文本」组装成 `ReadingSelectionSnapshot`；
 * 2. 偏移只在核验通过（exact/normalized 且服务端给了 start/end）时才填，其余留 null——
 *    没有核验的偏移只是猜测，不写进快照（任务规则：偏移只有经核验时才填）；
 * 3. 核验状态映射成人话，用户在提交前就能看见「是否对得上原文」。
 */
import type { ReadingQuoteResult, ReadingSelectionSnapshot } from "../../../shared/types/reading";
import type { TranslationKey } from "../i18n";
import type { ReadingSelectionState } from "../atoms/reading-atoms";

/** 快照接回当前核验回执；旧核验已被替换或清空时，不允许迟到快照覆盖新的选区。 */
export function applyReadingSelectionSnapshot(previous: ReadingSelectionState, snapshot: ReadingSelectionSnapshot, quote: ReadingQuoteResult): ReadingSelectionState {
	if (previous.quote !== quote || !quote.ok || quote.identity.workId !== snapshot.workId || quote.identity.editionId !== snapshot.editionId || quote.identity.contentVersion !== snapshot.contentVersion) return previous;
	return { ...previous, snapshot, verifying: false, error: null };
}

/** 服务端核验状态（server.py：exact / normalized / ambiguous / unmatched）。 */
export function readingQuoteStatusKey(status: string): TranslationKey {
	switch (status) {
		case "exact":
			return "reading.quoteExact";
		case "normalized":
			return "reading.quoteNormalized";
		case "ambiguous":
			return "reading.quoteAmbiguous";
		case "unmatched":
			return "reading.quoteUnmatched";
		default:
			return "reading.quoteUnknown";
	}
}

export function readingQuoteVerified(result: ReadingQuoteResult | null): boolean {
	return result !== null && result.ok && (result.status === "exact" || result.status === "normalized");
}

export type ReadingVerifiedOffsets = { start: number | null; end: number | null };

/**
 * 通过核验的候选里若给出 code point 偏移就原样带上；没有就是 null。
 * 不挑第一个候选拼一对偏移（start/end 必须来自同一次核验的同一候选）。
 */
export function readingQuoteOffsets(result: ReadingQuoteResult | null): ReadingVerifiedOffsets {
	if (!readingQuoteVerified(result) || result === null || !result.ok) return { start: null, end: null };
	const candidate = result.candidates.find((entry) => typeof entry.start === "number" && typeof entry.end === "number" && entry.end >= entry.start);
	if (!candidate || typeof candidate.start !== "number" || typeof candidate.end !== "number") return { start: null, end: null };
	return { start: candidate.start, end: candidate.end };
}

/**
 * 组装选区快照。`capturedAt` 由调用方给（默认取当前时间），保证测试可以固定时间。
 * 身份三件套缺一不可：没有 contentVersion 的快照无法在 P04 复现同一版正文。
 */
export function createReadingSelectionSnapshot(input: { workId: string; editionId: string; contentVersion: string; chapterHref: string; chapterNum: number | null; text: string; quote?: ReadingQuoteResult | null; capturedAt?: string }): ReadingSelectionSnapshot {
	const offsets = readingQuoteOffsets(input.quote ?? null);
	return {
		workId: input.workId,
		editionId: input.editionId,
		contentVersion: input.contentVersion,
		chapterHref: input.chapterHref,
		chapterNum: input.chapterNum,
		text: input.text,
		start: offsets.start,
		end: offsets.end,
		capturedAt: input.capturedAt ?? new Date().toISOString(),
	};
}

/** 选区是否够格做一次核验请求（空/纯空白不发起，避免无意义请求）。 */
export function readingSelectionVerifiable(text: string): boolean {
	return text.trim().length > 0;
}

// ── 核验票据：同一个票据决定「这次核验属于哪本书、哪一章、第几次选择」 ─────────
//
// 为什么不能只比 bookKey：A→B→A 会回到同一个 bookKey，旧请求会被误判成当前请求；
// 同一本书里连续选两段也会互相覆盖。票据按**值**比较（work/edition/contentVersion/epoch/
// chapterSeq/href/selectionSeq），不做对象相等判断。

export type ReadingVerificationTicket = {
	bookKey: string;
	workId: string;
	editionId: string;
	contentVersion: string;
	/** 选中版本轮次（切书推进） */
	epoch: number;
	/** 正文轮次（打开/关闭章节推进） */
	chapterSeq: number;
	/** 发起核验时正在看的章节（toc href 形态）；null = 没有具体章节 */
	chapterHref: string | null;
	/** 选区轮次：每次发起核验、清选区、切书都推进——同书连续选择只允许最新 */
	selectionSeq: number;
};

/** 票据是否已作废：active 为 null（没有当前书/版本）一律算作废；其余字段逐个按值比较。 */
export function isReadingVerificationStale(ticket: ReadingVerificationTicket, active: ReadingVerificationTicket | null): boolean {
	if (active === null) return true;
	return (
		ticket.bookKey !== active.bookKey ||
		ticket.workId !== active.workId ||
		ticket.editionId !== active.editionId ||
		ticket.contentVersion !== active.contentVersion ||
		ticket.epoch !== active.epoch ||
		ticket.chapterSeq !== active.chapterSeq ||
		ticket.chapterHref !== active.chapterHref ||
		ticket.selectionSeq !== active.selectionSeq
	);
}
