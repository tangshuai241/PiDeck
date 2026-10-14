/**
 * 阅读页的渲染层状态（唯一 owner：各域的 `useReading*` hook）。
 *
 * 分族与归属（任务规则：多实例按身份订阅、域 hook 唯一 owner）：
 * - 「当前是哪本书/哪个版本」是页面会话内的选择，`readingSelectedBookAtom` 单点保存；
 * - 版本、正文、位置、笔记、历史都按「书身份 / source」分族，切书后旧族的迟到响应写不回新书；
 * - 未发送的笔记输入按「书身份 + 笔记」分 key（`readingNoteInputKey`），切页来回不丢，
 *   但也不会串到别的书或别的笔记上；
 * - atom 是本次会话视图状态：位置与草稿由主进程持久化，上次选中版本由 core 按服务地址保存轻量身份缓存。
 *   刻意不引入第二套状态方案，也不把凭据放进来（密码只在主进程安全存储）。
 */
import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ReadingChapter, ReadingEditionView, ReadingErrorInfo, ReadingHistorySession, ReadingHistorySessionResult, ReadingHistorySource, ReadingHistorySourceName, ReadingNoteDraft, ReadingNoteSummary, ReadingQuoteResult, ReadingSelectionSnapshot, ReadingServiceStatus } from "../../../shared/types/reading";
import type { ReadingPositionPlan } from "../utils/readingPosition";
import { emptyReadingNoteInput, type ReadingNoteInput, type ReadingNoteSaveState } from "../utils/readingNotes";

/** 未发送输入的类型定义在 utils/readingNotes（域规则与 atom 分族共用同一份），此处透出以免调用方多引一层。 */
export type { ReadingNoteInput };

/** 服务与连接状态：`status` 只在页面打开后写入；`error` 是本次读取失败的原因。 */
export type ReadingStatusState = { status: ReadingServiceStatus | null; error: ReadingErrorInfo | null; loading: boolean };
export const readingStatusAtom = atom<ReadingStatusState>({ status: null, error: null, loading: false });

/** 书库快照（作品 + 每个作品下的各版本，版本互不合并）。 */
export type ReadingLibraryState = { works: import("../../../shared/types/reading").ReadingWork[]; fetchedAt: string | null; loading: boolean; error: ReadingErrorInfo | null };
export const readingLibraryAtom = atom<ReadingLibraryState>({ works: [], fetchedAt: null, loading: false, error: null });

/** 当前选中的版本；null = 还没选（页面显示书库提示）。 */
export type ReadingSelectedBook = { workId: string; editionId: string };
export const readingSelectedBookAtom = atom<ReadingSelectedBook | null>(null);

/** 版本视图（identity/toc/spine/analysis），按书身份分族。 */
export type ReadingEditionState = { edition: ReadingEditionView | null; loading: boolean; error: ReadingErrorInfo | null };
export const readingEditionAtomFamily = atomFamily((_bookKey: string) => atom<ReadingEditionState>({ edition: null, loading: false, error: null }));

/**
 * 当前正文。`requestHref` 是「我们请求时用的 toc href」——它和正文回传的 href 可能不同形
 * （P03 跨端复核 F4），恢复位置与引文核验都必须用 toc 形态，所以两者分开存。
 */
export type ReadingChapterState = { chapter: ReadingChapter | null; requestHref: string | null; loading: boolean; error: ReadingErrorInfo | null };
export const readingChapterAtomFamily = atomFamily((_bookKey: string) => atom<ReadingChapterState>({ chapter: null, requestHref: null, loading: false, error: null }));

/** 位置状态：恢复计划 + 保存回执；`lastSavedFraction` 用于抑制抖动写入。 */
export type ReadingPositionState = { plan: ReadingPositionPlan; loading: boolean; error: ReadingErrorInfo | null; saving: boolean; lastSavedFraction: number | null; savedAt: string | null };
export const readingPositionAtomFamily = atomFamily((_bookKey: string) => atom<ReadingPositionState>({ plan: { kind: "none" }, loading: false, error: null, saving: false, lastSavedFraction: null, savedAt: null }));

/** 笔记域状态：分类列表 + 未确认草稿 + 当前读取的笔记全文。 */
export type ReadingNotesState = {
	notes: ReadingNoteSummary[];
	unattributed: ReadingNoteSummary[];
	/** 未确认草稿（同书同版本）；`draftIssue` 非空表示草稿文件损坏已隔离，不得静默清稿。 */
	drafts: ReadingNoteDraft[];
	draftIssue: ReadingErrorInfo | null;
	/** 当前打开的笔记全文；`truncated` 时只能看不作覆盖底稿。 */
	open: { note: ReadingNoteSummary; content: string; truncated: boolean } | null;
	loading: boolean;
	error: ReadingErrorInfo | null;
};
export const readingNotesAtomFamily = atomFamily((_bookKey: string) => atom<ReadingNotesState>({ notes: [], unattributed: [], drafts: [], draftIssue: null, open: null, loading: false, error: null }));

/**
 * 当前编辑目标（书内）：null = 新建；否则是该笔记的 noteId。
 * 与输入 atom 的 keying 配合，实现「未发送输入按书/笔记作用域保存」：切目标不丢各自的输入。
 */
export const readingNoteEditTargetAtomFamily = atomFamily((_bookKey: string) => atom<string | null>(null));

/** 未发送的笔记输入（按书 + 笔记作用域）；切页来回不丢，切书不串。 */
export const readingNoteInputAtomFamily = atomFamily((_key: string) => atom<ReadingNoteInput>(emptyReadingNoteInput()));

/** 提交状态：在飞 + 最近一次回执判定（saved/pending/unknown/failed）。 */
export type ReadingNoteSubmitState = { pending: boolean; lastState: ReadingNoteSaveState | null; requestId: string | null; error: ReadingErrorInfo | null };
export const readingNoteSubmitAtomFamily = atomFamily((_bookKey: string) => atom<ReadingNoteSubmitState>({ pending: false, lastState: null, requestId: null, error: null }));

/** 旧历史来源列表（两棵树的能力与条数）。 */
export type ReadingHistorySourcesState = { sources: ReadingHistorySource[]; loading: boolean; error: ReadingErrorInfo | null; unsupported: boolean };
export const readingHistorySourcesAtom = atom<ReadingHistorySourcesState>({ sources: [], loading: false, error: null, unsupported: false });

/** 单个 source 的分页列表；两源各自独立，不互相合并。 */
export type ReadingHistoryState = { sessions: ReadingHistorySession[]; nextCursor: string | null; loading: boolean; loadingMore: boolean; unsupported: boolean; error: ReadingErrorInfo | null };
export const readingHistoryAtomFamily = atomFamily((_source: ReadingHistorySourceName) => atom<ReadingHistoryState>({ sessions: [], nextCursor: null, loading: false, loadingMore: false, unsupported: false, error: null }));

/** 当前回看的旧会话原文（只读展示，不是 Pi 消息）。 */
export type ReadingHistoryReadState = { key: string | null; result: ReadingHistorySessionResult | null; loading: boolean };
export const readingHistoryReadAtom = atom<ReadingHistoryReadState>({ key: null, result: null, loading: false });

/** 选区快照（P04 稳定入口）：本节点只做核验与展示，不发往任何会话。 */
export type ReadingSelectionState = { snapshot: ReadingSelectionSnapshot | null; quote: ReadingQuoteResult | null; verifying: boolean; error: ReadingErrorInfo | null };
export const readingSelectionAtom = atom<ReadingSelectionState>({ snapshot: null, quote: null, verifying: false, error: null });
