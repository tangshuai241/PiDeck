/**
 * 阅读位置域 hook（唯一 owner）：读取恢复计划、按视口写回位置。
 *
 * 与正文组件分工：组件拥有滚动 DOM，只把「真实的可滚动视口指标」报上来；
 * 是否该恢复、该不该写、写的是哪本书的哪个版本，全部在这里决定（任务规则：纯策略可单测、
 * 保存只写发起对象、零高度或 loading 不覆盖）。
 *
 * 三条不变量（都来自「切章/切书时写回张冠李戴」的事故面）：
 * 1. 写回只用「票据」：发起时把 work/edition/version/href/摘要固定成不可变票据，
 *    滚动指标与票据成对保存；切章结算的是旧票据，不可能把 A 章的指标配 B 版身份。
 * 2. 回执拿票据核对（不是自比较），且只有票据仍是当前视图时才把结果写回可见状态。
 * 3. 幂等与去抖都按「书 + 版本 + 章节」隔离：换书/换章不吃上一份的已保存比例，恢复标记按作用域重置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useStore } from "jotai";
import type { ReadingErrorInfo } from "../../../shared/types/reading";
import { readingPositionAtomFamily, type ReadingPositionState } from "../atoms/reading-atoms";
import type { ReadingClient } from "./useReadingCore";
import { buildReadingPositionSaveInput, isReadingSaveResultForTicket, isReadingSaveTicketCurrent, planReadingPositionRestore, readingRestoreKey, readingSaveGuardKey, readingSaveTicket, shouldPersistReadingPosition, type ReadingPositionPlan, type ReadingSaveTicket } from "../utils/readingPosition";
import { readingBookKey } from "../utils/readingScope";
import { callReading } from "../utils/readingCall";
import { readingStaleReasonKey } from "../utils/readingState";
import type { TranslationKey } from "../i18n";

export type ReadingViewportMetrics = { fraction: number; viewportHeight: number; scrollHeight: number };

/** 需要恢复滚动时下发的请求；`key` 是幂等标识，组件应用后回报 ack（避免反复拉回）。 */
export type ReadingRestoreRequest = { href: string; fraction: number; key: string };

/** 待结算的视口：指标与票据成对存在，结算时不会张冠李戴。 */
type ReadingPendingSave = { ticket: ReadingSaveTicket; metrics: ReadingViewportMetrics };

export type ReadingPositionController = {
	plan: ReadingPositionPlan;
	loading: boolean;
	error: ReadingErrorInfo | null;
	saving: boolean;
	savedAt: string | null;
	/** 陈旧原因文案；none 时 null（首次阅读不提示） */
	staleReasonKey: TranslationKey | null;
	restore: ReadingRestoreRequest | null;
	ackRestore: (key: string) => void;
	reportViewport: (metrics: ReadingViewportMetrics) => void;
	/** 离开章节/卸载时用最后一次真实指标结算（不重新测量，避免零高度覆盖） */
	flush: () => void;
};

export function useReadingPosition(input: {
	client: ReadingClient | null;
	workId: string | null;
	editionId: string | null;
	/** 版本未读到时为 null：此时不读取位置，也不允许写 */
	contentVersion: string | null;
	chapterLoaded: boolean;
	chapterHref: string | null;
	chapterNum: number | null;
	chapterTextDigest: string | null;
	tocHrefs: readonly string[];
}): ReadingPositionController {
	const { client, workId, editionId, contentVersion, chapterLoaded, chapterHref, chapterNum, chapterTextDigest, tocHrefs } = input;
	const bookKey = workId !== null && editionId !== null ? readingBookKey({ workId, editionId }) : "__none__";
	const [state] = useAtom(readingPositionAtomFamily(bookKey));
	const store = useStore();

	/** 本渲染的票据：正文已加载且身份/章节齐备才存在。写回与恢复都只认票据。 */
	const ticket = chapterLoaded ? readingSaveTicket({ workId, editionId, contentVersion, chapterHref, chapterNum, chapterTextDigest }) : null;
	const ticketRef = useRef(ticket);
	ticketRef.current = ticket;
	const scopeKey = ticket === null ? null : readingSaveGuardKey(ticket);

	const requestSeqRef = useRef(0);
	const pendingRef = useRef<ReadingPendingSave | null>(null);
	/** 已保存比例按 scope key 隔离（只保存「最后一次成功写回」的比例，用于去抖）。 */
	const lastSavedRef = useRef<{ key: string; fraction: number } | null>(null);
	/**
	 * 已应用的恢复 key 必须是**state**而不是 ref：ack 不触发重渲染的话，
	 * 记忆化会继续返回同一个 restore 对象，正文组件下一次渲染就会把滚动位置再拉回去一次。
	 */
	const [appliedRestoreKey, setAppliedRestoreKey] = useState<string | null>(null);
	const identityRef = useRef<{ workId: string; editionId: string; contentVersion: string } | null>(null);
	identityRef.current = workId !== null && editionId !== null && contentVersion !== null ? { workId, editionId, contentVersion } : null;

	/** 按票据所属的书写状态：闭包里的 setter 只对「当时的书」有效，结算旧票据时不能用它。 */
	const writeState = useCallback(
		(key: string, updater: (previous: ReadingPositionState) => ReadingPositionState) => {
			store.set(readingPositionAtomFamily(key), updater);
		},
		[store],
	);

	const lastSavedFor = useCallback((owned: ReadingSaveTicket): number | null => {
		const saved = lastSavedRef.current;
		return saved !== null && saved.key === readingSaveGuardKey(owned) ? saved.fraction : null;
	}, []);

	/** 写回位置：入参与核对全部基于票据；迟到回执不落当前书。 */
	const write = useCallback(
		async (entry: ReadingPendingSave): Promise<void> => {
			const owned = entry.ticket;
			if (!client) return;
			if (!shouldPersistReadingPosition({ chapterLoaded: true, chapterHref: owned.chapterHref, viewportHeight: entry.metrics.viewportHeight, scrollHeight: entry.metrics.scrollHeight, fraction: entry.metrics.fraction, lastSavedFraction: lastSavedFor(owned) })) return;
			const payload = buildReadingPositionSaveInput({ workId: owned.workId, editionId: owned.editionId, contentVersion: owned.contentVersion, chapterHref: owned.chapterHref, chapterNum: owned.chapterNum, chapterTextDigest: owned.chapterTextDigest, fraction: entry.metrics.fraction });
			const visible = isReadingSaveTicketCurrent(owned, ticketRef.current);
			if (visible) writeState(owned.bookKey, (previous) => ({ ...previous, saving: true }));
			const result = await callReading(() => client.savePosition(payload));
			if (!isReadingSaveResultForTicket(result, owned)) {
				// 「不是这笔票据的回执」包括失败：只有仍属于当前视图时才把失败显示出来
				if (visible) writeState(owned.bookKey, (previous) => ({ ...previous, saving: false, error: result.ok ? null : result.error }));
				return;
			}
			lastSavedRef.current = { key: readingSaveGuardKey(owned), fraction: result.position.fraction };
			if (!isReadingSaveTicketCurrent(owned, ticketRef.current)) return;
			writeState(owned.bookKey, (previous) => ({ ...previous, saving: false, error: null, lastSavedFraction: result.position.fraction, savedAt: result.position.savedAt }));
		},
		[client, lastSavedFor, writeState],
	);

	/** 位置读取：身份齐备才发；响应回来时比对序号与身份，切书/换版本后丢弃。 */
	const load = useCallback(async (): Promise<void> => {
		if (!client || workId === null || editionId === null || contentVersion === null) return;
		const seq = requestSeqRef.current + 1;
		requestSeqRef.current = seq;
		const atRequest = { workId, editionId, contentVersion };
		const key = readingBookKey({ workId, editionId });
		writeState(key, (previous) => ({ ...previous, loading: true, error: null }));
		const result = await callReading(() => client.getPosition(workId, editionId, contentVersion));
		if (requestSeqRef.current !== seq) return;
		const current = identityRef.current;
		if (current === null || readingBookKey(current) !== key || current.contentVersion !== contentVersion) return;
		const plan = planReadingPositionRestore({ result, contentVersion, tocHrefs });
		const restored = result.ok && result.position !== null && result.position.contentVersion === contentVersion ? result.position : null;
		// 已保存比例的隔离键来自「位置文件里的那张票据」（书 + 版本 + 保存时的章节）
		const savedTicket = restored === null ? null : readingSaveTicket({ workId, editionId, contentVersion, chapterHref: restored.spineHref, chapterNum: restored.chapterNum, chapterTextDigest: restored.chapterTextDigest });
		lastSavedRef.current = restored === null || savedTicket === null ? null : { key: readingSaveGuardKey(savedTicket), fraction: restored.fraction };
		const savedFraction = restored === null ? null : restored.fraction;
		writeState(key, (previous) => ({ ...previous, plan, loading: false, error: result.ok ? null : result.error, saving: false, lastSavedFraction: savedFraction, savedAt: null }));
	}, [client, contentVersion, editionId, tocHrefs, workId, writeState]);

	useEffect(() => {
		void load();
	}, [load]);

	/** 恢复请求：计划指向当前已加载章节时才下发；key 含书/版本/章节，同票据只应用一次。 */
	const planKind = state.plan.kind;
	const planHref = state.plan.kind === "restore" ? state.plan.chapterHref : null;
	const planFraction = state.plan.kind === "restore" ? state.plan.fraction : null;
	const restore = useMemo<ReadingRestoreRequest | null>(() => {
		if (planKind !== "restore" || planHref === null || planFraction === null) return null;
		const owned = readingSaveTicket({ workId, editionId, contentVersion, chapterHref, chapterNum, chapterTextDigest });
		if (owned === null || planHref.trim() !== owned.chapterHref) return null;
		const key = readingRestoreKey(owned, planFraction);
		if (appliedRestoreKey === key) return null;
		return { href: owned.chapterHref, fraction: planFraction, key };
	}, [appliedRestoreKey, chapterHref, chapterNum, chapterTextDigest, editionId, planFraction, planHref, planKind, contentVersion, workId]);

	/**
	 * 作用域变化（换书/换版本/换章）：上一张票据的恢复幂等标记不再适用。
	 * 声明顺序刻意让「结算旧票据」的 effect 先注册：同一个提交里 cleanup 先跑，
	 * 结算用的仍是旧票据与旧指标，之后这里才重置标记。
	 */
	useEffect(() => {
		return () => {
			const entry = pendingRef.current;
			if (entry !== null) void write(entry);
		};
	}, [scopeKey, write]);
	useEffect(() => {
		setAppliedRestoreKey(null);
	}, [scopeKey]);

	const ackRestore = useCallback((key: string) => {
		setAppliedRestoreKey(key);
	}, []);

	const reportViewport = useCallback(
		(metrics: ReadingViewportMetrics) => {
			const owned = ticketRef.current;
			if (owned === null) return;
			const entry = { ticket: owned, metrics };
			pendingRef.current = entry;
			void write(entry);
		},
		[write],
	);

	const flush = useCallback(() => {
		const entry = pendingRef.current;
		if (entry !== null) void write(entry);
	}, [write]);

	return {
		plan: state.plan,
		loading: state.loading,
		error: state.error,
		saving: state.saving,
		savedAt: state.savedAt,
		staleReasonKey: state.plan.kind === "stale" ? readingStaleReasonKey(state.plan.reason) : null,
		restore,
		ackRestore,
		reportViewport,
		flush,
	};
}

/** 位置 atom 的写入类型（hook 内部用，避免在组件里重复声明）。 */
export type ReadingPositionAtomState = ReadingPositionState;
