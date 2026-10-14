/**
 * 工作台材料 → 会话输入框的纯策略（P04）。
 *
 * 为什么独立成纯模块：按钮点击后的行为（追加不覆盖、按材料身份去重、跨会话隔离、
 * A 书迟到结果丢弃）必须能脱离 React 与 IPC 单测。hook 只负责读/写 atom 与调 IPC，
 * 判定全部在这里。
 *
 * 边界：
 * - 只改「目标会话」的草稿与引用快照仓；绝不发送、绝不调模型、绝不碰其他会话；
 * - 材料以 `#q<id>` 短 token + 会话级快照仓复用既有引用 chip 链路（发送期展开为材料块）；
 * - 目标会话 id 由调用方在点击当次固定传入（不读 currentSessionId，避免切会话串对象）。
 */

import type { PersonalTodoView } from "../../../shared/types/personalTodo";
import type { ReadingQuoteResult, ReadingSelectionSnapshot } from "../../../shared/types/reading";
import type { ReadingSegmentMaterial, ReadingSegmentVerify, TodoMaterial, WorkbenchMaterial } from "../../../shared/types/workbenchMaterial";
import { workbenchMaterialKey } from "../../../shared/types/workbenchMaterial";
import { buildDraftWithAppendedQuote, buildQuoteToken, createQuoteId, extractQuoteTokens, pruneUnreferencedQuotes, type QuoteSnippet } from "../components/session/composer/quoteChip";

/** 与 atoms/composer-atoms 的 SessionQuoteMap 同形；这里不 import jotai，保持纯模块可单测。 */
export type SessionQuoteMapLike = Record<string, QuoteSnippet>;

/** 阅读材料作用域：三件套缺一不可（没有 contentVersion 的材料无法证明属于哪一版正文）。 */
export type ReadingMaterialScope = { workId: string; editionId: string; contentVersion: string };

export function readingScopeKey(scope: ReadingMaterialScope | null): string {
	return scope ? `${scope.workId}\u0000${scope.editionId}\u0000${scope.contentVersion}` : "";
}

/** 材料是否属于当前阅读作用域（切书/换版本后旧材料不得当作新书材料登记）。 */
export function readingMaterialMatchesScope(material: ReadingSegmentMaterial, scope: ReadingMaterialScope | null): boolean {
	if (!scope) return false;
	return material.workId === scope.workId && material.editionId === scope.editionId && material.contentVersion === scope.contentVersion;
}

/**
 * A/B 迟到守卫：核验回包/材料构造带发起时的 epoch 与作用域，只有两者都与当前一致才接受。
 * 不一致一律丢弃（返回 false），调用方不得把它写进当前会话。
 */
export function shouldAcceptReadingMaterial(input: { epoch: number; currentEpoch: number; materialScope: ReadingMaterialScope; currentScope: ReadingMaterialScope | null }): boolean {
	if (input.epoch !== input.currentEpoch) return false;
	// readingScopeKey(null) 为空串，真实作用域三件套均非空 → 当前无作用域时必不等，自然丢弃。
	return readingScopeKey(input.materialScope) === readingScopeKey(input.currentScope);
}

/** 组装书段材料：偏移只在服务端核验通过时给出（P03 readingQuoteOffsets 已保证），否则 unverified。 */
/** 服务端核验状态 → 材料核验档位（exact/normalized 如实保留，其余一律 unverified）。 */
export function readingSegmentVerifyFromQuote(result: ReadingQuoteResult | null): ReadingSegmentVerify {
	if (result !== null && result.ok && result.status === "exact") return "exact";
	if (result !== null && result.ok && result.status === "normalized") return "normalized";
	return "unverified";
}

/**
 * 组装书段材料。
 *
 * `verify` 必须由调用方从服务端核验结果如实传入（`readingSegmentVerifyFromQuote`）：
 * 偏移只在 exact/normalized 时保留，unverified 时一律为 null（不拿「恰好有偏移」冒充核验状态）。
 */
export function createReadingSegmentMaterial(input: { snapshot: ReadingSelectionSnapshot; verify: ReadingSegmentVerify; workTitle?: string | null; editionTitle?: string | null; chapterTitle?: string | null; capturedAt?: string }): ReadingSegmentMaterial {
	const snapshot = input.snapshot;
	const hasOffsets = typeof snapshot.start === "number" && typeof snapshot.end === "number" && snapshot.end >= snapshot.start;
	const keepOffsets = input.verify !== "unverified" && hasOffsets;
	return {
		kind: "reading_segment",
		workId: snapshot.workId,
		editionId: snapshot.editionId,
		contentVersion: snapshot.contentVersion,
		workTitle: input.workTitle ?? null,
		editionTitle: input.editionTitle ?? null,
		chapterHref: snapshot.chapterHref,
		chapterNum: snapshot.chapterNum,
		chapterTitle: input.chapterTitle ?? null,
		start: keepOffsets ? snapshot.start : null,
		end: keepOffsets ? snapshot.end : null,
		verify: input.verify,
		text: snapshot.text,
		capturedAt: input.capturedAt ?? new Date().toISOString(),
	};
}

/**
 * 组装待办材料：身份与来源原样保留，不改状态、不执行任务。
 *
 * `subtodoId` 给了但找不到对应子项时返回 null（调用方拒绝带入并提示，不造半截材料）；
 * `view` 必须是根项视图（子项视图没有完整族身份，无法满足 root_revision 语义）。
 */
export function createTodoMaterial(input: { view: PersonalTodoView; subtodoId?: string | null; capturedAt?: string }): TodoMaterial | null {
	const item = input.view.item;
	if (!item.isRoot) return null;
	const subtodoId = input.subtodoId ?? null;
	const subtodo = subtodoId ? item.subtodos.find((entry) => entry.id === subtodoId) : null;
	if (subtodoId && !subtodo) return null;
	const subtodoText = subtodo?.text ?? null;
	const subtodoNote = subtodo?.note ?? null;
	const body = subtodoText === null ? item.title : `${item.title}\n\n${subtodoText}`;
	const note = subtodoNote ?? (subtodoText === null ? item.note : "");
	const text = note ? `${body}\n\n${note}` : body;
	return {
		kind: "todo",
		todoId: item.id,
		subtodoId: subtodo?.id ?? null,
		rootRevision: item.revision,
		title: item.title,
		note: item.note,
		subtodoText,
		subtodoNote,
		status: item.status,
		subtodoStatus: subtodo?.status ?? null,
		category: item.category,
		deadline: item.deadline,
		source: { kind: item.source.kind, namespace: item.source.namespace, sourceId: subtodo?.sourceId ?? item.source.sourceId },
		text,
		capturedAt: input.capturedAt ?? new Date().toISOString(),
	};
}

/** 已有材料快照（同身份且仍被草稿引用）时返回它，用于去重。 */
export function findMaterialSnippet(input: { quotes: SessionQuoteMapLike; draft: string; material: WorkbenchMaterial }): QuoteSnippet | null {
	const key = workbenchMaterialKey(input.material);
	const referenced = new Set(extractQuoteTokens(input.draft).map((occurrence) => occurrence.id));
	for (const snippet of Object.values(input.quotes)) {
		if (snippet.material && referenced.has(snippet.id) && workbenchMaterialKey(snippet.material) === key) return snippet;
	}
	return null;
}

export type MaterialAppendOutcome = {
	/** 追加/去重后的目标会话草稿（永远包含材料 token；不覆盖用户原文字）。 */
	draft: string;
	/** 追加/去重后的引用快照仓（已按草稿引用 prune）。 */
	quotes: SessionQuoteMapLike;
	snippetId: string;
	/** true = 同一材料已在该会话草稿里（未重复追加）。 */
	duplicate: boolean;
};

/**
 * 把材料追加进目标会话草稿与快照仓。
 *
 * - 追加语义（复用 buildDraftWithAppendedQuote）：用户已写文字原样保留，token 追加在末尾；
 * - 按材料身份去重：同一材料已在草稿中时只回报 duplicate，不再追加一个 chip；
 * - 只处理传入的 sessionId 状态：调用方传哪个会话的 draft/quotes 就只改它，天然跨会话隔离。
 */
export function appendWorkbenchMaterialToSessionState(input: { sessionId: string; draft: string; quotes: SessionQuoteMapLike; material: WorkbenchMaterial; now?: number; createId?: () => string }): MaterialAppendOutcome {
	const existing = findMaterialSnippet({ quotes: input.quotes, draft: input.draft, material: input.material });
	if (existing) {
		return { draft: input.draft, quotes: pruneQuotesForDraft(input.quotes, input.draft), snippetId: existing.id, duplicate: true };
	}
	const id = (input.createId ?? createQuoteId)();
	const snippet: QuoteSnippet = {
		id,
		text: input.material.text,
		// 材料不是 Pi 会话消息：不伪造 messageId（空串），展开走材料块。
		messageId: "",
		createdAt: input.now ?? Date.now(),
		material: input.material,
	};
	const draft = buildDraftWithAppendedQuote(input.draft, buildQuoteToken(id));
	const quotes = pruneQuotesForDraft({ ...input.quotes, [id]: snippet }, draft);
	return { draft, quotes, snippetId: id, duplicate: false };
}

/** 按草稿当前引用的 token 清理快照（用户删了 chip 就不会无限堆积）。 */
export function pruneQuotesForDraft(quotes: SessionQuoteMapLike, draft: string): SessionQuoteMapLike {
	return pruneUnreferencedQuotes(quotes, new Set(extractQuoteTokens(draft).map((occurrence) => occurrence.id)));
}
