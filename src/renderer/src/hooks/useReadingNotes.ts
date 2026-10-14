/**
 * 笔记域 hook（唯一 owner）：列表、读取、手工写（create / update / append）、未确认草稿的恢复与丢弃。
 *
 * 规则来源（desktop-reading-contract §笔记 + 任务清单）：
 * - 只有服务端 `state="applied"` 且带非空 `revision` 才算已保存；pending/unknown 保留原稿并显示待确认。
 * - 重试必须复用「原 requestId + 原载荷」（同载荷重交复用，改内容开新稿，旧稿不覆盖）。
 * - 截断的全文只能看：打开截断笔记时禁用「覆盖」式 update，追加/新建不受影响。
 * - `truncated`/`unlocated`/`linkStatus` 一律以服务端为准，界面不推断定位。
 * - 未发送输入按「书 + 笔记」作用域存在 Jotai 里（切目标 = 切 atom，不是清空），保存成功才清空。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import type { ReadingErrorInfo, ReadingNoteDraft, ReadingNoteReadResult, ReadingNoteSummary, ReadingNoteWriteOperation, ReadingNoteWriteResult } from "../../../shared/types/reading";
import { readingNoteEditTargetAtomFamily, readingNoteInputAtomFamily, readingNoteSubmitAtomFamily, readingNotesAtomFamily, type ReadingNoteSubmitState } from "../atoms/reading-atoms";
import type { ReadingClient } from "./useReadingCore";
import { callReading } from "../utils/readingCall";
import { emptyReadingNoteInput, planReadingNoteSubmit, readingNoteAckDisposition, readingNoteDraftsForBook, readingNoteHasCas, readingNoteInputFromOperation, readingNoteSaveState, type ReadingNoteInput, type ReadingNoteSaveState } from "../utils/readingNotes";
import { readingBookKey, readingNoteInputKey } from "../utils/readingScope";

export type ReadingNotesController = {
	clientAvailable: boolean;
	/** 服务明确未提供该能力（listNotes 返回 unsupported）；与「账号未连接」「服务不可达」分开 */
	unsupported: boolean;
	notes: ReadingNoteSummary[];
	unattributed: ReadingNoteSummary[];
	drafts: ReadingNoteDraft[];
	draftIssue: ReadingErrorInfo | null;
	loading: boolean;
	error: ReadingErrorInfo | null;
	open: { note: ReadingNoteSummary; content: string; truncated: boolean } | null;
	refresh: () => Promise<void>;
	openNote: (noteId: string) => Promise<void>;
	closeNote: () => void;
	input: ReadingNoteInput;
	targetSummary: ReadingNoteSummary | null;
	/** 切换编辑目标（null = 新建）；每个目标有各自的未发送输入 */
	selectTarget: (noteId: string | null, op?: ReadingNoteInput["op"]) => void;
	setConcept: (value: string) => void;
	setSection: (value: string) => void;
	setContent: (value: string) => void;
	/** 打开的是截断全文：只能看，不能作为覆盖底稿 */
	truncatedOpen: boolean;
	canSubmit: boolean;
	submit: () => Promise<void>;
	retryDraft: (requestId: string) => Promise<void>;
	discardDraft: (requestId: string) => Promise<void>;
	submitState: ReadingNoteSubmitState;
};

const EMPTY_BOOK_KEY = "__none__";

/**
 * 一次提交/重试的发起票据：书身份 + 输入槽 + 编辑目标 + 原载荷快照 + requestId。
 * ACK（或拒绝）就按这张票据结算，而不是按「ACK 到达时界面正好在哪」。
 */
type ReadingNoteSubmitTicket = {
	bookKey: string;
	workId: string;
	editionId: string;
	/** null = 没有绑定的输入槽（草稿重试反推不出槽时） */
	inputKey: string | null;
	targetId: string | null;
	input: ReadingNoteInput | null;
	requestId: string;
};

export function useReadingNotes(input: { client: ReadingClient | null; workId: string | null; editionId: string | null }): ReadingNotesController {
	const { client, workId, editionId } = input;
	// 身份对象必须按 (workId, editionId) 记忆化：每渲染新建对象会让 refresh 的 useCallback
	// 每渲染都变，进而让「打开即读取」的 effect 反复重跑（请求风暴）。
	const identity = useMemo(() => (workId !== null && editionId !== null ? { workId, editionId } : null), [workId, editionId]);
	const bookKey = identity ? readingBookKey(identity) : EMPTY_BOOK_KEY;
	const [state, setState] = useAtom(readingNotesAtomFamily(bookKey));
	const submitState = useAtomValue(readingNoteSubmitAtomFamily(bookKey));
	const editTarget = useAtomValue(readingNoteEditTargetAtomFamily(bookKey));
	/** 当前输入槽的 key：书 + 编辑目标；写入一律按 key 定位，不靠闭包里的 setter。 */
	const inputKey = readingNoteInputKey(bookKey, editTarget);
	const noteInput = useAtomValue(readingNoteInputAtomFamily(inputKey));
	const store = useStore();

	const requestSeqRef = useRef(0);
	const identityRef = useRef<{ workId: string; editionId: string } | null>(null);
	identityRef.current = identity;

	const { notes, unattributed, drafts, open } = state;
	const targetSummary = useMemo(() => {
		if (editTarget === null) return null;
		return [...notes, ...unattributed].find((note) => note.noteId === editTarget) ?? null;
	}, [editTarget, notes, unattributed]);

	const isCurrent = useCallback((atRequest: { workId: string; editionId: string }) => {
		const current = identityRef.current;
		return current !== null && readingBookKey(current) === readingBookKey(atRequest);
	}, []);

	/** 列表 + 未确认草稿：页面打开/切书后读一次；没有轮询。 */
	const refresh = useCallback(async (): Promise<void> => {
		if (!client || !identity) return;
		const seq = requestSeqRef.current + 1;
		requestSeqRef.current = seq;
		const atRequest = { ...identity };
		setState((previous) => ({ ...previous, loading: true, error: null }));
		const [list, draftList] = await Promise.all([callReading(() => client.listNotes(identity.workId, identity.editionId)), callReading(() => client.listNoteDrafts())]);
		if (requestSeqRef.current !== seq || !isCurrent(atRequest)) return;
		setState((previous) => ({
			...previous,
			notes: list.ok ? list.notes : previous.notes,
			unattributed: list.ok ? list.unattributed : previous.unattributed,
			drafts: draftList.ok ? readingNoteDraftsForBook(draftList.drafts, atRequest) : previous.drafts,
			draftIssue: draftList.ok ? draftList.issue : (draftList.error ?? previous.draftIssue),
			loading: false,
			error: list.ok ? null : list.error,
		}));
	}, [client, identity, isCurrent, setState]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const openNote = useCallback(
		async (noteId: string): Promise<void> => {
			if (!client || !identity) return;
			const atRequest = { ...identity };
			const seq = requestSeqRef.current + 1;
			requestSeqRef.current = seq;
			const result: ReadingNoteReadResult = await callReading(() => client.readNote(identity.workId, noteId));
			if (requestSeqRef.current !== seq || !isCurrent(atRequest)) return;
			if (result.ok) {
				setState((previous) => ({ ...previous, open: { note: result.note, content: result.content, truncated: result.truncated }, error: null }));
				return;
			}
			setState((previous) => ({ ...previous, open: null, error: result.error }));
		},
		[client, identity, isCurrent, setState],
	);

	const closeNote = useCallback(() => {
		setState((previous) => ({ ...previous, open: null }));
	}, [setState]);

	/** 切换编辑目标：null = 新建。目标切换只换 atom，不丢各自已输入的草稿。 */
	const selectTarget = useCallback(
		(noteId: string | null, op?: ReadingNoteInput["op"]) => {
			// op 必须写进**目标槽**（而不是当前槽）：否则 append/update 的 op 会落到上一个目标的输入上，
			// 新目标仍按默认 create 提交（会造成「想追加却新建」）。
			if (op) store.set(readingNoteInputAtomFamily(readingNoteInputKey(bookKey, noteId)), (previous) => ({ ...previous, op, noteId }));
			store.set(readingNoteEditTargetAtomFamily(bookKey), noteId);
		},
		[bookKey, store],
	);

	const setConcept = useCallback((value: string) => store.set(readingNoteInputAtomFamily(inputKey), (previous) => ({ ...previous, concept: value })), [inputKey, store]);
	const setSection = useCallback((value: string) => store.set(readingNoteInputAtomFamily(inputKey), (previous) => ({ ...previous, section: value })), [inputKey, store]);
	const setContent = useCallback((value: string) => store.set(readingNoteInputAtomFamily(inputKey), (previous) => ({ ...previous, content: value })), [inputKey, store]);

	/** 由输入构造 wire operation；update/append 必须有 CAS revision，否则不发（服务端只会拒绝）。 */
	const buildOperation = useCallback((): ReadingNoteWriteOperation | null => {
		if (!identity) return null;
		if (noteInput.op === "create") {
			const concept = noteInput.concept.trim().length > 0 ? noteInput.concept.trim() : noteInput.content.trim().slice(0, 40);
			if (concept.length === 0) return null;
			return { op: "create", workId: identity.workId, editionId: identity.editionId, concept, chapter: noteInput.chapterLabel.trim().length > 0 ? noteInput.chapterLabel.trim() : null, quote: null, understanding: noteInput.content.trim().length > 0 ? noteInput.content : null };
		}
		if (targetSummary === null || !readingNoteHasCas(targetSummary)) return null;
		return { op: noteInput.op, workId: identity.workId, editionId: identity.editionId, noteId: targetSummary.noteId, section: noteInput.section, content: noteInput.content, expectedRevision: targetSummary.revision ?? "" };
	}, [identity, noteInput, targetSummary]);

	/**
	 * 写回执结算：按**发起的书 + 输入槽 + 原载荷快照**收尾，而不是拿当前渲染的 setter 去清当前对象。
	 * - 提交状态结算在发起书的作用域上（切书后回来不能永久 pending；也不得写当前书的提交状态）；
	 * - 已确认时只清「发起时那个槽」，且仅当它仍是提交时那份原文（逐字节、op/段落/目标全同）；
	 * - 当前编辑目标只在仍等于发起目标时才置空（用户已经切了目标就不动它）。
	 */
	const settleWriteResult = useCallback(
		async (result: ReadingNoteWriteResult, ticket: ReadingNoteSubmitTicket): Promise<void> => {
			const saveState: ReadingNoteSaveState = readingNoteSaveState(result);
			store.set(readingNoteSubmitAtomFamily(ticket.bookKey), { pending: false, lastState: saveState, requestId: result.ok ? result.requestId : ticket.requestId, error: result.ok ? null : result.error });
			if (saveState !== "saved") {
				// 未确认/失败：保留原稿（用户之后切回该槽也不会丢）；主进程已落盘的草稿并进发起书的列表
				const persistedDraft = result.ok ? null : (result.draft ?? null);
				if (persistedDraft) store.set(readingNotesAtomFamily(ticket.bookKey), (previous) => ({ ...previous, drafts: mergeDraft(previous.drafts, persistedDraft) }));
				return;
			}
			if (ticket.inputKey !== null && ticket.input !== null) {
				const disposition = readingNoteAckDisposition({ acked: ticket.input, stored: store.get(readingNoteInputAtomFamily(ticket.inputKey)) });
				if (disposition.clearInput) {
					store.set(readingNoteInputAtomFamily(ticket.inputKey), emptyReadingNoteInput());
					// 只有当前目标仍是发起目标才清；已经切到别处就保持，不把当前目标置空
					if (store.get(readingNoteEditTargetAtomFamily(ticket.bookKey)) === ticket.targetId) store.set(readingNoteEditTargetAtomFamily(ticket.bookKey), null);
				}
			}
			// 仍停在发起书时才刷新列表；切书后回来会自然重读
			const current = identityRef.current;
			if (current !== null && readingBookKey(current) === ticket.bookKey) await refresh();
		},
		[refresh, store],
	);

	const submit = useCallback(async (): Promise<void> => {
		if (!client || !identity) return;
		const operation = buildOperation();
		if (operation === null) return;
		// 同载荷已有未确认草稿 → 复用原 requestId（重试原请求）；内容变了 → 新 requestId（新稿，旧稿保留）
		const plan = planReadingNoteSubmit({ drafts: state.drafts, operation, now: Date.now(), nonce: Math.random().toString(36).slice(2, 10) });
		// 发起票据：书、输入槽、目标与「原载荷快照」固定下来，之后 ACK 只按它结算
		const ticket: ReadingNoteSubmitTicket = { bookKey, workId: identity.workId, editionId: identity.editionId, inputKey, targetId: editTarget, input: { ...noteInput }, requestId: plan.requestId };
		store.set(readingNoteSubmitAtomFamily(bookKey), { pending: true, lastState: null, requestId: plan.requestId, error: null });
		const result = await callReading(() => client.writeNote({ operation, clientRequestId: plan.requestId }));
		await settleWriteResult(result, ticket);
	}, [buildOperation, client, editTarget, identity, inputKey, noteInput, settleWriteResult, state.drafts, store, bookKey]);

	/** 恢复未确认草稿：主进程先查服务端台账（只读），服务端无记录才用原 requestId + 原载荷重发。 */
	const retryDraft = useCallback(
		async (requestId: string): Promise<void> => {
			if (!client || !identity) return;
			const draft = state.drafts.find((entry) => entry.requestId === requestId);
			if (!draft) return;
			const draftBookKey = readingBookKey({ workId: draft.workId, editionId: draft.editionId });
			const mapped = readingNoteInputFromOperation(draft.operation);
			const ticket: ReadingNoteSubmitTicket = { bookKey: draftBookKey, workId: draft.workId, editionId: draft.editionId, inputKey: mapped === null ? null : readingNoteInputKey(draftBookKey, mapped.targetId), targetId: mapped === null ? null : mapped.targetId, input: mapped === null ? null : mapped.input, requestId };
			store.set(readingNoteSubmitAtomFamily(draftBookKey), { pending: true, lastState: null, requestId, error: null });
			const result = await callReading(() => client.resumeNoteDraft({ requestId }));
			await settleWriteResult(result, ticket);
		},
		[client, identity, settleWriteResult, state.drafts, store],
	);

	const discardDraft = useCallback(
		async (requestId: string): Promise<void> => {
			if (!client) return;
			const result = await callReading(() => client.discardNoteDraft({ requestId }));
			if (!result.ok) {
				store.set(readingNoteSubmitAtomFamily(bookKey), (previous) => ({ ...previous, error: result.error }));
				return;
			}
			store.set(readingNotesAtomFamily(bookKey), (previous) => ({ ...previous, drafts: previous.drafts.filter((entry) => entry.requestId !== requestId) }));
		},
		[bookKey, client, store],
	);

	const truncatedOpen = open !== null && open.truncated;
	const unsupported = state.error !== null && state.error.code === "unsupported";
	// update 的底稿必须是完整全文；截断时不允许覆盖（追加与新建不受影响）
	const canSubmit = client !== null && identity !== null && !submitState.pending && buildOperation() !== null && !(truncatedOpen && noteInput.op === "update");

	return {
		clientAvailable: client !== null,
		unsupported,
		notes,
		unattributed,
		drafts,
		draftIssue: state.draftIssue,
		loading: state.loading,
		error: state.error,
		open,
		refresh,
		openNote,
		closeNote,
		input: noteInput,
		targetSummary,
		selectTarget,
		setConcept,
		setSection,
		setContent,
		truncatedOpen,
		canSubmit,
		submit,
		retryDraft,
		discardDraft,
		submitState,
	};
}

/** 同一 requestId 只保留一条（返回的草稿可能已在列表里）。 */
function mergeDraft(drafts: ReadingNoteDraft[], next: ReadingNoteDraft): ReadingNoteDraft[] {
	const rest = drafts.filter((entry) => entry.requestId !== next.requestId);
	return [...rest, next];
}
