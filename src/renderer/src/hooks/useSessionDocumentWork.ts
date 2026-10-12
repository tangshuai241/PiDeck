import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentBackend } from "../../../shared/types";
import type { DocumentWorkView, PreparedWork, SessionRuntimeTriple } from "../../../shared/types/documentWork";
import { isAlignmentActive } from "../../../shared/alignment";
import { isDocumentWorkIntent } from "../../../shared/documentIntentPolicy";
import { sameRuntimeTriple } from "../../../shared/documentWork";
import { sessionComposerModeBySessionIdAtomFamily, setSessionComposerModeAtom } from "../atoms/composer-atoms";
import { waitForAlignmentAcknowledgement } from "../utils/alignmentAcknowledgement";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { activePreparationAtomFamily, documentWorkChangeAtomFamily, documentWorkErrorAtomFamily, documentWorkMaterialsAtomFamily, documentWorkPhaseAtomFamily, documentWorkViewAtomFamily, pendingWorkCreationAtomFamily, type DocumentWorkFailure, type DocumentWorkPhase } from "../atoms/document-work-atoms";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
import { hashUserTurnText } from "../utils/documentWorkHash";
import { deriveDocumentWorkCardPresentation, type DocumentWorkCardPresentation } from "../utils/documentWorkPresentation";

function failureOf(result: { ok: false; error: { code: string; retryable: boolean; currentRevision?: number } }): DocumentWorkFailure {
	return { code: result.error.code, retryable: result.error.retryable, ...(result.error.currentRevision !== undefined ? { currentRevision: result.error.currentRevision } : {}) };
}

/** 错误码 → i18n key 的显式映射：不做字符串拼接查找，缺键在编译期就能发现。 */
const FAILURE_COPY: Record<string, TranslationKey> = {
	INVALID_INPUT: "documentWork.error.INVALID_INPUT",
	WORK_NOT_FOUND: "documentWork.error.WORK_NOT_FOUND",
	OPERATION_NOT_FOUND: "documentWork.error.OPERATION_NOT_FOUND",
	REVISION_CONFLICT: "documentWork.error.REVISION_CONFLICT",
	IDEMPOTENCY_CONFLICT: "documentWork.error.IDEMPOTENCY_CONFLICT",
	RUNTIME_CHANGED: "documentWork.error.RUNTIME_CHANGED",
	RUNTIME_BUSY: "documentWork.error.RUNTIME_BUSY",
	PREPARATION_STALE: "documentWork.error.PREPARATION_STALE",
	APPROVAL_REQUIRED: "documentWork.error.APPROVAL_REQUIRED",
	BASE_AMBIGUOUS: "documentWork.error.BASE_AMBIGUOUS",
	BASE_CHANGED: "documentWork.error.BASE_CHANGED",
	PATH_DENIED: "documentWork.error.PATH_DENIED",
	EXTENSION_UNAVAILABLE: "documentWork.error.EXTENSION_UNAVAILABLE",
	DISPATCH_UNKNOWN: "documentWork.error.DISPATCH_UNKNOWN",
	INSPECTION_UNVERIFIED: "documentWork.error.INSPECTION_UNVERIFIED",
	CANCEL_NOT_APPLICABLE: "documentWork.error.CANCEL_NOT_APPLICABLE",
	IO_ERROR: "documentWork.error.IO_ERROR",
};

/** 错误码 → i18n 文案；未知错误回退到通用失败提示，不把内部细节丢给用户。 */
function failureMessage(failure: DocumentWorkFailure | undefined): string | undefined {
	if (!failure) return undefined;
	return t(FAILURE_COPY[failure.code] ?? "documentWork.error.generic");
}

function noticeForFailure(failure: DocumentWorkFailure): string {
	return failureMessage(failure) ?? t("documentWork.error.generic");
}

/** 最新用户消息 id：建立工作与授权改稿都以真实用户轮为准。 */
function latestUserMessageId(messages: readonly { id: string; role: string }[] | undefined): string | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") return messages[index].id;
	}
	return undefined;
}

/**
 * 会话级文稿域 owner：只服务一个 sessionId，分屏/多栏各自订阅自己的状态。
 *
 * 职责边界：
 * - 首次实际提交（对齐已收到用户消息）后建立工作记录；空模式不建记录；
 * - 确认单点击前冻结准备并绑定扩展，渲染层不自行判定批准；
 * - 主进程变化事件只用来触发重新读取，事实源始终是主进程记录。
 */
export function useSessionDocumentWork(sessionId: string, backend: AgentBackend = "pi") {
	const store = useStore();
	const runtimeAtom = sessionRuntimeBySessionIdAtomFamily(sessionId);
	const messagesAtom = sessionMessageCacheBySessionIdAtomFamily(sessionId);
	const viewAtom = documentWorkViewAtomFamily(sessionId);
	const phaseAtom = documentWorkPhaseAtomFamily(sessionId);
	const errorAtom = documentWorkErrorAtomFamily(sessionId);
	const materialsAtom = documentWorkMaterialsAtomFamily(sessionId);
	const pendingAtom = pendingWorkCreationAtomFamily(sessionId);
	const preparationAtom = activePreparationAtomFamily(sessionId);
	const changeAtom = documentWorkChangeAtomFamily(sessionId);

	const view = useAtomValue(viewAtom);
	const phase = useAtomValue(phaseAtom);
	const failure = useAtomValue(errorAtom);
	const materials = useAtomValue(materialsAtom);
	const pendingCreation = useAtomValue(pendingAtom);
	const preparation = useAtomValue(preparationAtom);
	const change = useAtomValue(changeAtom);
	const runtime = useAtomValue(runtimeAtom);
	const messages = useAtomValue(messagesAtom)?.messages;
	/** 材料绝对路径只在本 hook 内短暂保留，不进全局状态。 */
	const materialPathsRef = useRef<string[]>([]);
	const enabled = backend === "pi";

	const targetNow = useCallback((): SessionRuntimeTriple | undefined => {
		const current = store.get(runtimeAtom);
		return current?.agentId ? { sessionId, agentId: current.agentId, runtimeGeneration: current.runtimeGeneration } : undefined;
	}, [sessionId, runtimeAtom, store]);

	const refresh = useCallback(async (): Promise<DocumentWorkView | null> => {
		if (!enabled) return null;
		const views: DocumentWorkView[] = await desktopApi.documentWork.list(sessionId).catch(() => []);
		const next = views[0] ?? null;
		store.set(viewAtom, next);
		return next;
	}, [enabled, sessionId, store, viewAtom]);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
		const unsubscribe = desktopApi.documentWork.onChanged((event) => {
			if (event.sessionId !== sessionId) return;
			store.set(changeAtom, { workId: event.workId, changeKind: event.changeKind, revision: event.revision, ...(event.attemptId ? { attemptId: event.attemptId } : {}) });
			void refresh();
		});
		return unsubscribe;
	}, [enabled, sessionId, refresh, store, changeAtom]);

	useEffect(() => {
		if (!enabled || view || pendingCreation || phase !== "idle") return;
		const alignment = store.get(runtimeAtom)?.state?.alignment ?? undefined;
		// 空模式不建记录：只选模式（revision 0）不算一次实际提交。
		if (!isAlignmentActive(alignment) || (alignment?.revision ?? 0) < 1) return;
		const sourceTurnId = latestUserMessageId(store.get(messagesAtom)?.messages);
		if (!sourceTurnId) return;
		store.set(pendingAtom, { sourceTurnId, ...(alignment?.brief?.goal ? { title: alignment.brief.goal } : {}) });
	}, [enabled, view, pendingCreation, phase, store, runtimeAtom, messagesAtom, pendingAtom]);

	/**
	 * 登记聊天里已经引用/拖入的材料：用户不必再选一次。
	 * 只把「看起来像绝对路径」的候选交给主进程，授权判定仍在主进程（消息逐字包含 + 项目目录）。
	 */
	const registerChatMaterials = useCallback(async (): Promise<number> => {
		if (!enabled) return 0;
		const texts = (store.get(messagesAtom)?.messages ?? []).filter((message) => message.role === "user").map((message) => message.text);
		const candidates = new Set<string>();
		for (const text of texts) {
			for (const match of text.matchAll(/(?:[A-Za-z]:[\/]|\/)[^\s"'<>|]{2,400}/g)) candidates.add(match[0]);
		}
		const paths = [...candidates].filter((path) => /\.(?:docx?|pdf|pptx?|xlsx?|odt|rtf|epub|csv|md|markdown|txt)$/i.test(path)).slice(0, 24);
		if (!paths.length) return 0;
		const registered = await desktopApi.documentWork.registerMaterials({ sessionId, paths });
		if (!registered.ok || registered.value.count === 0) return 0;
		materialPathsRef.current = [...new Set([...materialPathsRef.current, ...registered.value.paths])];
		store.set(
			materialsAtom,
			materialPathsRef.current.map((path) => path.split(/[\/]/).pop() ?? path),
		);
		return registered.value.count;
	}, [enabled, sessionId, store, messagesAtom, materialsAtom]);

	/**
	 * 首次提交后的唯一入口：先让用户经系统选择器授权输出根，再建立记录。
	 * 同一会话只有一件工作，重复调用幂等；用户取消选择时记录不建立。
	 */
	const createForSession = useCallback(async (): Promise<DocumentWorkView | null> => {
		const pending = store.get(pendingAtom);
		if (!enabled || !pending) return null;
		const root = await desktopApi.documentWork.chooseOutputRoot();
		if (!root.ok) {
			if (root.error.code !== "INVALID_INPUT") {
				store.set(errorAtom, failureOf(root));
				showNotice(noticeForFailure(failureOf(root)));
			}
			return null;
		}
		store.set(phaseAtom, "creating");
		store.set(errorAtom, undefined);
		try {
			const created = await desktopApi.documentWork.create({ requestId: crypto.randomUUID(), sessionId, sourceTurnId: pending.sourceTurnId, outputRootId: root.value.outputRootId, ...(pending.title ? { title: pending.title } : {}) });
			if (!created.ok) {
				store.set(errorAtom, failureOf(created));
				showNotice(noticeForFailure(failureOf(created)));
				return null;
			}
			store.set(viewAtom, created.value);
			store.set(pendingAtom, undefined);
			return created.value;
		} finally {
			store.set(phaseAtom, "idle");
		}
	}, [enabled, sessionId, store, pendingAtom, phaseAtom, errorAtom, viewAtom]);

	/** 材料由系统文件选择器授权；渲染层只保留选择结果的路径用于准备。 */
	const chooseMaterials = useCallback(async (): Promise<number> => {
		if (!enabled) return 0;
		const picked = await desktopApi.documentWork.chooseMaterials(sessionId);
		if (!picked.ok) {
			store.set(errorAtom, failureOf(picked));
			return 0;
		}
		materialPathsRef.current = picked.value.paths;
		store.set(
			materialsAtom,
			picked.value.paths.map((path) => path.split(/[\\/]/).pop() ?? path),
		);
		return picked.value.count;
	}, [enabled, sessionId, store, errorAtom, materialsAtom]);

	/**
	 * 确认单点击的唯一批准入口。
	 *
	 * 返回值决定「谁来发批准」：
	 * - `documentWorkDispatched`：文稿路径已由主进程发出 `/align approve`（本轮 triple+brief+revision 的准确回执），
	 *   调用方不得再发一次；
	 * - `proceedWithAlignment`：本轮不是正式文稿任务（普通 Plan/编码/解释），由原对齐控件照常发批准；
	 * - `blocked`：明确是文稿任务但还缺工作记录/成果目录：不发批准、不合并流程，保留输入并说明原因；
	 * - `aborted`：准备/开始失败或运行时不适，本轮不批准。
	 */
	const prepareAndStartForApproval = useCallback(async (): Promise<"documentWorkDispatched" | "proceedWithAlignment" | "blocked" | "aborted"> => {
		if (!enabled) return "proceedWithAlignment";
		const currentView = store.get(viewAtom);
		const currentAlignment = store.get(runtimeAtom)?.state?.alignment ?? undefined;
		const latestTurn = store.get(messagesAtom)?.messages.at(-1);
		// 只有「这份 brief 属于当前 revision」时才用 brief 判断本轮目标；用户又发了新消息
		// （普通编码/解释）会让 revision 前进而 briefRevision 留在旧值，那时以最新用户轮为准。
		const briefIsCurrent = Boolean(currentAlignment?.brief && currentAlignment.briefRevision !== undefined && currentAlignment.briefRevision === currentAlignment.revision);
		const briefText = currentAlignment?.brief ? `${currentAlignment.brief.goal} ${currentAlignment.brief.deliverable}` : "";
		const goalText = briefIsCurrent ? briefText : (latestTurn?.text ?? briefText);
		if (!isDocumentWorkIntent(goalText)) return "proceedWithAlignment";
		if (!currentView) {
			// 明确文稿但还没有工作记录（例如尚未授权输出目录）：不发批准，也不要求重新确认要求。
			store.set(errorAtom, { code: "PATH_DENIED", retryable: true });
			showNotice(t("documentWork.needsOutputRoot"));
			return "blocked";
		}
		// 有版本但没有可用基稿：本轮既不能改稿也不该退回普通聊天，直接说清缺什么。
		if (currentView.versions.length > 0 && !currentView.versions.some((version) => version.inspection === "passed")) {
			store.set(errorAtom, { code: "BASE_AMBIGUOUS", retryable: true });
			showNotice(t("documentWork.noUsableBase"));
			return "blocked";
		}
		const alignment = currentAlignment;
		// 冻结本轮身份：triple + briefId + revision。之后任何一步都不许换用新的运行时状态。
		const frozenRuntime = targetNow();
		if (!alignment?.brief || !isAlignmentActive(alignment) || !frozenRuntime) {
			showNotice(t("documentWork.unavailable"));
			return "aborted";
		}
		const frozenBriefId = alignment.briefId;
		const frozenRevision = alignment.revision;
		if (store.get(phaseAtom) !== "idle") {
			showNotice(t("documentWork.busy"));
			return "aborted";
		}
		const stillCurrent = (): boolean => {
			const now = targetNow();
			return Boolean(now && sameRuntimeTriple(frozenRuntime, now));
		};
		const kind = currentView.versions.length > 0 ? "revise_document" : "create_document";
		store.set(phaseAtom, "preparing");
		store.set(errorAtom, undefined);
		try {
			const prepared = await desktopApi.documentWork.prepare({
				requestId: crypto.randomUUID(),
				workId: currentView.workId,
				expectedRevision: currentView.revision,
				kind,
				requirementsRef: { kind: "alignment", briefId: frozenBriefId, revision: frozenRevision },
				// 对齐路径的范围是自然语言描述，章节引用交给改稿意图路径；这里不伪造章节名。
				scope: {
					summary: `${alignment.brief.deliverable}
${alignment.brief.goal}`.slice(0, 2000),
					sections: [],
					preserve: alignment.brief.preserve.slice(0, 24),
				},
				materialPaths: materialPathsRef.current,
			});
			if (!stillCurrent()) {
				showNotice(t("alignment.runtimeChanged"));
				return "aborted";
			}
			if (!prepared.ok) {
				store.set(errorAtom, failureOf(prepared));
				showNotice(noticeForFailure(failureOf(prepared)));
				return "aborted";
			}
			store.set(phaseAtom, "starting");
			const started = await desktopApi.documentWork.start({
				requestId: crypto.randomUUID(),
				workId: currentView.workId,
				expectedRevision: prepared.value.workRevision,
				preparation: prepared.value.preparation,
				expectedRuntime: frozenRuntime,
				authorization: { kind: "alignment_confirmation", briefId: frozenBriefId, revision: frozenRevision },
			});
			if (!stillCurrent()) {
				showNotice(t("alignment.runtimeChanged"));
				return "aborted";
			}
			if (!started.ok) {
				store.set(errorAtom, failureOf(started));
				showNotice(noticeForFailure(failureOf(started)));
				return "aborted";
			}
			store.set(preparationAtom, { preparation: prepared.value, runtime: frozenRuntime, authorizationKind: "alignment_confirmation" });
			// 只有「本轮 brief+revision 的准确回执 + 同一 runtime」才算批准；超时/换代都不改模式。
			try {
				await waitForAlignmentAcknowledgement({
					read: () => store.get(runtimeAtom)?.state?.alignment ?? undefined,
					isCurrent: stillCurrent,
					subscribe: (changed) => store.sub(runtimeAtom, changed),
					matches: (latest) => latest.briefId === frozenBriefId && latest.revision === frozenRevision && (latest.phase === "approved" || latest.phase === "complete"),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : "notAcknowledged";
				const message = reason === "runtimeChanged" ? t("alignment.runtimeChanged") : t("alignment.notAcknowledged");
				showNotice(message);
				// 不切模式、不触碰新 runtime 状态；错误要显式暴露而不是吞掉。
				store.set(errorAtom, { code: "DISPATCH_UNKNOWN", retryable: true });
				return "aborted";
			}
			if (store.get(sessionComposerModeBySessionIdAtomFamily(sessionId)) === "alignment") store.set(setSessionComposerModeAtom, { sessionId, mode: "normal" });
			return "documentWorkDispatched";
		} finally {
			store.set(phaseAtom, "idle");
			void refresh();
		}
	}, [enabled, sessionId, store, viewAtom, runtimeAtom, phaseAtom, errorAtom, preparationAtom, messagesAtom, refresh, targetNow]);

	/**
	 * 普通聊天的明确改稿：判定与接续全在主进程。
	 *
	 * 渲染层只报告「有新用户消息」，不提供任何授权布尔值；主进程读真实用户当前轮，
	 * 用保守策略判断是不是明确改稿要求（改哪里 + 改什么，且没有「别改先解释」语境）。
	 */
	const requestAutoRevise = useCallback(async (): Promise<boolean> => {
		if (!enabled) return false;
		const result = await desktopApi.documentWork.autoRevise({ sessionId, requestId: crypto.randomUUID() });
		if (!result.ok) return false;
		if (result.value.engaged) void refresh();
		return result.value.engaged;
	}, [enabled, sessionId, refresh]);

	/**
	 * 改稿轮触发点：用户开启改稿后发送的下一条消息就是本轮改稿要求。
	 * 用「最新用户消息 id 变化」判定，不解析文字内容，也不依赖模型自我声明。
	 */
	const lastRevisionTurnRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!enabled || !view?.revisionReady) return;
		const latest = latestUserMessageId(messages);
		if (!latest || latest === lastRevisionTurnRef.current) return;
		lastRevisionTurnRef.current = latest;
		const turn = messages?.find((message) => message.id === latest);
		if (!turn?.text.trim()) return;
		void requestAutoRevise();
	}, [enabled, view?.revisionReady, messages, requestAutoRevise]);

	/** 取消只针对本轮：attemptId 与 runtime 三元组都必须匹配。 */
	const cancelActive = useCallback(async (): Promise<void> => {
		const currentView = store.get(viewAtom);
		const active = currentView?.active;
		const triple = targetNow();
		if (!enabled || !currentView || !active || !triple) return;
		store.set(phaseAtom, "cancelling");
		try {
			const cancelled = await desktopApi.documentWork.cancel({ requestId: crypto.randomUUID(), workId: currentView.workId, expectedRevision: currentView.revision, attemptId: active.attemptId, expectedRuntime: triple });
			if (!cancelled.ok) {
				store.set(errorAtom, failureOf(cancelled));
				showNotice(noticeForFailure(failureOf(cancelled)));
				return;
			}
			showNotice(t("documentWork.cancelledNotice"));
		} finally {
			store.set(phaseAtom, "idle");
			await refresh();
		}
	}, [enabled, store, viewAtom, phaseAtom, errorAtom, refresh, targetNow]);

	const presentation: DocumentWorkCardPresentation = useMemo(() => deriveDocumentWorkCardPresentation({ view, pendingCreation, phase, change, failure }), [view, pendingCreation, phase, change, failure]);

	/** 普通聊天继续改稿由扩展声明意图、主进程复核并分发；卡片只负责提示当前基稿。 */
	const canReviseInChat = presentation.canRevise;

	return {
		enabled,
		view,
		phase,
		failure,
		errorMessage: failureMessage(failure),
		materials,
		presentation,
		canReviseInChat,
		activePreparation: preparation,
		needsOutputRoot: Boolean(pendingCreation && !view),
		createForSession,
		chooseMaterials,
		registerChatMaterials,
		prepareAndStartForApproval,
		requestAutoRevise,
		cancelActive,
		refresh,
	};
}

export type SessionDocumentWorkControls = ReturnType<typeof useSessionDocumentWork>;
