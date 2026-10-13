import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentBackend } from "../../../shared/types";
import type { DocumentWorkView, PreparedWork, SessionRuntimeTriple } from "../../../shared/types/documentWork";
import { isAlignmentActive } from "../../../shared/alignment";
import { routeDocumentTurn } from "../../../shared/documentIntentPolicy";
import { deriveDocumentWorkFirstCreateAction, documentWorkFirstCreateKey } from "../utils/documentWorkCreationIntent";
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
	COMMAND_BLOCKED: "documentWork.error.COMMAND_BLOCKED",
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
	return latestUserTurn(messages)?.id;
}

/** 最新真实用户轮（id + 正文）：建档与改稿都以它绑定身份，不依赖消息 ID 生成方案。 */
function latestUserTurn(messages: readonly { id: string; role: string; text?: string }[] | undefined): { id: string; text: string } | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "user") return { id: messages[index].id, text: messages[index].text ?? "" };
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

	/**
	 * 首次建档的转场。
	 *
	 * 关键点（真实验收缺陷的根因）：依赖必须是**订阅到的值**推出的稳定签名，不能是 atom 对象
	 * 本身——否则 Pi 发布 ready brief 之后组件重渲染、effect 不再执行，建档入口永远不出现。
	 */
	const createAction = useMemo(() => deriveDocumentWorkFirstCreateAction({ alignment: runtime?.state?.alignment ?? undefined, hasWorkView: Boolean(view), phase, latestUserTurn: latestUserTurn(messages) }), [runtime, view, phase, messages]);
	const createActionKey = documentWorkFirstCreateKey(createAction);
	useEffect(() => {
		if (!enabled) return;
		if (createAction.kind === "arm") {
			// 同一轮不重写（待建状态跨渲染保持）；换了新的文稿轮才更新绑定的身份。
			const current = store.get(pendingAtom);
			if (!current || current.sourceTurnId !== createAction.intent.sourceTurnId) store.set(pendingAtom, createAction.intent);
			return;
		}
		// 非文稿轮/退出对齐：撤掉还没被消费的待建，避免普通轮显示文稿卡。
		if (createAction.kind === "clear" && store.get(pendingAtom)) store.set(pendingAtom, undefined);
	}, [enabled, createActionKey, store, pendingAtom, createAction]);

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
		const latestTurn = latestUserTurn(store.get(messagesAtom)?.messages);
		// 只有「这份 brief 属于当前 revision」时才让 brief 参与路由；用户又发了新消息会让
		// revision 前进而 briefRevision 留在旧值，那时旧 brief 不参与。
		const briefIsCurrent = Boolean(currentAlignment?.brief && currentAlignment.briefRevision !== undefined && currentAlignment.briefRevision === currentAlignment.revision);
		const briefText = briefIsCurrent && currentAlignment?.brief ? `${currentAlignment.brief.goal} ${currentAlignment.brief.deliverable}` : "";
		// 与首次建档共用同一套当前轮路由：用户原话优先于模型措辞，工程轮不被旧文稿域吞掉。
		if (routeDocumentTurn({ userText: latestTurn?.text, briefText }) !== "document") return "proceedWithAlignment";
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
				// 换代之后这一轮已经不是当前 runtime 的了：不写 errorAtom，也不改模式，
				// 否则会用旧等待的结论覆盖新 runtime 自己的状态。错误仍要显式暴露，不吞。
				if (stillCurrent()) store.set(errorAtom, { code: "DISPATCH_UNKNOWN", retryable: true });
				return "aborted";
			}
			if (store.get(sessionComposerModeBySessionIdAtomFamily(sessionId)) === "alignment") store.set(setSessionComposerModeAtom, { sessionId, mode: "normal" });
			return "documentWorkDispatched";
		} finally {
			// 同一道 ownership 护栏：换代后旧一轮不得重置 phase（那是新 runtime 的状态）。
			if (stillCurrent()) {
				store.set(phaseAtom, "idle");
				void refresh();
			}
		}
	}, [enabled, sessionId, store, viewAtom, runtimeAtom, phaseAtom, errorAtom, preparationAtom, messagesAtom, refresh, targetNow]);

	/**
	 * 普通聊天的明确改稿：判定与接续全在主进程。
	 *
	 * 渲染层只报告「哪一轮有新用户消息」，不提供任何授权布尔值；主进程读真实用户当前轮，
	 * 用保守策略判断是不是明确改稿要求（改哪里 + 改什么，且没有「别改先解释」语境）。
	 * 返回 `{ engaged, settled }`：`settled` 为假代表这一轮只是「还没到」（快照/回显在途），
	 * 触发点要在下一次真实状态变化时重试，不能永久丢掉这一轮。
	 */
	const requestAutoRevise = useCallback(
		async (sourceTurnId: string): Promise<{ engaged: boolean; settled: boolean }> => {
			if (!enabled) return { engaged: false, settled: true };
			const result = await desktopApi.documentWork.autoRevise({ sessionId, requestId: crypto.randomUUID(), sourceTurnId });
			if (!result.ok) {
				// 真的接续失败要说出来（本地化、不带 id）：用户不该靠再确认一次才发现没开始。
				store.set(errorAtom, failureOf(result));
				showNotice(noticeForFailure(failureOf(result)));
				return { engaged: false, settled: true };
			}
			if (result.value.engaged) void refresh();
			// 只有这两类是暂时性的：快照还没有这一轮，或运行时快照此刻不可用。
			const transient = result.value.reason === "turn_not_arrived" || result.value.reason === "runtime_unavailable";
			return { engaged: result.value.engaged, settled: !transient };
		},
		[enabled, sessionId, store, errorAtom, refresh],
	);

	/**
	 * 改稿轮触发点：用户开启改稿后发送的下一条消息就是本轮改稿要求。
	 * 用「最新用户消息 id 变化」判定，不解析文字内容，也不依赖模型自我声明。
	 *
	 * 真机缺陷（live-acceptance/ordinary-scope-revision.json）：模型如实声明了改稿意图、
	 * 宿主也记下了意图，却没有任何 bind / 改稿提示 / 准备 / 回执。原因是触发点把轮标识
	 * 在确认正文之前就烧掉了：乐观消息可能先以「稳定 id + 空正文」到达；即便正文到了，
	 * 主进程那一读也可能还没看到这一轮，于是按旧轮判定「不够明确」，而这一轮此后再无机会。
	 *
	 * 现在的规则：
	 * - 空正文不算一轮，不落定（等正文到达再触发）；
	 * - 同一轮只发起一次进行中的请求（pending），避免重复渲染叠加；
	 * - 主进程说终局（不接续/已消费）才把这一轮落定；说「还没到」就保持待办，
	 *   等下一次真实状态变化（消息/视图/runtime）再试一次——不加定时器、不轮询。
	 */
	const revisionTurnRef = useRef<{ turnId?: string; pending: boolean; settled: Set<string> }>({ pending: false, settled: new Set<string>() });
	useEffect(() => {
		if (!enabled || !view?.revisionReady) return;
		const latest = latestUserMessageId(messages);
		if (!latest) return;
		const state = revisionTurnRef.current;
		if (state.settled.has(latest)) return;
		const turn = messages?.find((message) => message.id === latest);
		// 正文未到（乐观消息先到）不算一轮：绝不在这里烧掉轮标识。
		if (!turn?.text.trim()) return;
		if (state.pending && state.turnId === latest) return;
		state.turnId = latest;
		state.pending = true;
		void (async () => {
			const outcome = await requestAutoRevise(latest);
			state.pending = false;
			if (outcome.settled) state.settled.add(latest);
			if (state.turnId === latest) state.turnId = undefined;
		})();
	}, [enabled, view?.revisionReady, view?.revision, messages, requestAutoRevise]);

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
