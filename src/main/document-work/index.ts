/**
 * 文稿域装配：把存储、归档、检查、运行时适配与 pi 事件观察接到一起。
 *
 * 这里只做装配与事件适配，不做业务判断：
 * - 对齐快照与扩展状态都从既有主进程 pi 事件流读取，不开第二条通道；
 * - 改稿意图由扩展声明、由主进程用「最新用户轮正文指纹」复核后才 prepare/start；
 * - 所有订阅在 dispose 里成对解除。
 */
import { join } from "node:path";
import { parseAlignmentState, ALIGNMENT_MESSAGE_TYPE } from "../../shared/alignment";
import { extensionStateMatchesBinding, parseDocumentWorkExtensionState, parseSessionRuntimeTriple, sameRuntimeTriple, workFailure, stableStringify, type WorkResult } from "../../shared/documentWork";
import { hashText } from "./documentWorkPaths";
import type { AlignmentState } from "../../shared/types/alignment";
import type { AgentRuntimeState, AgentStatus } from "../../shared/types/agent";
import type { DocumentWorkExtensionState, PreparedWork, SessionRuntimeTriple, StartWorkInput } from "../../shared/types/documentWork";
import { DocumentArtifactStore } from "./DocumentArtifactStore";
import { DocumentInspectionService } from "./DocumentInspectionService";
import { DocumentWorkRuntimeAdapter, runtimeTripleOf, type DocumentWorkRuntimePort } from "./DocumentWorkRuntimeAdapter";
import { DocumentWorkService, hashTurnText, type DocumentWorkLogger, type MaterialResolver } from "./DocumentWorkService";
import { DocumentWorkStore } from "./DocumentWorkStore";

export const DOCUMENT_WORK_REVISION_INTENT_TYPE = "pi-deck-document-revision-intent";

type RevisionIntent = { workId: string; instruction: string; sections: string[]; preserve: string[]; sourceTurnId: string; sourceTurnHash: string };

/** 解析扩展声明的改稿意图；字段不全或越界即判非法。 */
export function parseRevisionIntent(value: unknown): RevisionIntent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const workId = Reflect.get(value, "workId");
	const instruction = Reflect.get(value, "instruction");
	const sourceTurnId = Reflect.get(value, "sourceTurnId");
	const sourceTurnHash = Reflect.get(value, "sourceTurnHash");
	if (typeof workId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(workId)) return undefined;
	if (typeof instruction !== "string" || instruction.length > 2000 || instruction.trim().length === 0) return undefined;
	if (typeof sourceTurnId !== "string" || sourceTurnId.length === 0 || sourceTurnId.length > 200) return undefined;
	if (typeof sourceTurnHash !== "string" || !/^[0-9a-f]{64}$/.test(sourceTurnHash)) return undefined;
	const sections = Array.isArray(Reflect.get(value, "sections")) ? Reflect.get(value, "sections") : [];
	const preserve = Array.isArray(Reflect.get(value, "preserve")) ? Reflect.get(value, "preserve") : [];
	const bounded = (list: unknown): string[] | undefined => (Array.isArray(list) && list.length <= 24 && list.every((item) => typeof item === "string" && item.length <= 200) ? [...(list as string[])] : undefined);
	const boundedSections = bounded(sections);
	const boundedPreserve = bounded(preserve);
	if (!boundedSections || !boundedPreserve) return undefined;
	return { workId, instruction, sections: boundedSections, preserve: boundedPreserve, sourceTurnId, sourceTurnHash };
}

export type DocumentWorkDomainDeps = {
	userDataPath: string;
	runtimePort: DocumentWorkRuntimePort;
	materials: MaterialResolver;
	onChanged: (event: { workId: string; sessionId: string; revision: number; changeKind: string; attemptId?: string }) => void;
	logger?: DocumentWorkLogger;
	bindTimeoutMs?: number;
	settleTimeoutMs?: number;
	startTimeoutMs?: number;
};

export type DocumentWorkDomain = {
	store: DocumentWorkStore;
	artifacts: DocumentArtifactStore;
	inspection: DocumentInspectionService;
	runtime: DocumentWorkRuntimeAdapter;
	service: DocumentWorkService;
	/** pi 事件入口（含扩展汇报与对齐快照）。 */
	observePiEvent(agentId: string, event: unknown): void;
	/** 运行时状态入口：缓存对齐快照并驱动稳定完成判据。 */
	observeRuntimeState(payload: unknown): void;
	/** 会话三元组变化（stop/restart/删会话）时清理本域缓存。 */
	forgetAgent(agentId: string): void;
	dispose(): Promise<void>;
};

export function createDocumentWorkDomain(deps: DocumentWorkDomainDeps): DocumentWorkDomain {
	const store = new DocumentWorkStore(join(deps.userDataPath, "document-work"), deps.logger);
	const artifacts = new DocumentArtifactStore(join(deps.userDataPath, "document-work"));
	const inspection = new DocumentInspectionService();
	const runtime = new DocumentWorkRuntimeAdapter(deps.runtimePort);
	const service = new DocumentWorkService({
		store,
		artifacts,
		inspection,
		runtime,
		materials: deps.materials,
		onChanged: (event) => deps.onChanged(event),
		...(deps.logger ? { logger: deps.logger } : {}),
		...(deps.bindTimeoutMs !== undefined ? { bindTimeoutMs: deps.bindTimeoutMs } : {}),
		...(deps.settleTimeoutMs !== undefined ? { settleTimeoutMs: deps.settleTimeoutMs } : {}),
		...(deps.startTimeoutMs !== undefined ? { startTimeoutMs: deps.startTimeoutMs } : {}),
	});
	const agentSessions = new Map<string, string>();
	const intentsBySession = new Map<string, string>();
	const unsubscribers: Array<() => void> = [];
	runtime.start();
	unsubscribers.push(runtime.subscriber((agentId, event) => observePiEvent(agentId, event)));

	function observePiEvent(agentId: string, event: unknown): void {
		if (typeof event !== "object" || event === null) return;
		const type = Reflect.get(event, "type");
		if (type !== "message_end") return;
		const sessionId = typeof Reflect.get(event, "sessionId") === "string" ? (Reflect.get(event, "sessionId") as string) : agentSessions.get(agentId);
		const message = Reflect.get(event, "message");
		if (!sessionId || typeof message !== "object" || message === null) return;
		const customType = Reflect.get(message, "customType");
		if (customType === ALIGNMENT_MESSAGE_TYPE) {
			const details = Reflect.get(message, "details");
			const alignment = details && typeof details === "object" ? Reflect.get(details, "alignment") : undefined;
			const parsed = parseAlignmentState(alignment);
			service.observeAlignmentState(sessionId, parsed ?? null);
			return;
		}
		const details = Reflect.get(message, "details");
		if (typeof details !== "object" || details === null) return;
		if (customType === "pi-deck-document-work-state") {
			const state = parseDocumentWorkExtensionState(Reflect.get(details, "documentWork"));
			if (state) service.observeExtensionState(sessionId, state);
			return;
		}
		if (customType === DOCUMENT_WORK_REVISION_INTENT_TYPE) {
			const intent = parseRevisionIntent(Reflect.get(details, "documentWorkIntent"));
			if (intent) void handleRevisionIntent(sessionId, intent);
		}
	}

	function observeRuntimeState(payload: unknown): void {
		const triple = runtimeTripleOf(payload);
		if (!triple || typeof payload !== "object" || payload === null) return;
		const state = Reflect.get(payload, "state");
		if (typeof state !== "object" || state === null) return;
		agentSessions.set(triple.agentId, triple.sessionId);
		const status = Reflect.get(payload, "status");
		runtime.note(triple, typeof status === "string" ? (status as AgentStatus) : undefined, state as AgentRuntimeState);
		const alignment = Reflect.get(state, "alignment");
		if (alignment === null) service.observeAlignmentState(triple.sessionId, null);
		else if (alignment !== undefined) {
			const parsed: AlignmentState | undefined = parseAlignmentState(alignment);
			if (parsed) service.observeAlignmentState(triple.sessionId, parsed);
		}
	}

	/**
	 * 改稿意图 → 准备 → 开始。授权来源是该轮真实用户指令：
	 * 主进程重新读取最新用户轮并核对正文指纹，扩展文本本身不构成授权。
	 */
	async function handleRevisionIntent(sessionId: string, intent: RevisionIntent): Promise<void> {
		const dedupeKey = `${intent.workId}:${intent.sourceTurnHash}`;
		if (intentsBySession.get(dedupeKey)) return;
		intentsBySession.set(dedupeKey, intent.sourceTurnHash);
		const views = await service.listForSession(sessionId);
		const work = views.find((view) => view.workId === intent.workId);
		if (!work) return;
		const snapshot = await runtime.snapshot(sessionId);
		if (!snapshot) return;
		const latest = [...snapshot.messages].reverse().find((message) => message.role === "user");
		if (!latest || hashTurnText(latest.text) !== intent.sourceTurnHash) return;
		const prepared = await service.prepare({
			requestId: `ri_${intent.sourceTurnHash.slice(0, 24)}`,
			workId: work.workId,
			expectedRevision: work.revision,
			kind: "revise_document",
			requirementsRef: { kind: "user_instruction", sourceTurnId: intent.sourceTurnId, sourceTurnHash: intent.sourceTurnHash },
			scope: { summary: intent.instruction, sections: intent.sections, preserve: intent.preserve },
			materialPaths: [],
		});
		if (!prepared.ok) return void logIntentFailure(work.workId, prepared.error.code);
		const request: StartWorkInput = {
			requestId: `rs_${intent.sourceTurnHash.slice(0, 24)}`,
			workId: work.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: snapshot.target,
			authorization: { kind: "revision_instruction", sourceTurnId: intent.sourceTurnId, sourceTurnHash: intent.sourceTurnHash },
		};
		const started = await service.start(request);
		if (!started.ok) void logIntentFailure(work.workId, started.error.code);
	}

	async function logIntentFailure(workId: string, code: string): Promise<void> {
		deps.logger?.warn("document-work", "Revision intent not dispatched", { workId, code });
	}

	return {
		store,
		artifacts,
		inspection,
		runtime,
		service,
		observePiEvent,
		observeRuntimeState,
		forgetAgent(agentId: string): void {
			const sessionId = agentSessions.get(agentId);
			if (sessionId) service.observeAlignmentState(sessionId, null);
			agentSessions.delete(agentId);
		},
		/** 退出路径：取消在途结算 → 解除订阅 → 停止运行时等待 → drain 协程。 */
		async dispose(): Promise<void> {
			service.beginShutdown();
			for (const unsubscribe of unsubscribers) unsubscribe();
			unsubscribers.length = 0;
			runtime.stop();
			await service.drain();
		},
	};
}

export { DocumentWorkStore, DocumentArtifactStore, DocumentInspectionService, DocumentWorkRuntimeAdapter, DocumentWorkService, sameRuntimeTriple, parseSessionRuntimeTriple, extensionStateMatchesBinding, stableStringify, workFailure };
export type { WorkResult, PreparedWork, SessionRuntimeTriple, DocumentWorkExtensionState };
