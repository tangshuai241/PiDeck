import { useSetAtom, useStore } from "jotai";
import { beginAlignmentSubmission } from "../atoms/alignment-atoms";
import { useRef } from "react";
import type { ComposerAgentMode, ImageContent, SendSessionPromptInput, SendSessionPromptResult, SessionRuntimeTarget } from "../../../shared/types";
import { classifyComposerSlashCommand } from "../utils/composerSlashCommand";
import {
	bindSessionRuntimeAtom,
	bumpNewTurnCollapseTickAtom,
	cacheSessionMessagesAtom,
	sessionAttachmentsByIdAtom,
	sessionMessagesCacheAtom,
	sessionComposerModeByIdAtom,
	sessionDraftByIdAtom,
	sessionQuotesByIdAtom,
	sessionRecordsAtom,
	sessionRuntimeByIdAtom,
	sessionSendStateByIdAtom,
	setSessionAttachmentsAtom,
	setSessionDraftAtom,
	setSessionQuotesAtom,
	type SessionQuoteMap,
	setSessionSendStateAtom,
	upsertSessionAtom,
} from "../atoms";
import { buildComposerPromptSubmission, deriveComposerAgentMode, expandPromptTemplates } from "../composerBehavior";
import { expandQuoteTokens, stripQuoteTokens } from "../components/session/composer/quoteChip";
import { t, translateI18nDescriptor } from "../i18n";

export type EnqueuePromptSnapshot = {
	displayText: string;
	message: string;
	images?: ImageContent[];
	agentMode: string;
	/** 排队投递策略，决定在 agent busy/idle 哪个阶段排空。 */
	behavior?: "steer" | "followUp";
};

type PromptTemplate = {
	name: string;
	path: string;
	description: string;
	content: string;
	argumentHint?: string;
};

type SessionPromptApi = (input: SendSessionPromptInput) => Promise<SendSessionPromptResult>;

export type UseSessionSendOptions = {
	/** Stable public identity for every draft, request, queue entry, and runtime binding. */
	sessionId: string;
	sendPrompt: SessionPromptApi;
	/** Promotes a renderer-only pre-send surface to a persistent Session. */
	ensureSessionId?: (sessionId: string) => Promise<string>;
	templates: PromptTemplate[];
	prepareMessage?: (message: string) => Promise<string>;
	onDraftMutation?: (sessionId: string) => void;
	compact: (target: SessionRuntimeTarget, prompt?: string) => Promise<void>;
	/** `/new`：桌面拦截后新建 Agent 会话（不发给 pi）。 */
	createNewSession?: () => Promise<void>;
	/** `/login [providerId]`：桌面拦截后打开登录供应商弹框（pi 的登录只在它的 CLI 层，走认证例外通道）。 */
	openProviderLogin?: (providerId?: string) => void;
	resetComposerUi?: () => void;
	recordPromptHistory?: (sessionId: string, message: string) => void;
	refreshProject?: (projectId: string) => void;
	showError?: (message: string, duration?: number) => void;
	showUnknown?: () => void;
	/** ACP 首启失败回收（可选）：会话激活从未成功（仍 draft 且被 agent 拒收）时由外层
	 *  删除会话并回收草稿到引导页；返回 true 表示已清理，发送链路立即结算。 */

	/** Called when streamingBehavior is "steer" before sending. Returns true if enqueued. */
	enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export function normalizeComposerDomText(value: string): string {
	return value.replace(/\u200B/g, "");
}

export function mergeRejectedComposerDraft(rejectedDraft: string, currentDraft: string): string {
	return [rejectedDraft, currentDraft].filter((text) => text.trim()).join("\n\n");
}

export function mergeRejectedComposerImages(rejectedImages: ImageContent[] | undefined, currentImages: ImageContent[]): ImageContent[] {
	return rejectedImages?.length ? [...rejectedImages, ...currentImages] : currentImages;
}

export function hasComposerSubmission(message: string, images: ImageContent[] | undefined): boolean {
	return Boolean(message.trim() || images?.length);
}

export function classifySessionPromptResult(result: SendSessionPromptResult): "accepted" | "rejected" | "unknown" {
	if (result.accepted) return "accepted";
	return result.delivery === "unknown" ? "unknown" : "rejected";
}

export function createSessionSendLock() {
	const sessionIds = new Set<string>();
	return {
		has: (sessionId: string) => sessionIds.has(sessionId),
		claim: (sessionId: string) => {
			if (sessionIds.has(sessionId)) return false;
			sessionIds.add(sessionId);
			return true;
		},
		release: (sessionId: string) => {
			sessionIds.delete(sessionId);
		},
	};
}

export function useSessionSend(options: UseSessionSendOptions) {
	const store = useStore();
	const setDraft = useSetAtom(setSessionDraftAtom);
	const setAttachments = useSetAtom(setSessionAttachmentsAtom);
	const setQuotes = useSetAtom(setSessionQuotesAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const setSendState = useSetAtom(setSessionSendStateAtom);
	const bindRuntime = useSetAtom(bindSessionRuntimeAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const sendingSessionIdsRef = useRef<Set<string>>(new Set());

	function clearSnapshot(targetSessionId: string) {
		options.onDraftMutation?.(targetSessionId);
		setDraft({ sessionId: targetSessionId, value: "" });
		setAttachments({ sessionId: targetSessionId, value: [] });
		// 草稿已清空，快照随之清理：避免会话内孤儿引用无限堆积
		setQuotes({ sessionId: targetSessionId, value: {} });
	}

	function restoreRejectedSnapshot(targetSessionId: string, message: string, imageSnapshot?: ImageContent[], quoteSnapshot?: SessionQuoteMap) {
		options.onDraftMutation?.(targetSessionId);
		setDraft({
			sessionId: targetSessionId,
			value: (current) => [message, current].filter((text) => text.trim()).join("\n\n"),
		});
		if (imageSnapshot) {
			setAttachments({
				sessionId: targetSessionId,
				value: (current) => [...imageSnapshot, ...current],
			});
		}
		if (quoteSnapshot) {
			// token 与全文必须一同回填；发送期间新增的引用保留，以免重试变成孤儿 token。
			setQuotes({ sessionId: targetSessionId, value: (current) => ({ ...quoteSnapshot, ...current }) });
		}
	}

	/** 模板正文为空时统一的拦截提示：error 状态 + toast（带模板名，便于定位编辑）。 */
	function rejectEmptyTemplate(targetSessionId: string, templateName: string) {
		const message = t("app.promptTemplateEmptyBody", { name: templateName });
		setSendState({
			sessionId: targetSessionId,
			state: { status: "error", error: message },
		});
		options.showError?.(message, 4500);
	}

	/**
	 * 发送收尾时清空草稿快照。
	 * keepDraft=true（快捷消息直发）时跳过：那条路径消费的是外部文本，
	 * 用户正在写的草稿/附件/引用必须原样保留。
	 */
	function clearComposerSnapshot(targetSessionId: string, keepDraft: boolean) {
		if (keepDraft) return;
		clearSnapshot(targetSessionId);
	}

	/**
	 * 清空输入框的临时 UI 状态（↑ 历史游标、联想菜单、DOM 草稿镜像等）。
	 * keepDraft=true（快捷消息直发）时跳过：这些状态全属于用户正在编辑的那份草稿，
	 * 把 liveDomDraftRef 置空会让后续发送误以为输入框是空的。
	 */
	function resetComposerEphemeralUi(keepDraft: boolean) {
		if (keepDraft) return;
		options.resetComposerUi?.();
	}

	/**
	 * 投递被拒时把原文回填草稿，供用户修改重发。
	 * keepDraft=true（快捷消息直发）时跳过：那段文字原本不在草稿里，回填会污染用户输入
	 * （弹框里点一下就能重发，代价远低于把用户写了一半的内容顶下去）。
	 */
	function restoreRejectedPrompt(targetSessionId: string, keepDraft: boolean, message: string, imageSnapshot?: ImageContent[], quoteSnapshot?: SessionQuoteMap) {
		if (keepDraft) return;
		restoreRejectedSnapshot(targetSessionId, message, imageSnapshot, quoteSnapshot);
	}

	return async function sendSessionPrompt(streamingBehavior?: "steer" | "followUp", overrideText?: string) {
		const sourceSessionId = options.sessionId;
		// atom 随 bootstrap 提升且跨 Composer 重挂载保留；局部 ref 只守当前实例。
		const existingSend = store.get(sessionSendStateByIdAtom)[sourceSessionId];
		if (sendingSessionIdsRef.current.has(sourceSessionId) || existingSend?.status === "activating" || existingSend?.status === "sending") return;

		// overrideText 有值 = 快捷消息直发：正文来自弹框条目而非当前草稿。
		// 这里固定三条约束（下面所有分支都靠 keepDraft 收口）：草稿/附件不参与本次发送、
		// 发送后不清空草稿、被拒时不回填草稿——用户可能正写到一半，直发一条「继续」
		// 把他的草稿清掉或把他贴的图一起发出去都不可接受。
		const keepDraft = overrideText !== undefined;
		const rawDraft = overrideText ?? store.get(sessionDraftByIdAtom)[sourceSessionId] ?? "";
		const attachmentSnapshot = keepDraft ? [] : (store.get(sessionAttachmentsByIdAtom)[sourceSessionId] ?? []);
		const imageSnapshot = attachmentSnapshot.length ? [...attachmentSnapshot] : undefined;
		if (!hasComposerSubmission(rawDraft, imageSnapshot)) return;
		// 引用展开唯一咽喉点（审计定稿）：后续乐观缓存/队列快照/历史记录全部消费自包含块文本，
		// #q token 永不出现在时间线气泡或发给 pi 的内容里。气泡只解析块的 label，模型仍读取全文。
		// 与斜杠命令混写时仍按普通消息继续走后续模板/会话引用展开（有意为之）。
		const quoteMap = store.get(sessionQuotesByIdAtom)[sourceSessionId];
		const message = expandQuoteTokens(rawDraft, (id) => quoteMap?.[id]) ?? rawDraft;
		// 只有引用没有任何正文/图片：引用是上下文不是消息，拦下并提示先写问题
		if (!stripQuoteTokens(rawDraft).trim() && !imageSnapshot) {
			options.showError?.(t("app.quoteNeedsQuestion"), 4000);
			return;
		}

		const recordAtEntry = store.get(sessionRecordsAtom)[sourceSessionId];
		const runtimeAtEntry = store.get(sessionRuntimeByIdAtom)[sourceSessionId];
		// DSH 运行能力已移除：历史 dsh 会话禁止发送/继续。原会话文件保留，
		// 渲染层对这类会话展示「运行时已移除」专态并提供路径定位入口。
		if (recordAtEntry?.backend === "dsh" || runtimeAtEntry?.backend === "dsh") {
			setSendState({ sessionId: sourceSessionId, state: { status: "error", error: t("session.dshRuntimeRemoved") } });
			options.showError?.(t("session.dshRuntimeRemoved"), 6000);
			return;
		}

		const resolveSendMode = (targetSessionId: string): ComposerAgentMode => {
			const record = store.get(sessionRecordsAtom)[targetSessionId];
			const liveRuntime = store.get(sessionRuntimeByIdAtom)[targetSessionId];
			return deriveComposerAgentMode({
				backend: "pi",
				localMode: store.get(sessionComposerModeByIdAtom)[targetSessionId],
				planModeActive: liveRuntime?.state?.planModeActive === true,
				alignmentPhase: liveRuntime?.state?.alignment?.phase,
				goalPhase: liveRuntime?.state?.goal?.phase,
			});
		};

		sendingSessionIdsRef.current.add(sourceSessionId);
		const requestId = crypto.randomUUID();
		const trimmedMessage = message.trim();
		// 接管类命令统一由纯函数分类：这里只分派，不再散落正则（见 utils/composerSlashCommand.ts）。
		const slashCommand = classifyComposerSlashCommand(trimmedMessage);
		if (slashCommand.kind === "login") {
			// `/login` 同样不是发给模型的消息：不写乐观用户气泡、不 ensureSessionId，
			// 也不占 sending 锁（弹框里的登录与后续发送互不干扰）。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			options.openProviderLogin?.(slashCommand.providerId);
			return;
		}
		const isNewCommand = slashCommand.kind === "new";
		const isCompactCommand = slashCommand.kind === "compact";
		if (isNewCommand) {
			// 不写乐观用户气泡、不 ensureSessionId：/new 是桌面 chrome，不是发给模型的消息。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			try {
				await options.createNewSession?.();
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				setSendState({
					sessionId: sourceSessionId,
					state: { status: "error", error: errorMessage },
				});
				options.showError?.(errorMessage, 4000);
			} finally {
				sendingSessionIdsRef.current.delete(sourceSessionId);
			}
			return;
		}
		const usesLocalQueue = Boolean(options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp"));

		// 首次发送的运行时启动可能包含 spawn/get_state/会话绑定；先发布用户可见状态，
		// 让输入反馈与后台准备解耦，避免用户把冷启动时间误判成点击无效。
		// 队列和 /compact 保留原路径，因为它们分别需要排队快照或运行时命令语义。
		const publishOptimisticSubmission = (targetSessionId: string) => {
			if (resolveSendMode(targetSessionId) === "alignment") beginAlignmentSubmission(store, targetSessionId, requestId);
			setSendState({
				sessionId: targetSessionId,
				state: { status: "activating", requestId },
			});
			clearComposerSnapshot(targetSessionId, keepDraft);
			const cacheEntry = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
			const previousMessages = cacheEntry?.messages ?? [];
			setCacheMessages({
				sessionId: targetSessionId,
				messages: [
					...previousMessages,
					{
						id: requestId,
						agentId: "",
						role: "user" as const,
						text: message,
						timestamp: Date.now(),
						images: imageSnapshot,
					},
				],
				source: "runtime" as const,
			});
			resetComposerEphemeralUi(keepDraft);
		};

		const publishBeforeActivation = !usesLocalQueue && !isCompactCommand;
		if (publishBeforeActivation) publishOptimisticSubmission(sourceSessionId);

		let sessionId = sourceSessionId;
		let trackedRecord = recordAtEntry;
		let submissionPublished = publishBeforeActivation;
		// 身份由来源会话与 requestId 决定，不由焦点或组件挂载决定：切栏仍可后台完成，
		// 删除/新请求接管后则禁止恢复草稿、回绑 runtime 或发布迟到状态。
		const isCurrentRequest = () => (!trackedRecord || Boolean(store.get(sessionRecordsAtom)[sessionId])) && (!submissionPublished || store.get(sessionSendStateByIdAtom)[sessionId]?.requestId === requestId);
		const releaseIfRetired = () => {
			if (isCurrentRequest()) return false;
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return true;
		};
		try {
			sessionId = options.ensureSessionId ? await options.ensureSessionId(sourceSessionId) : sourceSessionId;
		} catch (error) {
			if (releaseIfRetired()) return;
			// 普通发送已乐观清空草稿；队列与 /compact 尚未消费，不能重复回填。
			if (publishBeforeActivation) restoreRejectedPrompt(sourceSessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
			const errorMessage = error instanceof Error ? error.message : String(error);
			setSendState({
				sessionId: sourceSessionId,
				state: { status: "error", error: errorMessage },
			});
			options.showError?.(errorMessage, 4000);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}

		trackedRecord = store.get(sessionRecordsAtom)[sessionId] ?? trackedRecord;
		if (releaseIfRetired()) return;
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const runtimeTarget = runtime?.agentId
			? {
					sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
				}
			: undefined;
		const runtimeAgentId = runtimeTarget?.agentId;
		if (publishBeforeActivation && runtimeAgentId) {
			setSendState({
				sessionId,
				state: { status: "sending", requestId },
			});
			setCacheMessages({
				sessionId,
				messages: (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).map((item) => (item.id === requestId ? { ...item, agentId: runtimeAgentId } : item)),
				source: "runtime",
			});
		}
		if (isCompactCommand) {
			if (!runtimeAgentId) {
				// No Agent yet — let normal send path start Agent first;
				// pi will handle /compact command once active.
			} else {
				// 提示词由分类器统一剥离（`/compact` 后的内容按 pi 语义是自定义提示词）。
				const compactPrompt = slashCommand.kind === "compact" ? slashCommand.prompt : "";
				clearComposerSnapshot(sessionId, keepDraft);
				resetComposerEphemeralUi(keepDraft);
				try {
					await options.compact(runtimeTarget, compactPrompt || undefined);
				} finally {
					// /compact 是 chrome 命令，不能占用 sending 锁；否则后续消息被静默丢掉。
					sendingSessionIdsRef.current.delete(sourceSessionId);
				}
				return;
			}
		}

		// Queue shortcut: when the agent is busy, enqueue locally instead of sending through
		// the session API. The queue panel shows the pending item and drain dispatches it
		// through the appropriate flush path based on behavior:
		//   steer    → flushQueuedSteerPrompts (while agent is busy)
		//   followUp → flushNextQueuedPrompt (when agent becomes idle)
		if (options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp")) {
			const { message: expandedMessage, emptyTemplateName } = expandPromptTemplates(message, options.templates);
			if (emptyTemplateName) {
				// 展开器会保留空模板的 /命令原文，不能靠消息是否空白判断正文有效。
				sendingSessionIdsRef.current.delete(sourceSessionId);
				rejectEmptyTemplate(sessionId, emptyTemplateName);
				return;
			}
			const enqueued = options.enqueue(sessionId, {
				displayText: message,
				message: expandedMessage,
				images: imageSnapshot,
				agentMode: resolveSendMode(sessionId),
				behavior: streamingBehavior,
			});
			if (enqueued) {
				clearComposerSnapshot(sessionId, keepDraft);
				resetComposerEphemeralUi(keepDraft);
				sendingSessionIdsRef.current.delete(sourceSessionId);
				return;
			}
			// Queue full: fall through to direct send.
		}

		if (!publishBeforeActivation) {
			submissionPublished = true;
			if (resolveSendMode(sessionId) === "alignment") beginAlignmentSubmission(store, sessionId, requestId);
			setSendState({
				sessionId,
				state: {
					status: runtimeAgentId ? "sending" : "activating",
					requestId,
				},
			});
			clearComposerSnapshot(sessionId, keepDraft);

			// Special paths publish only after their runtime/session target is known.
			const cacheEntry = store.get(sessionMessagesCacheAtom)?.[sessionId];
			const previousMessages = cacheEntry?.messages ?? [];
			setCacheMessages({
				sessionId,
				messages: [
					...previousMessages,
					{
						id: requestId,
						agentId: runtimeAgentId ?? "",
						role: "user" as const,
						text: message,
						timestamp: Date.now(),
						images: imageSnapshot,
					},
				],
				source: "runtime" as const,
			});
			resetComposerEphemeralUi(keepDraft);
		}

		let preparedMessage = message;
		try {
			preparedMessage = options.prepareMessage ? await options.prepareMessage(message) : message;
		} catch (error) {
			if (releaseIfRetired()) return;
			// 拒绝时回填原始草稿（含 token），保留 chip 形态供用户修改重发
			restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
			const errorMessage = error instanceof Error ? error.message : String(error);
			// ensureSessionId 已把 composer 状态搬到真实会话；失败也必须结算同一身份。
			setSendState({
				sessionId,
				state: { status: "error", requestId, error: errorMessage },
			});
			options.showError?.(errorMessage, 4000);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}

		if (releaseIfRetired()) return;
		const { message: expandedMessage, description, emptyTemplateName } = expandPromptTemplates(preparedMessage, options.templates);
		if (emptyTemplateName) {
			// 展开器保留空模板的 /命令原文；按 verdict 拦截，避免误发到主进程。
			// 回填原始草稿（含引用 token），保留 chip 形态
			restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
			rejectEmptyTemplate(sessionId, emptyTemplateName);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}
		const record = store.get(sessionRecordsAtom)[sessionId];
		const liveRuntime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const sendMode: ComposerAgentMode = deriveComposerAgentMode({
			backend: "pi",
			localMode: store.get(sessionComposerModeByIdAtom)[sessionId],
			planModeActive: liveRuntime?.state?.planModeActive === true,
			alignmentPhase: liveRuntime?.state?.alignment?.phase,
			goalPhase: liveRuntime?.state?.goal?.phase,
		});
		const submission = buildComposerPromptSubmission(expandedMessage, sendMode);

		try {
			const result = await options.sendPrompt({
				sessionId,
				requestId,
				message: submission.message,
				...(imageSnapshot ? { images: imageSnapshot } : {}),
				...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
				...(description ? { description } : {}),
				...(streamingBehavior ? { streamingBehavior } : {}),
			});
			if (!isCurrentRequest()) return;
			const currentRuntime = store.get(sessionRuntimeByIdAtom)[sessionId];
			// 新代可来自本次启动；旧代/同代异进程不能回写运行时、路径或历史。
			// 但拒收/未知仍要按本请求结算，不能因换代丢掉草稿或未知投递提示。
			const staleRuntime = result.agentId && currentRuntime && ((result.runtimeGeneration !== undefined && result.runtimeGeneration < currentRuntime.runtimeGeneration) || ((result.runtimeGeneration ?? currentRuntime.runtimeGeneration) === currentRuntime.runtimeGeneration && currentRuntime.agentId !== result.agentId));
			if (staleRuntime && result.accepted) {
				setSendState({ sessionId, state: { status: "idle" } });
				return;
			}
			// 只有已接受的消息才开始新一轮；拒绝/未知投递不能折叠现有时间线。
			if (result.accepted) store.set(bumpNewTurnCollapseTickAtom, sessionId);
			if (result.agentId && !staleRuntime) {
				bindRuntime({
					sessionId,
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
					status: result.accepted ? "running" : undefined,
				});
			}

			const record = store.get(sessionRecordsAtom)[sessionId];
			if (record && result.accepted) {
				// DSH 的 sessionPath 是 host zstd，不能当 pi JSONL 写进 filePath。
				upsertSession({
					...record,
					...(record.backend === "dsh" || !result.sessionPath ? {} : { filePath: result.sessionPath }),
					status: "active",
					updatedAt: Date.now(),
				});
			}

			const outcome = classifySessionPromptResult(result);
			// toast 文案 = 本地化提示 + 具体原因：translateI18nDescriptor 命中通用 key 时
			// 只返回“消息发送失败。”这类概括，debugDetails（RPC 超时/pi 拒绝原文）必须带出，
			// 否则用户无从知道失败根因；同值去重、截断防 toast 过长。
			let deliveryError = "Prompt was not accepted";
			let toastMessage = deliveryError;
			if ("error" in result) {
				deliveryError = translateI18nDescriptor(result, result.error);
				const details = result.debugDetails && result.debugDetails !== deliveryError ? `（${result.debugDetails.length > 140 ? `${result.debugDetails.slice(0, 140)}…` : result.debugDetails}）` : "";
				toastMessage = `${deliveryError}${details}`;
			}
			if (outcome === "accepted") {
				options.recordPromptHistory?.(sessionId, message);
				setSendState({ sessionId, state: { status: "idle" } });
				if (record) options.refreshProject?.(record.projectId);
			} else if (outcome === "unknown") {
				setSendState({
					sessionId,
					state: {
						status: "unknown",
						requestId,
						error: deliveryError,
						unknownSnapshot: {
							message,
							...(imageSnapshot ? { images: imageSnapshot } : {}),
						},
					},
				});
				options.showUnknown?.();
			} else {
				// 拒绝时回填原始草稿（含 token）保留 chip 形态；unknown 快照仍存展开后文本（已实际投递的内容）
				restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
				setSendState({
					sessionId,
					state: { status: "error", requestId, error: deliveryError },
				});
				options.showError?.(toastMessage, 4000);
				// ACP 首启失败回收：激活从未成功（status 仍 draft，agent 侧会话未建、无任何消息）
				// 的 acp 会话是纯垃圾条目（-32602/spawn 失败都走这）——外层删会话并把回填后的
				// 草稿搬回引导页，不在历史列表留「xxx agent」空会话。prune 成功即结算：后续状态都指向已删会话。
			}
		} catch (error) {
			if (!isCurrentRequest()) return;
			setSendState({
				sessionId,
				state: {
					status: "unknown",
					requestId,
					error: error instanceof Error ? error.message : String(error),
					unknownSnapshot: {
						message,
						...(imageSnapshot ? { images: imageSnapshot } : {}),
					},
				},
			});
			options.showUnknown?.();
		} finally {
			sendingSessionIdsRef.current.delete(sourceSessionId);
		}
	};
}
