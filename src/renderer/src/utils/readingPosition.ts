/**
 * 阅读位置的恢复与保存规则（纯函数）。
 *
 * 契约（desktop-reading-contract「位置」）：
 * - 位置按「具体版本 + contentVersion」保存；版本不符 → `stale`，明确陈旧并回章首，不猜偏移；
 * - 同值幂等由主进程负责，界面负责不制造噪音写入；
 * - 需要 DOM 恢复时必须在正文加载完成后执行：零高度或 loading 期间禁止覆盖已有位置
 *   （任务规则：禁止在零高度或 loading 时覆盖已有位置）。
 *
 * 「偏移只有经核验时才填」在本层对应两个字段：`fraction` 只来自真实滚动视口；
 * `chapterTextDigest` 只透传服务端声明的章节摘要，绝不按正文文本现算（现算的摘要是第二份事实）。
 */
import { READING_POSITION_FRACTION_MAX, READING_POSITION_FRACTION_MIN, type ReadingErrorInfo, type ReadingPosition, type ReadingPositionGetResult, type ReadingPositionSaveInput, type ReadingPositionSaveResult, type ReadingPositionScope, type ReadingPositionStaleReason } from "../../../shared/types/reading";
import { readingBookKey } from "./readingScope";

/** 滚动位置的最小保存增量：小于它视为抖动，不写（主进程幂等，界面不刷写）。 */
export const READING_POSITION_MIN_DELTA = 0.01;

export type ReadingPositionPlan =
	| { kind: "none" }
	/** 有位置但不可用（版本/章节已变）：明确陈旧，正文回到章首，不恢复滚动。 */
	| { kind: "stale"; reason: Exclude<ReadingPositionStaleReason, "none"> }
	| { kind: "restore"; chapterHref: string; chapterNum: number | null; fraction: number; chapterTextDigest: string | null };

/** 0..1 之间的有限数；非法输入归 0（契约 fraction 越界会被主进程拒绝，界面先归一）。 */
export function clampReadingFraction(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return READING_POSITION_FRACTION_MIN;
	return Math.min(READING_POSITION_FRACTION_MAX, Math.max(READING_POSITION_FRACTION_MIN, value));
}

/** 实际滚动进度：不可滚动（内容不高于视口/零高度）时返回 0，不制造假进度。 */
export function readingScrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0;
	const span = scrollHeight - clientHeight;
	if (span <= 0) return 0;
	return clampReadingFraction(scrollTop / span);
}

/**
 * 给定「位置读取结果 + 当前版本 + 目录」得出恢复计划。
 *
 * - 无位置（position null）→ `none`：从章首开始，不提示（属于首次阅读）。
 * - 版本不符（服务端 stale 或 position.contentVersion 不一致）→ `stale`：回章首并提示。
 * - 保存的章节 href 已不在当前目录里 → `stale`：不猜偏移（`missing`）。
 * - 其余 → `restore`：章节 href 用 toc 里的形态（不用 content 端点归一化后的形态，
 *   见 P03 跨端复核 F4：两种 href 不同形会让核验恒失败）。
 */
export function planReadingPositionRestore(input: { result: ReadingPositionGetResult | null; contentVersion: string; tocHrefs: readonly string[] }): ReadingPositionPlan {
	const { result, contentVersion, tocHrefs } = input;
	if (result === null || !result.ok) return { kind: "none" };
	const position = result.position;
	if (position === null) return { kind: "none" };
	if (result.stale || result.reason === "versionMismatch" || position.contentVersion !== contentVersion) return { kind: "stale", reason: "versionMismatch" };
	const href = (position.spineHref ?? "").trim();
	if (href.length === 0) return { kind: "none" };
	const matched = tocHrefs.find((candidate) => candidate.trim() === href);
	if (!matched) return { kind: "stale", reason: "missing" };
	return { kind: "restore", chapterHref: matched, chapterNum: position.chapterNum, fraction: clampReadingFraction(position.fraction), chapterTextDigest: position.chapterTextDigest };
}

/**
 * 是否允许把当前视口写回位置。
 *
 * 三个「禁止」：正文没加载完成、容器零高度、内容不可滚动时不写——否则会用 0 覆盖掉
 * 已有位置（任务规则：禁止零高度或 loading 时覆盖已有位置）。
 */
export function shouldPersistReadingPosition(input: { chapterLoaded: boolean; chapterHref: string | null; viewportHeight: number; scrollHeight: number; fraction: number; lastSavedFraction: number | null }): boolean {
	if (!input.chapterLoaded) return false;
	if (input.chapterHref === null || input.chapterHref.trim().length === 0) return false;
	if (!(input.viewportHeight > 0)) return false;
	if (!(input.scrollHeight > input.viewportHeight)) return false;
	if (input.lastSavedFraction !== null && Math.abs(clampReadingFraction(input.fraction) - input.lastSavedFraction) < READING_POSITION_MIN_DELTA) return false;
	return true;
}

/**
 * 组装保存入参：身份全部来自「发起时的票据」（work/edition/version/href），
 * 不从当前选中状态现取——切书后迟到的滚动回调不得把上一本的位置写进新书。
 */
export function buildReadingPositionSaveInput(input: { workId: string; editionId: string; contentVersion: string; chapterHref: string; chapterNum: number | null; chapterTextDigest: string | null; fraction: number }): ReadingPositionSaveInput {
	return {
		workId: input.workId,
		editionId: input.editionId,
		contentVersion: input.contentVersion,
		fraction: clampReadingFraction(input.fraction),
		spineHref: input.chapterHref.trim().length > 0 ? input.chapterHref.trim() : null,
		chapterNum: input.chapterNum !== null && input.chapterNum >= 0 ? input.chapterNum : null,
		// 只透传服务端声明的章节摘要；没有就是 null（自算摘要 = 第二份事实，禁止）
		chapterTextDigest: input.chapterTextDigest !== null && input.chapterTextDigest.length > 0 ? input.chapterTextDigest : null,
	};
}

// ── 保存票据与回执核对 ────────────────────────────────────────────────────────
//
// 为什么要有「票据」：写回是异步的（IPC），而用户随时可能切章、切版本、切书。
// 把「发起时看到的身份 + 章节 + 摘要」固定成一张不可变票据，写回与结算都只认这张票据，
// 就不会出现「拿 A 章量到的滚动比例、配 B 版身份」这种张冠李戴的写入；
// 回执（ACK）也只能拿票据来核对，而不是拿回执自己跟自己比。

export type ReadingSaveTicket = {
	workId: string;
	editionId: string;
	contentVersion: string;
	chapterHref: string;
	chapterNum: number | null;
	chapterTextDigest: string | null;
	/** 书身份 key（atom 分族与幂等标记共用） */
	bookKey: string;
};

/** 身份或章节不全时没有票据（版本未读到、正文未加载、href 为空都不允许写）。 */
export function readingSaveTicket(input: { workId: string | null; editionId: string | null; contentVersion: string | null; chapterHref: string | null; chapterNum: number | null; chapterTextDigest: string | null }): ReadingSaveTicket | null {
	const href = (input.chapterHref ?? "").trim();
	if (input.workId === null || input.editionId === null || input.contentVersion === null) return null;
	if (href.length === 0) return null;
	return {
		workId: input.workId,
		editionId: input.editionId,
		contentVersion: input.contentVersion,
		chapterHref: href,
		chapterNum: input.chapterNum !== null && input.chapterNum >= 0 ? input.chapterNum : null,
		chapterTextDigest: input.chapterTextDigest !== null && input.chapterTextDigest.length > 0 ? input.chapterTextDigest : null,
		bookKey: readingBookKey({ workId: input.workId, editionId: input.editionId }),
	};
}

/** 写回守卫 key：书 + 版本 + 章节。用来隔离「已保存比例」，换书/换章不吃上一份的比例。 */
export function readingSaveGuardKey(ticket: ReadingSaveTicket): string {
	return `${ticket.bookKey}\u0001${ticket.contentVersion}\u0001${ticket.chapterHref}`;
}

/** 恢复幂等 key：书 + 版本 + 章节 + 比例。换书/换版本/换章各自独立，相同票据+比例稳定。 */
export function readingRestoreKey(ticket: ReadingSaveTicket, fraction: number): string {
	return `${readingSaveGuardKey(ticket)}\u0001${clampReadingFraction(fraction)}`;
}

/**
 * 回执是否属于这张票据：HTTP 层的 scope 与服务端确认的位置都必须指向同一 work/edition/contentVersion。
 * 只比对发起票据，不比对回执自身（自比较等于没校验）。
 */
export function isReadingSaveResultForTicket(result: ReadingPositionSaveResult | { ok: false; error: ReadingErrorInfo }, ticket: ReadingSaveTicket): result is Extract<ReadingPositionSaveResult, { ok: true }> {
	if (!result.ok) return false;
	const { scope, position } = result;
	if (scope.workId !== ticket.workId || scope.editionId !== ticket.editionId || scope.contentVersion !== ticket.contentVersion) return false;
	return position.workId === ticket.workId && position.editionId === ticket.editionId && position.contentVersion === ticket.contentVersion;
}

/** 票据是否仍是当前视图（书身份与章节都没变）：迟到的 ACK 不落当前书。 */
export function isReadingSaveTicketCurrent(ticket: ReadingSaveTicket, current: ReadingSaveTicket | null): boolean {
	if (current === null) return false;
	return current.bookKey === ticket.bookKey && current.chapterHref.trim() === ticket.chapterHref.trim();
}
