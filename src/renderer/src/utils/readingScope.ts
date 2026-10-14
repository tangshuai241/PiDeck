/**
 * 阅读请求的作用域与迟到守卫（纯函数）。
 *
 * 为什么要有这一层：阅读页会同时存在「书库、目录、正文、位置、笔记」多条在飞请求，
 * 用户随时可能切版本或切书。契约要求「切换书籍/版本后迟到响应不落当前对象」
 * （reading-contract §位置与笔记、plan §7）。判断必须只看身份，不看时间：
 * 每次发起请求记下当时的 `bookKey + contentVersion + epoch`，响应回来时与当前活动票据比对，
 * 不一致就丢弃。不用 sleep/超时猜时序，测试里也能确定性地复现。
 *
 * 身份口径：`workId`/`editionId`/`contentVersion` 三者互不可推导，成对使用（reading-contract §必读语义）。
 * 拼接 key 时用长度前缀，避免服务端 id 里的 `:` 造成两份不同身份拼出同一个 key。
 */
import type { ReadingPositionScope } from "../../../shared/types/reading";

/** 一次阅读会话内的版本身份（work + edition）。 */
export type ReadingBookIdentity = { workId: string; editionId: string };

/**
 * 书身份 key：opaque，仅用于 atom family / Map 键，以及草稿与未发送输入的作用域。
 * 长度前缀让不同 (workId, editionId) 组合不会碰撞（id 允许包含 `:` 与 `.`）。
 */
export function readingBookKey(identity: ReadingBookIdentity): string {
	return `${identity.workId.length}:${identity.workId}:${identity.editionId}`;
}

/** 一份笔记草稿/未发送输入的作用域键：书身份 + 目标笔记（新建时为 null，与更新互不覆盖）。 */
export function readingNoteInputKey(bookKey: string, noteId: string | null): string {
	return noteId === null ? `${bookKey}\u0000new` : `${bookKey}\u0000${noteId}`;
}

/**
 * 在飞请求的票据：登记这条请求属于哪个书身份、哪个内容版本，以及第几轮（epoch）。
 * epoch 由 hook 在「活动书身份变化」时自增，用来让同一身份下的重复请求（例如连点目录）
 * 只有最后一次的响应生效。
 */
export type ReadingRequestTicket = {
	bookKey: string;
	contentVersion: string | null;
	epoch: number;
};

export function readingRequestTicket(input: { bookKey: string; contentVersion: string | null; epoch: number }): ReadingRequestTicket {
	return { bookKey: input.bookKey, contentVersion: input.contentVersion, epoch: input.epoch };
}

/**
 * 响应是否已过期：书身份不同或 epoch 变化都算过期。
 * 注意：`contentVersion` 变化不单独判过期——同一本书同一章在版本内刷新不应丢弃正文；
 * 版本身份的差异由「位置计划」和「保存回执比对」处理（见 readingPosition / readingScope 的保存比对）。
 */
export function isReadingTicketStale(ticket: ReadingRequestTicket, active: ReadingRequestTicket | null): boolean {
	if (active === null) return true;
	return ticket.bookKey !== active.bookKey || ticket.epoch !== active.epoch;
}

/** 保存回执是否属于发起时的那份身份：只写发起对象，不写当前书（契约：迟到/切书按 scope 丢弃）。 */
export function isReadingSaveScopeCurrent(scope: ReadingPositionScope, active: { workId: string; editionId: string; contentVersion: string | null }): boolean {
	if (scope.workId !== active.workId || scope.editionId !== active.editionId) return false;
	if (active.contentVersion === null) return true;
	return scope.contentVersion === active.contentVersion;
}

/** 目录项是否是可选正文（能映射章节）。前置页（frontmatter）不是「合法 chapter」，不进正文链路。 */
export function isReadingChapterSelectable(item: { isChapter: boolean; href: string; mapStatus: "chapter" | "frontmatter" }): boolean {
	return item.isChapter === true && item.href.trim().length > 0;
}

/** 正文请求的章节标识：优先 toc href（核验与位置都用 toc 形态），缺失时退回章号。 */
export function readingChapterRequestTarget(item: { href: string; chapterNum: number | null }): string | number | null {
	const href = item.href.trim();
	if (href.length > 0) return href;
	if (item.chapterNum !== null && item.chapterNum > 0) return item.chapterNum;
	return null;
}
