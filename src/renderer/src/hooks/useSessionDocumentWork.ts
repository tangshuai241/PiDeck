import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import type { AgentBackend, AlignmentState, SessionRuntimeTarget } from "../../../shared/types";
import { shouldBlockDocumentApproval, shouldRouteRoundToDocumentWork } from "../../../shared/documentWorkTarget";
import type { DocumentWorkOutputRoot, DocumentWorkRecord, DocumentWorkSnapshot } from "../../../shared/types/documentWork";
import { documentWorkViewAtomFamily, emptyDocumentWorkView } from "../atoms/document-work-atoms";
import { alignmentSubmissionAtomFamily } from "../atoms/alignment-atoms";
import { sessionComposerModeBySessionIdAtomFamily } from "../atoms/composer-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/**
 * 会话级文稿域 owner。
 *
 * 覆盖方案要求的最小可用闭环：
 * 1. **首次实际提交建记录**：需求模式下的第一次真实提交（`alignmentSubmission`）落地后建工作记录，
 *    空模式不建；记录幂等，重复提交不会重复创建。
 * 2. **单聊天确认**：批准按钮先把"准备 + 分发"两步做完（绑定上下文、冻结基稿、持久化操作），
 *    再做原有的 `/align approve`；准备失败时界面直接说明原因，不进入执行。
 * 3. **自动归档回到聊天**：`document-work:changed` 推送到达就重拉有界快照，归档结果与检查结论
 *    直接显示在同一张卡里，不需要用户去找文件。
 * 4. **重开恢复**：挂载时先 `recover`，把磁盘上的工作与操作读回来（不自动重放执行）。
 *
 * 输出根只经系统目录选择器授权；图标/文案全部走 i18n；订阅在卸载时退订。
 */
export type SessionDocumentWorkControls = {
	/** 文稿能力可用（pi 后端）；**不代表本轮是文稿轮次**。 */
	available: boolean;
	/** 本轮是否被判定为正式文稿（由权威要求单推导）。 */
	documentRound: boolean;
	snapshot: DocumentWorkSnapshot | undefined;
	outputRoots: DocumentWorkOutputRoot[];
	pending: boolean;
	error: string | undefined;
	chooseOutputRoot: () => void;
	cancel: () => void;
	/**
	 * 对齐批准前的准备 + 分发。
	 *
	 * 三态（避免双重批准）：
	 * - `handled`：本轮文稿轮次已由**主进程**发出唯一一次批准，调用方不要再发原生 approve；
	 * - `proceed`：普通开发，走原生 approve（一次）；
	 * - `blocked`：本轮不能执行（缺成果目录/授权不符/运行时变化），调用方什么也不发。
	 */
	beforeApprove: (state: AlignmentState) => Promise<DocumentApprovalOutcome>;
};

export type DocumentApprovalOutcome = "handled" | "proceed" | "blocked";

export type DocumentWorkApprovalBridge = Pick<SessionDocumentWorkControls, "beforeApprove">;

function failureCopy(error: { code: string; detail?: string }): string {
	switch (error.code) {
		case "APPROVAL_REQUIRED":
			return t("documentWork.error.approvalRequired");
		case "RUNTIME_BUSY":
			return t("documentWork.error.busy");
		case "RUNTIME_CHANGED":
			return t("documentWork.error.runtimeChanged");
		case "PATH_DENIED":
			return t("documentWork.error.pathDenied");
		case "BASE_AMBIGUOUS":
			return t("documentWork.error.baseAmbiguous");
		case "PREPARATION_STALE":
			return t("documentWork.error.preparationStale");
		case "REVISION_CONFLICT":
			return t("documentWork.error.revisionConflict");
		case "EXTENSION_UNAVAILABLE":
			return t("documentWork.error.unavailable");
		default:
			return t("documentWork.error.generic", { code: error.code });
	}
}

export function useSessionDocumentWork(sessionId: string, backend: AgentBackend = "pi"): SessionDocumentWorkControls {
	const store = useStore();
	const viewAtom = documentWorkViewAtomFamily(sessionId);
	const view = useAtomValue(viewAtom);
	const setView = useSetAtom(viewAtom);
	const runtimeAtom = sessionRuntimeBySessionIdAtomFamily(sessionId);
	const submissionAtom = alignmentSubmissionAtomFamily(sessionId);
	const modeAtom = sessionComposerModeBySessionIdAtomFamily(sessionId);
	const creatingRef = useRef(false);

	const available = backend === "pi";
	const workId = view.snapshot?.work.workId;
	// 路由判据只来自权威要求单（不是 renderer 标志）：普通编码/解释/读材料一律走原生流程。
	const alignmentBrief = useAtomValue(runtimeAtom)?.state?.alignment?.brief;
	const roundRoute = shouldRouteRoundToDocumentWork({ backend, mode: useAtomValue(modeAtom), brief: alignmentBrief });
	const documentRound = roundRoute.route === "document";

	const refresh = useCallback(async () => {
		if (!available) return;
		const roots = await desktopApi.documentWork.listRoots().catch(() => []);
		const recovered = await desktopApi.documentWork.recover(sessionId).catch(() => undefined);
		const works = recovered && recovered.ok ? recovered.value.works : [];
		// 多件工作时不做"按时间猜一件"：取最近创建的一件显示，其余保持只读可见。
		const latest = works.length > 0 ? works[works.length - 1] : undefined;
		if (!latest) {
			setView({ loading: false, outputRoots: roots, pending: false });
			return;
		}
		const snapshot = await desktopApi.documentWork.get({ workId: latest.workId, sessionId }).catch(() => undefined);
		if (snapshot && snapshot.ok) setView({ loading: false, snapshot: snapshot.value, outputRoots: roots, pending: false });
		else setView({ loading: false, outputRoots: roots, pending: false });
	}, [available, sessionId, setView]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 主进程变更推送只作为"该刷新了"的信号；数据仍走有界快照读取。
	useEffect(() => {
		if (!available) return;
		const unsubscribe = desktopApi.documentWork.onChanged((event) => {
			if (event.sessionId !== sessionId) return;
			void (async () => {
				const snapshot = await desktopApi.documentWork.get({ workId: event.workId, sessionId }).catch(() => undefined);
				if (snapshot && snapshot.ok) setView((current) => ({ ...current, loading: false, snapshot: snapshot.value }));
				else void refresh();
			})();
		});
		return unsubscribe;
	}, [available, sessionId, setView, refresh]);

	/**
	 * 建记录：**只有本轮被判定为正式文稿**时才建。
	 *
	 * 普通项目开发（重构代码/修 bug/解释材料）即使在需求模式里也 0 个 create；
	 * 要求单还没发布（模型还在澄清）时也无从判断，按普通处理——模糊不强制归档。
	 */
	useEffect(() => {
		if (!available || !documentRound || view.loading || workId || creatingRef.current) return;
		const submission = store.get(submissionAtom);
		if (!submission) return;
		creatingRef.current = true;
		void (async () => {
			const created = await desktopApi.documentWork
				.create({
					requestId: `create_${submission.requestId}`,
					sessionId,
					// 建记录只登记来源；授权一律在 prepare/start 阶段从权威快照或真实用户轮次重新推导。
					sourceTurnId: submission.requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "turn",
					title: t("documentWork.defaultTitle"),
					outputRootId: "",
				})
				.catch(() => undefined);
			creatingRef.current = false;
			if (created && created.ok) await refresh();
		})();
	}, [available, documentRound, view.loading, workId, store, submissionAtom, sessionId, refresh]);

	/** 建记录（幂等）：批准前发现"本轮是文稿但还没记录"时补建。 */
	const ensureWork = useCallback(async (): Promise<DocumentWorkRecord | undefined> => {
		const existing = store.get(viewAtom).snapshot?.work;
		if (existing) return existing;
		const created = await desktopApi.documentWork
			.create({
				requestId: `create_${sessionId}_${Date.now().toString(36)}`,
				sessionId,
				sourceTurnId: `turn_${sessionId.slice(0, 24)}`,
				title: t("documentWork.defaultTitle"),
				outputRootId: "",
			})
			.catch(() => undefined);
		if (!created || !created.ok) return undefined;
		const snapshot = await desktopApi.documentWork.get({ workId: created.value.workId, sessionId }).catch(() => undefined);
		if (snapshot && snapshot.ok) setView((value) => ({ ...value, loading: false, snapshot: snapshot.value }));
		return created.value;
	}, [sessionId, setView, store, viewAtom]);

	const chooseOutputRoot = useCallback(() => {
		void (async () => {
			setView((current) => ({ ...current, pending: true, error: undefined }));
			const chosen = await desktopApi.documentWork.chooseRoot().catch(() => undefined);
			if (!chosen || !chosen.ok || chosen.value.cancelled) {
				// 取消不是错误；登记失败才是。
				const message = chosen && !chosen.ok ? failureCopy(chosen.error) : undefined;
				setView((current) => ({ ...current, pending: false, ...(message ? { error: message } : {}) }));
				if (message) showNotice(message);
				return;
			}
			const root = chosen.value;
			const current = store.get(viewAtom);
			const currentWork = current.snapshot?.work;
			if (!currentWork) {
				setView((value) => ({ ...value, pending: false, outputRoots: [...value.outputRoots, { outputRootId: root.outputRootId, path: root.path, label: root.label, registeredAt: Date.now() }] }));
				return;
			}
			const bound = await desktopApi.documentWork.setRoot({ workId: currentWork.workId, expectedRevision: currentWork.revision, outputRootId: root.outputRootId }).catch(() => undefined);
			if (bound && !bound.ok) {
				const message = failureCopy(bound.error);
				setView((value) => ({ ...value, pending: false, error: message }));
				showNotice(message);
				return;
			}
			await refresh();
		})();
	}, [refresh, setView, store, viewAtom]);

	const cancel = useCallback(() => {
		void (async () => {
			const current = store.get(viewAtom).snapshot;
			const operation = current?.operation;
			const runtime = store.get(runtimeAtom);
			if (!current || !operation || !runtime?.agentId) return;
			const target: SessionRuntimeTarget = { sessionId, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };
			const result = await desktopApi.documentWork.cancel({ requestId: operation.requestId, workId: current.work.workId, expectedRevision: current.work.revision, attemptId: operation.attemptId, expectedRuntime: target }).catch(() => undefined);
			if (result && !result.ok) showNotice(failureCopy(result.error));
			await refresh();
		})();
	}, [refresh, runtimeAtom, sessionId, store, viewAtom]);

	/**
	 * 批准前的准备 + 分发。
	 *
	 * 只有"本轮确定是正式文稿"才介入：普通开发直接放行，原生 approve 正常且只发一次，
	 * 既不建记录、不 prepare/start，也不要求成果目录。
	 */
	const beforeApprove = useCallback(
		async (state: AlignmentState): Promise<DocumentApprovalOutcome> => {
			if (!available) return "proceed";
			const brief = state.brief ?? alignmentBrief;
			const route = shouldRouteRoundToDocumentWork({ backend, mode: "alignment", brief });
			// 普通开发/解释/读材料：一行都不碰文稿，原生批准照发一次。
			if (route.route !== "document") return "proceed";
			const current = store.get(viewAtom);
			const work = current.snapshot?.work ?? (await ensureWork());
			if (!work) return "proceed";
			const gate = shouldBlockDocumentApproval({ route: "document", hasWork: true, hasOutputRoot: Boolean(work.outputRootId) });
			if (gate.block) {
				showNotice(t("documentWork.needOutputFolder"));
				return "blocked";
			}
			const runtime = store.get(runtimeAtom);
			if (!runtime?.agentId) {
				showNotice(t("documentWork.error.runtimeChanged"));
				return "blocked";
			}
			const target: SessionRuntimeTarget = { sessionId, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };
			setView((value) => ({ ...value, pending: true, error: undefined }));
			const prepared = await desktopApi.documentWork
				.prepare({
					requestId: `prepare_${state.briefId}_${state.revision}`,
					workId: work.workId,
					sessionId,
					expectedRevision: work.revision,
					kind: "create_document",
					requirementsRef: { kind: "alignment", briefId: state.briefId, revision: state.revision },
				})
				.catch(() => undefined);
			if (!prepared || !prepared.ok) {
				const message = prepared ? failureCopy(prepared.error) : t("documentWork.error.generic", { code: "IPC" });
				setView((value) => ({ ...value, pending: false, error: message }));
				showNotice(message);
				return "blocked";
			}
			const started = await desktopApi.documentWork
				.start({
					requestId: `start_${prepared.value.preparation.preparationId}`,
					workId: work.workId,
					sessionId,
					expectedRevision: prepared.value.workRevision,
					kind: "create_document",
					preparation: prepared.value.preparation,
					expectedRuntime: target,
					authorization: { kind: "alignment_confirmation", briefId: state.briefId, revision: state.revision },
				})
				.catch(() => undefined);
			if (!started || !started.ok) {
				const message = started ? failureCopy(started.error) : t("documentWork.error.generic", { code: "IPC" });
				setView((value) => ({ ...value, pending: false, error: message }));
				showNotice(message);
				return "blocked";
			}
			setView((value) => ({ ...value, pending: false }));
			// 主进程已经在 `start` 里发出了唯一一次 `/align approve`：调用方只同步状态，不再发原生批准。
			return "handled";
		},
		[available, alignmentBrief, backend, ensureWork, runtimeAtom, sessionId, setView, store, viewAtom],
	);

	return {
		available,
		documentRound,
		snapshot: view.snapshot,
		outputRoots: view.outputRoots,
		pending: view.pending,
		error: view.error,
		chooseOutputRoot,
		cancel,
		beforeApprove,
	};
}

export { emptyDocumentWorkView };
