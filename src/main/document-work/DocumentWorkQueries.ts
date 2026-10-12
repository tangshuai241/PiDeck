/**
 * 只读查询：工作快照、会话工作列表、真实用户轮。
 *
 * 抽出来的原因：`DocumentWorkService` 只该表达写事务与授权顺序；这些读取没有副作用，
 * 也不参与锁，独立成模块后可以被 IPC 与恢复路径共用。
 */
import type { ChatMessage } from "../../shared/types";
import type { DocumentWorkRecord, DocumentWorkView } from "../../shared/types/documentWork";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import type { DocumentWorkRuntimeAdapter } from "./DocumentWorkRuntimeAdapter";
import { hashTurnText } from "./documentWorkTurn";

export type UserTurn = { sourceTurnId: string; hash: string; text: string };

export class DocumentWorkQueries {
	constructor(
		private readonly store: DocumentWorkStore,
		private readonly runtime: DocumentWorkRuntimeAdapter,
	) {}

	/** 真实用户当前轮：正文 + 指纹 + 稳定消息 id，授权判定只认它。 */
	async latestUserTurn(sessionId: string): Promise<UserTurn | undefined> {
		const snapshot = await this.runtime.snapshot(sessionId);
		if (!snapshot) return undefined;
		const message: ChatMessage | undefined = [...snapshot.messages].reverse().find((candidate) => candidate.role === "user");
		if (!message) return undefined;
		const text = message.text;
		return { sourceTurnId: message.id, hash: hashTurnText(text), text };
	}

	async readView(workId: string, sessionId: string): Promise<DocumentWorkView | undefined> {
		const record = await this.store.getRecord(workId);
		if (!record || record.sessionId !== sessionId) return undefined;
		const view = await this.viewOf(record);
		return view.ok ? view.value : undefined;
	}

	async listForSession(sessionId: string): Promise<DocumentWorkView[]> {
		const views: DocumentWorkView[] = [];
		for (const workId of await this.store.listWorkIdsForSession(sessionId)) {
			const view = await this.readView(workId, sessionId);
			if (view) views.push(view);
		}
		return views;
	}

	async viewOf(record: DocumentWorkRecord): Promise<{ ok: true; value: DocumentWorkView } | { ok: false; error: { code: "IO_ERROR"; retryable: boolean; detail?: string } }> {
		const versions = await this.store.listVersions(record.workId, record.versionIds);
		const outputRoot = await this.store.getOutputRoot(record.outputRootId);
		const activeOperation = record.activeRequestId ? await this.store.getOperation(record.workId, record.activeRequestId) : undefined;
		const values: DocumentWorkView["versions"] = versions
			.map((version) => {
				const primary = version.artifacts.find((artifact) => artifact.role === "primary");
				return {
					versionId: version.versionId,
					ordinal: version.ordinal,
					title: version.title,
					fileName: primary?.relativePath ?? "",
					inspection: version.inspection?.status ?? ("pending" as const),
					userAcceptance: version.userAcceptance,
					...(version.baseVersionId ? { baseVersionId: version.baseVersionId } : {}),
					manualModification: Boolean(version.manualModification),
					createdAt: version.createdAt,
				};
			})
			.sort((left, right) => right.ordinal - left.ordinal);
		return {
			ok: true,
			value: {
				workId: record.workId,
				sessionId: record.sessionId,
				revision: record.revision,
				title: record.title,
				outputRootLabel: outputRoot?.label ?? "",
				requirementsSummary: record.requirementsSummary,
				active: activeOperation ? { attemptId: activeOperation.attemptId, kind: activeOperation.kind, phase: activeOperation.phase, authorizationState: activeOperation.authorizationState, ...(activeOperation.error ? { error: activeOperation.error } : {}) } : null,
				versions: values,
				revisionReady: versions.some((version) => version.inspection?.status === "passed"),
			},
		};
	}
}
