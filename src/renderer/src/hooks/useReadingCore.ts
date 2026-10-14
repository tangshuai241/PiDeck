/**
 * 阅读页核心域 hook（唯一 owner）：服务状态、连接、书库、选中版本、目录与正文、选区核验。
 *
 * 边界与不变量：
 * - 所有桌面能力只经 `desktopApi.reading`（契约见 execution/P03/desktop-reading-contract.md）；
 *   渲染层不 fetch、不传路径或地址之外的东西，密码只在 connect 那一次穿过 IPC 交给主进程安全存储。
 * - 页面未打开零请求：本 hook 只挂在阅读页组件上；页面关掉即卸载，没有常驻定时器、没有轮询。
 * - 迟到响应按「书身份 + epoch」丢弃：切版本/切书后旧响应写不进新书的状态族
 *   （all atom family 按 bookKey 分族，响应回写前再比对一次身份）。
 * - 票据必须「先登记后请求」：Jotai atom 会跨挂载保留选中版本，重开页面时若票据还是空的，
 *   已经发出的版本响应会被自己的守卫丢掉——所以挂载时就按已有选中版本登记有效票据。
 * - 同一版本已加载就不重复请求（重挂不叠加网络），要刷新由用户显式点刷新。
 * - 每个 IPC 调用都经 `callReading` 兜底：拒绝变成结构化错误，加载态一定收尾。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { ReadingConnectInput, ReadingEditionView, ReadingErrorInfo, ReadingQuoteResult, ReadingServiceStatus, ReadingTocItem, ReadingWork } from "../../../shared/types/reading";
import { readingChapterAtomFamily, readingEditionAtomFamily, readingLibraryAtom, readingSelectedBookAtom, readingSelectionAtom, readingStatusAtom } from "../atoms/reading-atoms";
import { isReadingChapterSelectable, readingBookKey, readingChapterRequestTarget, readingRequestTicket, type ReadingRequestTicket } from "../utils/readingScope";
import { callReading } from "../utils/readingCall";
import { readingConnectionHasPriorSuccess, resolveReadingAvailabilityDecision, type ReadingAvailabilityDecision } from "../utils/readingState";
import { readingSelectionVerifiable, isReadingVerificationStale, type ReadingVerificationTicket } from "../utils/readingSelection";
import { readReadingLastBook, writeReadingLastBook, type ReadingSelectionStorage } from "../utils/readingLastBook";

/** 桌面阅读接口（契约成员）。preload 由主进程 owner 交付，这里只按契约使用。 */
export type ReadingClient = typeof desktopApi.reading;

/** 注入点：生产用 desktopApi.reading，逻辑测试注入契约替身。 */
export type ReadingClientOptions = { client?: ReadingClient | null; selectionStorage?: ReadingSelectionStorage };

const EMPTY_BOOK_KEY = "__none__";

/** 运行期兜底：preload 尚未集成时该成员不存在，页面显示「服务未提供该能力」而不是白屏。 */
function resolveClient(options: ReadingClientOptions): ReadingClient | null {
	if ("client" in options) return options.client ?? null;
	return desktopApi.reading ?? null;
}

/** 阅读接口的单次解析（页面级）：三个域 hook 共用同一个 client，避免各解一遍。 */
export function useReadingClient(options: ReadingClientOptions = {}): ReadingClient | null {
	return useMemo(() => resolveClient(options), [options]);
}

export type ReadingCoreController = {
	/** null = 接口尚未接入（preload 未集成 / 预览态） */
	clientAvailable: boolean;
	status: ReadingServiceStatus | null;
	statusError: ReadingErrorInfo | null;
	statusLoading: boolean;
	decision: ReadingAvailabilityDecision;
	connect: (input: ReadingConnectInput) => Promise<ReadingErrorInfo | null>;
	disconnect: () => Promise<ReadingErrorInfo | null>;
	libraryWorks: ReadingWork[];
	libraryLoading: boolean;
	libraryError: ReadingErrorInfo | null;
	refreshLibrary: () => Promise<void>;
	selected: { workId: string; editionId: string } | null;
	selectBook: (next: { workId: string; editionId: string } | null) => void;
	edition: ReadingEditionView | null;
	editionLoading: boolean;
	editionError: ReadingErrorInfo | null;
	chapter: import("../../../shared/types/reading").ReadingChapter | null;
	chapterHref: string | null;
	chapterNum: number | null;
	chapterLoading: boolean;
	chapterError: ReadingErrorInfo | null;
	tocHrefs: string[];
	openChapter: (item: ReadingTocItem) => Promise<void>;
	closeChapter: () => void;
	selection: import("../atoms/reading-atoms").ReadingSelectionState;
	verifySelection: (text: string) => Promise<ReadingQuoteResult | null>;
	clearSelection: () => void;
};

export function useReadingCore(options: ReadingClientOptions = {}): ReadingCoreController {
	const client = useMemo(() => resolveClient(options), [options]);
	const clientAvailable = client !== null;

	const [statusState, setStatusState] = useAtom(readingStatusAtom);
	const [library, setLibrary] = useAtom(readingLibraryAtom);
	const [selected, setSelected] = useAtom(readingSelectedBookAtom);
	const [selection, setSelection] = useAtom(readingSelectionAtom);

	const bookKey = selected ? readingBookKey(selected) : EMPTY_BOOK_KEY;
	const [editionState, setEditionState] = useAtom(readingEditionAtomFamily(bookKey));
	const [chapterState, setChapterState] = useAtom(readingChapterAtomFamily(bookKey));
	const setSelectionState = useSetAtom(readingSelectionAtom);

	/**
	 * 活动票据：书身份 + 内容版本 + epoch。epoch 只由「选中版本变化」推进，
	 * 用于丢弃切书后仍在飞的版本/正文响应；同一本书内换章由 chapterSeq 单独守。
	 *
	 * 初值来自挂载时 atom 里已有的选中版本：atom 跨挂载保留，若票据留空，
	 * 重开页面发出的版本响应就永远过不了 `isTicketCurrent`，页面会一直停在加载态。
	 */
	const epochRef = useRef(0);
	const initialSelected = useRef(selected).current;
	const activeTicketRef = useRef<ReadingRequestTicket | null>(initialSelected === null ? null : readingRequestTicket({ bookKey: readingBookKey(initialSelected), contentVersion: null, epoch: 0 }));
	const chapterSeqRef = useRef(0);
	/** 选区轮次：每次发起核验、清选区、切书都推进——同书连续选择只允许最新。 */
	const selectionSeqRef = useRef(0);
	/** 当前正文的 toc href（核验票据用它判定「还是同一章」）。 */
	const chapterHrefRef = useRef<string | null>(null);
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const connectionUrlRef = useRef(statusState.status?.connection.baseUrl ?? null);
	connectionUrlRef.current = statusState.status?.connection.baseUrl ?? null;
	const selectionStorage = options.selectionStorage;
	/** 版本号缓存：重挂时若 atom 里已有同一版本，直接沿用（不重复请求）。 */
	const contentVersionRef = useRef<string | null>(editionState.edition?.identity.contentVersion ?? null);
	const editionRef = useRef(editionState);
	editionRef.current = editionState;

	const isTicketCurrent = useCallback((ticket: ReadingRequestTicket) => {
		const active = activeTicketRef.current;
		if (active === null) return false;
		return ticket.bookKey === active.bookKey && ticket.epoch === active.epoch;
	}, []);

	/**
	 * 当前活动的核验票据：全部从活动 ref 现取（不是渲染快照），保证与在飞请求比对时
	 * 用的是「此刻」的书/版本/章/选区轮次。没有选中书或版本未知时返回 null（一律算作废）。
	 */
	const activeVerificationTicket = useCallback((): ReadingVerificationTicket | null => {
		const current = selectedRef.current;
		const version = contentVersionRef.current;
		if (current === null || version === null) return null;
		return { bookKey: readingBookKey(current), workId: current.workId, editionId: current.editionId, contentVersion: version, epoch: epochRef.current, chapterSeq: chapterSeqRef.current, chapterHref: chapterHrefRef.current, selectionSeq: selectionSeqRef.current };
	}, []);

	/** 读取服务状态；页面打开时调用一次（没有定时刷新）。返回本次结果供挂载流程判断，读不到返回 null。 */
	const refreshStatus = useCallback(async (): Promise<ReadingServiceStatus | null> => {
		if (!client) return null;
		setStatusState((previous) => ({ ...previous, loading: true }));
		const result = await callReading(() => client.getStatus());
		if (result.ok) {
			setStatusState({ status: result.status, error: null, loading: false });
			return result.status;
		}
		setStatusState({ status: null, error: result.error, loading: false });
		return null;
	}, [client, setStatusState]);

	const refreshLibrary = useCallback(async (): Promise<void> => {
		if (!client) return;
		setLibrary((previous) => ({ ...previous, loading: true }));
		const result = await callReading(() => client.listLibrary());
		if (result.ok) {
			setLibrary({ works: result.works, fetchedAt: result.fetchedAt, loading: false, error: null });
			return;
		}
		setLibrary((previous) => ({ ...previous, loading: false, error: result.error }));
	}, [client, setLibrary]);

	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		void (async () => {
			// 先读 getStatus 的真实返回再决定是否读书库（不是上一 render 的闭包状态）
			const initial = await refreshStatus();
			// 状态读不到：错误分支优先，绝不继续扫库
			if (cancelled || initial === null) return;
			// 从未成功连接（fresh / 手动断开后）：显示连接面板，不扫默认端口
			if (!readingConnectionHasPriorSuccess(initial.connection)) return;
			await refreshLibrary();
			if (cancelled) return;
			// 成功过但本次尚未探测：读库成功会把 availability 标 ready，再对一次状态收口，
			// 否则决策会一直停在 loading（getStatus 是本地读取，不增加业务请求）
			if (initial.availability === "unknown") await refreshStatus();
		})();
		return () => {
			cancelled = true;
		};
		// 只在页面打开（hook 挂载）时读一次；client 变化（preload 热更新）时重读
	}, [client, refreshLibrary, refreshStatus]);

	/** 选中版本：推进 epoch，清掉上一本的正文；版本视图与位置由各自的 effect 拉取。 */
	const selectBook = useCallback(
		(next: { workId: string; editionId: string } | null) => {
			epochRef.current += 1;
			chapterSeqRef.current += 1;
			contentVersionRef.current = null;
			activeTicketRef.current = next === null ? null : readingRequestTicket({ bookKey: readingBookKey(next), contentVersion: null, epoch: epochRef.current });
			// 切书：上一本书的选区不得继续当作当前书的选区，在飞核验也一并作废
			selectionSeqRef.current += 1;
			setSelectionState({ snapshot: null, quote: null, verifying: false, error: null });
			setSelected(next);
			writeReadingLastBook(connectionUrlRef.current, next, selectionStorage);
		},
		[setSelected, setSelectionState, selectionStorage],
	);

	// 重启后只从本服务已返回的书库恢复真实存在的版本；复用 selectBook 登记请求票据。
	useEffect(() => {
		const baseUrl = statusState.status?.connection.baseUrl;
		if (selected !== null || !baseUrl || library.loading || library.error || library.fetchedAt === null) return;
		const cached = readReadingLastBook(baseUrl, selectionStorage);
		if (cached && library.works.some((work) => work.workId === cached.workId && work.editions.some((entry) => entry.editionId === cached.editionId))) selectBook(cached);
	}, [library, selectBook, selected, selectionStorage, statusState.status?.connection.baseUrl]);

	// 版本视图：选中变化后按新身份读取；发起前先登记票据，响应回写前再比对一次
	useEffect(() => {
		if (!client || !selected) return;
		const bookKeyAtRequest = readingBookKey(selected);
		// 同一版本已经加载过（例如关页重开）：沿用 atom 里的版本，不重复请求
		const cached = editionRef.current.edition;
		if (cached !== null && cached.identity.workId === selected.workId && cached.identity.editionId === selected.editionId) {
			contentVersionRef.current = cached.identity.contentVersion;
			return;
		}
		const ticket = readingRequestTicket({ bookKey: bookKeyAtRequest, contentVersion: null, epoch: epochRef.current });
		activeTicketRef.current = ticket;
		let cancelled = false;
		setEditionState({ edition: null, loading: true, error: null });
		void (async () => {
			const result = await callReading(() => client.getEdition(selected.workId, selected.editionId));
			if (cancelled || !isTicketCurrent(ticket)) return;
			if (result.ok) {
				contentVersionRef.current = result.edition.identity.contentVersion;
				activeTicketRef.current = readingRequestTicket({ bookKey: ticket.bookKey, contentVersion: result.edition.identity.contentVersion, epoch: ticket.epoch });
				setEditionState({ edition: result.edition, loading: false, error: null });
				return;
			}
			setEditionState({ edition: null, loading: false, error: result.error });
		})();
		return () => {
			cancelled = true;
		};
	}, [client, isTicketCurrent, selected, setEditionState]);

	/**
	 * 打开一章正文。chapter 参数用 toc href（核验与位置都用同一形态），
	 * 目录里只有能映射章节的条目才允许进入正文链路。
	 */
	const openChapter = useCallback(
		async (item: ReadingTocItem): Promise<void> => {
			if (!client || !selected || !isReadingChapterSelectable(item)) return;
			const target = readingChapterRequestTarget(item);
			if (target === null) return;
			const seq = chapterSeqRef.current + 1;
			chapterSeqRef.current = seq;
			const bookKeyAtRequest = readingBookKey(selected);
			const requestHref = typeof target === "string" ? target : item.href;
			// 同步推进「当前章节 href」：换章后立即失效在飞核验（不等下一次渲染）
			chapterHrefRef.current = requestHref;
			setChapterState({ chapter: null, requestHref, loading: true, error: null });
			const result = await callReading(() => client.getChapter(selected.workId, selected.editionId, target));
			if (chapterSeqRef.current !== seq) return;
			if (selectedRef.current === null || readingBookKey(selectedRef.current) !== bookKeyAtRequest) return;
			if (result.ok) {
				setChapterState({ chapter: result.chapter, requestHref, loading: false, error: null });
				return;
			}
			setChapterState({ chapter: null, requestHref: null, loading: false, error: result.error });
		},
		[client, selected, setChapterState],
	);

	const closeChapter = useCallback(() => {
		chapterSeqRef.current += 1;
		chapterHrefRef.current = null;
		setChapterState({ chapter: null, requestHref: null, loading: false, error: null });
	}, [setChapterState]);

	const connect = useCallback(
		async (input: ReadingConnectInput): Promise<ReadingErrorInfo | null> => {
			if (!client) return { code: "unsupported", message: "阅读接口未接入" };
			const result = await callReading(() => client.connect(input));
			if (result.ok) {
				setStatusState({ status: result.status, error: null, loading: false });
				await refreshLibrary();
				return null;
			}
			setStatusState({ status: null, error: result.error, loading: false });
			return result.error;
		},
		[client, refreshLibrary, setStatusState],
	);

	const disconnect = useCallback(async (): Promise<ReadingErrorInfo | null> => {
		if (!client) return { code: "unsupported", message: "阅读接口未接入" };
		const result = await callReading(() => client.disconnect());
		if (result.ok) {
			setStatusState({ status: result.status, error: null, loading: false });
			return null;
		}
		setStatusState({ status: null, error: result.error, loading: false });
		return result.error;
	}, [client, setStatusState]);

	/**
	 * 选区核验（P04 的稳定入口）：本节点只核验并展示状态，不把书段发给任何会话或模型。
	 * 偏移只在 exact/normalized 时由 `createReadingSelectionSnapshot` 填入（见 readingSelection）。
	 */
	const verifySelection = useCallback(
		async (text: string): Promise<ReadingQuoteResult | null> => {
			if (!client || !selected) return null;
			const version = contentVersionRef.current ?? editionRef.current.edition?.identity.contentVersion ?? null;
			if (version === null || !readingSelectionVerifiable(text)) return null;
			const href = chapterHrefRef.current;
			// 发起票据：书 + 版本 + 书内轮次 + 正文轮次 + 当次选区轮次
			selectionSeqRef.current += 1;
			const ticket: ReadingVerificationTicket = { bookKey: readingBookKey(selected), workId: selected.workId, editionId: selected.editionId, contentVersion: version, epoch: epochRef.current, chapterSeq: chapterSeqRef.current, chapterHref: href, selectionSeq: selectionSeqRef.current };
			setSelectionState({ snapshot: null, quote: null, verifying: true, error: null });
			const result = await callReading(() => client.resolveQuote({ workId: ticket.workId, editionId: ticket.editionId, text, chapterHref: href, expectedVersion: ticket.contentVersion }));
			if (isReadingVerificationStale(ticket, activeVerificationTicket())) {
				// 作废：不写 quote/snapshot（切书、换版本、换章、已清选区或已被更新的选择取代）。
				// 但「本次仍是最新一次选择」时要收尾 verifying，否则界面会永久停在核验中。
				if (selectionSeqRef.current === ticket.selectionSeq) setSelectionState((previous) => (previous.verifying ? { ...previous, verifying: false } : previous));
				return null;
			}
			if (result.ok) {
				setSelectionState({ snapshot: null, quote: result, verifying: false, error: null });
				return result;
			}
			setSelectionState({ snapshot: null, quote: null, verifying: false, error: result.error });
			return null;
		},
		[activeVerificationTicket, client, selected, setSelectionState],
	);

	const clearSelection = useCallback(() => {
		// 清选区也是「一次选区轮次」：在飞核验不回填，且不会再把它写回来
		selectionSeqRef.current += 1;
		setSelectionState({ snapshot: null, quote: null, verifying: false, error: null });
	}, [setSelectionState]);

	const decision = resolveReadingAvailabilityDecision({ status: statusState.status, error: statusState.error, loading: statusState.loading, hasPriorSuccess: readingConnectionHasPriorSuccess(statusState.status?.connection) });
	const tocHrefs = useMemo(() => (editionState.edition ? editionState.edition.toc.filter((item) => isReadingChapterSelectable(item)).map((item) => item.href) : []), [editionState.edition]);
	// 当前正文的 toc href：票据判定「还是同一章」用它（不是渲染闭包快照）
	chapterHrefRef.current = chapterState.requestHref ?? chapterState.chapter?.href ?? null;

	return {
		clientAvailable,
		status: statusState.status,
		statusError: statusState.error,
		statusLoading: statusState.loading,
		decision,
		connect,
		disconnect,
		libraryWorks: library.works,
		libraryLoading: library.loading,
		libraryError: library.error,
		refreshLibrary,
		selected,
		selectBook,
		edition: editionState.edition,
		editionLoading: editionState.loading,
		editionError: editionState.error,
		chapter: chapterState.chapter,
		chapterHref: chapterState.requestHref,
		chapterNum: chapterState.chapter?.chapterNum ?? null,
		chapterLoading: chapterState.loading,
		chapterError: chapterState.error,
		tocHrefs,
		openChapter,
		closeChapter,
		selection,
		verifySelection,
		clearSelection,
	};
}
