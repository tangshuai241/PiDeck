/**
 * 「阅读材料带入会话」的窄控制器（P04 修正轮）：把点击当次来源身份、目标引用与 epoch 固定下来，
 * 在每个 await 之后重新校验，迟到完成一律丢弃。
 *
 * 修复的真实竞态：原实现先 await 新建会话，再调 binding.bind 但没带显式 ref——bind 退回 hook 的
 * 「当前作用域」，用户从 A 书切到 B 书期间完成的绑定会落到 B 上；而材料校验用的是点击时旧 props，
 * 拦不住这条路径。
 *
 * 规则：
 * - 点击时固定 source（work+edition+contentVersion+章节+选区快照）、目标 ref 与 epoch；
 * - 每个 await 后校验 `epoch` 与「当前 source 与点击时逐字段一致」；A→B→A 也因 epoch 递增被丢弃；
 * - bind 显式传点击时的 ref，绝不落进其它书；
 * - 迟到完成只丢弃：不写当前页状态、不改其它绑定、不往目标会话追加材料；
 *   已创建的新会话保留在目录里（不回滚/删除）；
 * - 同步带入必须在「快照属于当前身份」且「绑定会话仍存在」时才执行；stale 一律要求显式重绑；
 * - 来源/选区变化或卸载都会推进 epoch 并重置 picker/notice。
 */

import { useEffect, useRef, useState } from "react";
import type { ReadingQuoteResult, ReadingSelectionSnapshot } from "../../../shared/types/reading";
import type { SessionRecord } from "../../../shared/types/session";
import type { WorkbenchMaterial } from "../../../shared/types/workbenchMaterial";
import type { TranslationKey } from "../i18n";
import { createReadingSegmentMaterial, readingMaterialMatchesScope, readingSegmentVerifyFromQuote } from "../utils/workbenchMaterialSession";
import type { ReadingSessionBindingController } from "./useReadingSessionBinding";

export type ReadingMaterialBringSource = {
	workId: string;
	editionId: string;
	contentVersion: string | null;
	chapterHref: string;
	chapterNum: number | null;
	workTitle: string | null;
	editionTitle: string | null;
	chapterTitle: string | null;
	selection: { snapshot: ReadingSelectionSnapshot | null; quote: ReadingQuoteResult | null };
	projectId?: string;
};

export type ReadingMaterialBringDeps = {
	binding: ReadingSessionBindingController;
	appendMaterial: (input: { sessionId: string; material: WorkbenchMaterial }) => { duplicate: boolean };
	createDraft: (input: { projectId: string; title: string }) => Promise<SessionRecord>;
	registerSession: (session: SessionRecord) => void;
	/** 当前目录里的会话查询：确认绑定目标/待追加目标现在仍存在（不单凭上次 resolve 的 sessionExists）。 */
	readSession: (sessionId: string) => { id: string; projectId: string } | null;
	/** 新建会话标题（i18n 由组件注入，hook 不直接取词条）。 */
	newSessionTitle: () => string;
};

export type ReadingMaterialBringNotice = "brought" | "duplicate" | "bound" | "created";

export type ReadingMaterialBringController = {
	pickerOpen: boolean;
	picked: string | null;
	busy: boolean;
	notice: ReadingMaterialBringNotice | null;
	createdSessionId: string | null;
	errorKey: TranslationKey | null;
	openPicker: () => void;
	closePicker: () => void;
	selectTarget: (sessionId: string) => void;
	/** 同步带入绑定会话；stale/快照不属于当前身份时拒绝并给出错误。 */
	bringToBound: () => void;
	/** 绑定并带入指定会话（显式传点击时的来源 ref）。 */
	bindAndBring: (target: { sessionId: string; projectId: string }) => void;
	/** 新建会话并在仍属当前来源时绑定+带入；已创建的会话永不删除。 */
	createAndBind: () => void;
	unbindBound: () => void;
	resetNotice: () => void;
};

type BringState = {
	pickerOpen: boolean;
	picked: string | null;
	busy: boolean;
	notice: ReadingMaterialBringNotice | null;
	createdSessionId: string | null;
	errorKey: TranslationKey | null;
};

const INITIAL_STATE: BringState = { pickerOpen: false, picked: null, busy: false, notice: null, createdSessionId: null, errorKey: null };

/**
 * 点击当次来源身份：项目 + 版本 + 章节 + 选区快照（身份/偏移/原文/核验档位）。
 * 不假定 capturedAt 唯一：offset 或核验档位变化同样构成新来源，旧完成必须作废。
 */
export function readingBringSourceKey(source: ReadingMaterialBringSource): string {
	const snapshot = source.selection.snapshot;
	const quoteStatus = source.selection.quote !== null && source.selection.quote.ok ? source.selection.quote.status : "";
	return [
		source.projectId ?? "",
		source.workId,
		source.editionId,
		source.contentVersion ?? "",
		source.chapterHref,
		source.chapterNum ?? "",
		snapshot?.workId ?? "",
		snapshot?.editionId ?? "",
		snapshot?.contentVersion ?? "",
		snapshot?.capturedAt ?? "",
		snapshot?.start ?? "u",
		snapshot?.end ?? "u",
		snapshot?.text ?? "",
		quoteStatus,
	].join("\u0000");
}

/**
 * 从来源快照组装材料；快照缺失、版本/章节不符或与来源书目不符时返回 null（拒绝冒充）。
 * 章节必须逐字段对齐：旧章的选区不得套上新章的标题/身份。
 */
export function readingMaterialFromSource(source: ReadingMaterialBringSource): WorkbenchMaterial | null {
	const snapshot = source.selection.snapshot;
	if (!snapshot || source.contentVersion === null) return null;
	if (snapshot.chapterHref !== source.chapterHref || snapshot.chapterNum !== source.chapterNum) return null;
	const material = createReadingSegmentMaterial({
		snapshot,
		verify: readingSegmentVerifyFromQuote(source.selection.quote),
		workTitle: source.workTitle,
		editionTitle: source.editionTitle,
		chapterTitle: source.chapterTitle,
	});
	if (!readingMaterialMatchesScope(material, { workId: source.workId, editionId: source.editionId, contentVersion: source.contentVersion })) return null;
	return material;
}

export function useReadingMaterialBring(source: ReadingMaterialBringSource, deps: ReadingMaterialBringDeps): ReadingMaterialBringController {
	const [state, setState] = useState<BringState>(INITIAL_STATE);
	// 最新来源与 epoch：异步回包只在「仍是同一来源（逐字段）且 epoch 未推进」时生效。
	const sourceRef = useRef(source);
	sourceRef.current = source;
	const epochRef = useRef(0);
	const sourceKey = readingBringSourceKey(source);

	useEffect(() => {
		// 来源/选区/章节任一变化：推进 epoch（旧完成作废）并重置交互态
		epochRef.current += 1;
		setState(INITIAL_STATE);
		return () => {
			// 卸载同样作废在飞完成
			epochRef.current += 1;
		};
	}, [sourceKey]);

	const isCurrent = (key: string, epoch: number): boolean => epochRef.current === epoch && readingBringSourceKey(sourceRef.current) === key;

	const appendTo = (sessionId: string, material: WorkbenchMaterial, notice: ReadingMaterialBringNotice): boolean => {
		try {
			const report = deps.appendMaterial({ sessionId, material });
			setState((prev) => ({ ...prev, pickerOpen: false, picked: null, notice: report.duplicate ? "duplicate" : notice, errorKey: null }));
			return true;
		} catch {
			fail("workbenchMaterial.errorMaterial");
			return false;
		}
	};

	const fail = (errorKey: TranslationKey): void => {
		setState((prev) => ({ ...prev, errorKey }));
	};

	const bringToBound = (): void => {
		const current = sourceRef.current;
		const material = readingMaterialFromSource(current);
		if (!material) {
			fail("workbenchMaterial.errorMaterial");
			return;
		}
		const binding = deps.binding.state;
		// 同步带入：绑定必须仍存在、仍属于当前书目/版本、且会话现在仍在目录里；
		// stale 一律走显式重绑，不静默替换。
		if (!binding.binding || !binding.sessionExists || binding.binding.workId !== current.workId || binding.binding.editionId !== current.editionId || !deps.readSession(binding.binding.sessionId)) {
			fail("workbenchMaterial.errorBindUnavailable");
			return;
		}
		appendTo(binding.binding.sessionId, material, "brought");
	};

	const bindAndBring = (target: { sessionId: string; projectId: string }): void => {
		const current = sourceRef.current;
		const material = readingMaterialFromSource(current);
		if (!material) {
			fail("workbenchMaterial.errorMaterial");
			return;
		}
		const ref = { workId: current.workId, editionId: current.editionId };
		const key = readingBringSourceKey(current);
		const epoch = epochRef.current;
		setState((prev) => ({ ...prev, busy: true, errorKey: null }));
		void (async () => {
			try {
				const bound = await deps.binding.bind({ sessionId: target.sessionId, projectId: target.projectId, ref });
				if (!isCurrent(key, epoch)) return; // 迟到完成：不改当前页、不带入材料
				if (!bound.ok) {
					fail(bound.error.code === "invalidInput" ? "workbenchMaterial.errorBindUnavailable" : "workbenchMaterial.errorBind");
					return;
				}
				// bind 成功后目标可能已在目录里消失（被删/切项目）：不得写入未知会话
				if (!deps.readSession(target.sessionId)) {
					fail("workbenchMaterial.errorBindUnavailable");
					return;
				}
				appendTo(target.sessionId, material, "bound");
			} catch {
				// bind/append 抛错（IPC 拒绝等）也必须是结构化结果，不得化成 unhandled rejection
				if (isCurrent(key, epoch)) fail("workbenchMaterial.errorBind");
			} finally {
				if (isCurrent(key, epoch)) setState((prev) => ({ ...prev, busy: false }));
			}
		})();
	};

	const createAndBind = (): void => {
		const current = sourceRef.current;
		if (!current.projectId) return;
		const material = readingMaterialFromSource(current);
		if (!material) {
			fail("workbenchMaterial.errorMaterial");
			return;
		}
		const projectId = current.projectId;
		const ref = { workId: current.workId, editionId: current.editionId };
		const key = readingBringSourceKey(current);
		const epoch = epochRef.current;
		setState((prev) => ({ ...prev, busy: true, errorKey: null }));
		void (async () => {
			try {
				const session = await deps.createDraft({ projectId, title: deps.newSessionTitle() });
				// 已创建的会话保留在目录里（无论本次完成是否仍属当前来源，都不删除/回滚）
				deps.registerSession(session);
				if (!isCurrent(key, epoch)) return; // 来源已切换：不绑定、不带入、不改当前页
				const bound = await deps.binding.bind({ sessionId: session.id, projectId: session.projectId, ref });
				if (!isCurrent(key, epoch)) return;
				if (!bound.ok) {
					fail("workbenchMaterial.errorBind");
					return;
				}
				// 新会话虽然刚登记，仍以目录现状为准（登记失败/被外部清掉时不得写入）
				if (!deps.readSession(session.id)) {
					fail("workbenchMaterial.errorBind");
					return;
				}
				const report = deps.appendMaterial({ sessionId: session.id, material });
				setState((prev) => ({ ...prev, pickerOpen: false, picked: null, notice: report.duplicate ? "duplicate" : "created", createdSessionId: session.id }));
			} catch {
				if (isCurrent(key, epoch)) fail("workbenchMaterial.errorCreate");
			} finally {
				if (isCurrent(key, epoch)) setState((prev) => ({ ...prev, busy: false }));
			}
		})();
	};

	const unbindBound = (): void => {
		const current = sourceRef.current;
		void deps.binding.unbind({ workId: current.workId, editionId: current.editionId });
		setState((prev) => ({ ...prev, notice: null, createdSessionId: null }));
	};

	const openPicker = (): void => setState((prev) => ({ ...prev, pickerOpen: true, picked: null, errorKey: null }));
	const closePicker = (): void => setState((prev) => ({ ...prev, pickerOpen: false, picked: null }));
	const selectTarget = (sessionId: string): void => setState((prev) => ({ ...prev, picked: sessionId }));
	const resetNotice = (): void => setState((prev) => ({ ...prev, notice: null, errorKey: null }));

	return { ...state, openPicker, closePicker, selectTarget, bringToBound, bindAndBring, createAndBind, unbindBound, resetNotice };
}
