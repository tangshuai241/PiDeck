import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { DocumentWorkOutputRoot, DocumentWorkSnapshot } from "../../../shared/types/documentWork";

/** 会话级的文稿界面投影：每个会话（含分屏的每一栏）各自一份，互不串台。 */
export type DocumentWorkViewState = {
	/** 首次读取完成前为 true；避免把"还没读到"画成"没有文稿"。 */
	loading: boolean;
	snapshot?: DocumentWorkSnapshot;
	outputRoots: DocumentWorkOutputRoot[];
	/** 最近一次操作失败的用户可读原因（i18n 之后）。 */
	error?: string;
	/** 有准备/分发在途：界面据此禁用重复点击。 */
	pending: boolean;
};

export const emptyDocumentWorkView: DocumentWorkViewState = { loading: true, outputRoots: [], pending: false };

/**
 * 按 sessionId 隔离（规则「多实例按 session 订阅」）：分屏的另一栏只订自己的
 * sessionId，不会因为本栏的文稿状态变化重渲染。
 */
export const documentWorkViewAtomFamily = atomFamily((_sessionId: string) => atom<DocumentWorkViewState>(emptyDocumentWorkView));

/** 变更推送到达时用来强制刷新快照的计数（不做全量数据搬运，快照仍由 hook 拉取）。 */
export const documentWorkChangeTickAtomFamily = atomFamily((_sessionId: string) => atom(0));
