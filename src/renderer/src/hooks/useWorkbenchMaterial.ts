/**
 * 工作台材料 → 目标会话输入框（P04 hook）。
 *
 * 职责边界（守 P04 核心约束）：
 * - 只做「把用户选中的书段/待办追加到明确目标会话的草稿与引用快照仓」，绝不发送、
 *   绝不调用模型、绝不自动勾选/执行任务；
 * - 目标会话 id 由调用方传入（点击当次快照），不读 currentSessionId——切会话/切书后
 *   发起对象材料仍属于发起时那个会话，不会写进当前会话，也不覆盖目标会话原有文字；
 * - 判定逻辑全部在纯模块 `utils/workbenchMaterialSession`，本 hook 只负责读写 atom。
 */

import { useCallback } from "react";
import { useStore } from "jotai";
import { sessionDraftByIdAtom, sessionQuotesByIdAtom, setSessionDraftAtom, setSessionQuotesAtom } from "../atoms/composer-atoms";
import type { WorkbenchMaterial } from "../../../shared/types/workbenchMaterial";
import { appendWorkbenchMaterialToSessionState } from "../utils/workbenchMaterialSession";

export type WorkbenchMaterialAppendReport = {
	sessionId: string;
	snippetId: string;
	/** true = 该材料已在此会话草稿中，本次未重复追加。 */
	duplicate: boolean;
};

export function useWorkbenchMaterial() {
	const store = useStore();

	const appendMaterial = useCallback(
		(input: { sessionId: string; material: WorkbenchMaterial; now?: number; createId?: () => string }): WorkbenchMaterialAppendReport => {
			const drafts = store.get(sessionDraftByIdAtom);
			const quoteMaps = store.get(sessionQuotesByIdAtom);
			const outcome = appendWorkbenchMaterialToSessionState({
				sessionId: input.sessionId,
				draft: drafts[input.sessionId] ?? "",
				quotes: quoteMaps[input.sessionId] ?? {},
				material: input.material,
				now: input.now,
				createId: input.createId,
			});
			// 只写目标会话条目：不触碰其他会话的草稿/快照，不读当前会话。
			store.set(setSessionDraftAtom, { sessionId: input.sessionId, value: outcome.draft });
			store.set(setSessionQuotesAtom, { sessionId: input.sessionId, value: outcome.quotes });
			return { sessionId: input.sessionId, snippetId: outcome.snippetId, duplicate: outcome.duplicate };
		},
		[store],
	);

	return { appendMaterial };
}
