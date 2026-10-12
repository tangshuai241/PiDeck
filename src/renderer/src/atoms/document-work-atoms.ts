import { atom, type createStore } from "jotai";
import { atomFamily } from "jotai/utils";
import type { DocumentWorkView, PreparedWork, SessionRuntimeTriple } from "../../../shared/types/documentWork";

/** 会话级文稿投影：主进程是事实源，这里只缓存最近一次读取结果。 */
export const documentWorkViewAtomFamily = atomFamily((_sessionId: string) => atom<DocumentWorkView | null>(null));

export type DocumentWorkPhase = "idle" | "creating" | "preparing" | "starting" | "cancelling";
export const documentWorkPhaseAtomFamily = atomFamily((_sessionId: string) => atom<DocumentWorkPhase>("idle"));

export type DocumentWorkFailure = { code: string; retryable: boolean; currentRevision?: number };
export const documentWorkErrorAtomFamily = atomFamily((_sessionId: string) => atom<DocumentWorkFailure | undefined>(undefined));

/** 本轮已授权材料的显示名（路径只留在主进程，不进入渲染层状态）。 */
export const documentWorkMaterialsAtomFamily = atomFamily((_sessionId: string) => atom<string[]>([]));

/** 首次提交后待建立的工作：等用户选定输出根再真正建记录。 */
export type PendingWorkCreation = { sourceTurnId: string; title?: string };
export const pendingWorkCreationAtomFamily = atomFamily((_sessionId: string) => atom<PendingWorkCreation | undefined>(undefined));

/** 已准备但可能尚未开始的本轮准备；用于卡片显示与取消。 */
export type ActivePreparation = { preparation: PreparedWork; runtime: SessionRuntimeTriple; authorizationKind: "alignment_confirmation" | "revision_instruction" };
export const activePreparationAtomFamily = atomFamily((_sessionId: string) => atom<ActivePreparation | undefined>(undefined));

/** 用户显式开启的改稿模式：只有它打开时，普通聊天里发送的要求才会被当成改稿轮。 */
export const documentWorkRevisionModeAtomFamily = atomFamily((_sessionId: string) => atom(false));

/** 主进程推送的变化事件落点：只保留本会话的最近一条，避免无界增长。 */
export type DocumentWorkChange = { workId: string; changeKind: string; revision: number; attemptId?: string };
export const documentWorkChangeAtomFamily = atomFamily((_sessionId: string) => atom<DocumentWorkChange | undefined>(undefined));

/** 清理整会话状态：切换/删除会话时调用，避免旧会话状态被当成当前状态。 */
export function resetDocumentWorkSession(store: ReturnType<typeof createStore>, sessionId: string): void {
	store.set(documentWorkViewAtomFamily(sessionId), null);
	store.set(documentWorkPhaseAtomFamily(sessionId), "idle");
	store.set(documentWorkErrorAtomFamily(sessionId), undefined);
	store.set(documentWorkMaterialsAtomFamily(sessionId), []);
	store.set(pendingWorkCreationAtomFamily(sessionId), undefined);
	store.set(activePreparationAtomFamily(sessionId), undefined);
	store.set(documentWorkRevisionModeAtomFamily(sessionId), false);
	store.set(documentWorkChangeAtomFamily(sessionId), undefined);
}
