/**
 * 磁盘记录与渲染快照的有界解析。
 *
 * 拆出本文件的原因：主进程要把 `userData/document-work/` 下的 JSON 与旧版本数据
 * 一律当不可信输入读入，字段多且校验密集；与协议策略放在同一文件会超过 600 行红线。
 * 这里仍然只有纯函数，不依赖 Node/Electron/pi。
 */
import { isBoundedText, isDigest, isNonNegativeInteger, isRecord, isRequestId, isSafeRelativePath, isWorkId, parseDocumentWorkScope, parseDocumentWorkMaterial, parseRequirementsReference, parseSessionRuntimeTriple } from "./documentWork";
import {
	DOCUMENT_WORK_SCHEMA_VERSION,
	type AuthorizationReference,
	type DocumentArtifactEntry,
	type DocumentArtifactVersion,
	type DocumentInspection,
	type DocumentInspectionItem,
	type DocumentOutputRoot,
	type DocumentRuntimeLease,
	type DocumentSectionFingerprint,
	type DocumentWorkBase,
	type DocumentWorkChangedEvent,
	type DocumentWorkOperation,
	type DocumentWorkPreparation,
	type DocumentWorkRecord,
	type DocumentWorkView,
	type InspectionStatus,
	type OperationPhase,
	type VersionUserAcceptance,
	type WorkError,
	type WorkErrorCode,
} from "./types/documentWork";
import { deriveInspectionStatus, isWorkErrorCode, isRetryableWorkError } from "./documentWork";

const OPERATION_PHASES: readonly OperationPhase[] = ["prepared", "dispatching", "running", "inspecting", "archived", "failed", "interrupted", "unknown"];
const INSPECTION_STATUSES: readonly InspectionStatus[] = ["passed", "failed", "unverified"];

/** 块大纲：标题 + 64 位 hex 正文指纹；任一条不合格整份作废。 */
export function parseSectionFingerprints(value: unknown): DocumentSectionFingerprint[] | undefined {
	if (!Array.isArray(value) || value.length > 4096) return undefined;
	const sections: DocumentSectionFingerprint[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !isBoundedText(entry.heading, 200) || !isDigest(entry.textDigest)) return undefined;
		sections.push({ heading: entry.heading, textDigest: entry.textDigest });
	}
	return sections;
}

export function parseWorkError(value: unknown): WorkError | undefined {
	if (!isRecord(value) || !isWorkErrorCode(value.code)) return undefined;
	const code: WorkErrorCode = value.code;
	return {
		code,
		retryable: typeof value.retryable === "boolean" ? value.retryable : isRetryableWorkError(code),
		...(isNonNegativeInteger(value.currentRevision) ? { currentRevision: value.currentRevision } : {}),
		...(typeof value.detail === "string" && value.detail.length <= 200 && !/[\\/]/.test(value.detail) ? { detail: value.detail } : {}),
	};
}

export function parseOperationPhase(value: unknown): OperationPhase | undefined {
	return typeof value === "string" && (OPERATION_PHASES as readonly string[]).includes(value) ? (value as OperationPhase) : undefined;
}

export function parseInspectionItem(value: unknown): DocumentInspectionItem | undefined {
	if (!isRecord(value) || !isBoundedText(value.id, 80)) return undefined;
	if (value.status !== "passed" && value.status !== "failed" && value.status !== "unverified") return undefined;
	return { id: value.id, status: value.status, ...(typeof value.detail === "string" && value.detail.length <= 400 ? { detail: value.detail } : {}) };
}

export function parseDocumentInspection(value: unknown): DocumentInspection | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isBoundedText(value.inspectionId, 96) || !isWorkId(value.versionId)) return undefined;
	if (typeof value.status !== "string" || !(INSPECTION_STATUSES as readonly string[]).includes(value.status)) return undefined;
	if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 32) return undefined;
	const items: DocumentInspectionItem[] = [];
	for (const entry of value.items) {
		const item = parseInspectionItem(entry);
		if (!item) return undefined;
		items.push(item);
	}
	if (!isRecord(value.coverage)) return undefined;
	const coverage = value.coverage;
	if (typeof coverage.format !== "string" || coverage.format.length > 40) return undefined;
	if (!isNonNegativeInteger(coverage.bytesRead) || !isNonNegativeInteger(coverage.bytesTotal)) return undefined;
	if (typeof coverage.truncated !== "boolean") return undefined;
	if (!isNonNegativeInteger(value.byteBudget) || !isNonNegativeInteger(value.durationMs)) return undefined;
	if (!isBoundedText(value.inspectorVersion, 40)) return undefined;
	if (!isNonNegativeInteger(value.createdAt)) return undefined;
	// 状态必须与检查项自洽：不允许记录里写 passed 而项目里躺着一个 failed。
	if (deriveInspectionStatus(items) !== value.status) return undefined;
	return {
		schemaVersion: 1,
		inspectionId: value.inspectionId,
		versionId: value.versionId,
		status: value.status,
		items,
		coverage: {
			format: coverage.format,
			bytesRead: coverage.bytesRead,
			bytesTotal: coverage.bytesTotal,
			...(isDigest(coverage.textDigest) ? { textDigest: coverage.textDigest } : {}),
			...(isDigest(coverage.formatDigest) ? { formatDigest: coverage.formatDigest } : {}),
			...(isNonNegativeInteger(coverage.textLength) ? { textLength: coverage.textLength } : {}),
			...(parseSectionFingerprints(coverage.sections) ? { sections: parseSectionFingerprints(coverage.sections) as DocumentSectionFingerprint[] } : {}),
			...(isWorkId(coverage.comparedToVersionId) ? { comparedToVersionId: coverage.comparedToVersionId } : {}),
			truncated: coverage.truncated,
		},
		byteBudget: value.byteBudget,
		durationMs: value.durationMs,
		...(typeof value.reason === "string" && value.reason.length <= 200 ? { reason: value.reason } : {}),
		inspectorVersion: value.inspectorVersion,
		createdAt: value.createdAt,
	};
}

function parseAcceptance(value: unknown): VersionUserAcceptance | undefined {
	return value === "not_collected" || value === "accepted" || value === "rejected" ? value : undefined;
}

function parseArtifactEntry(value: unknown): DocumentArtifactEntry | undefined {
	if (!isRecord(value) || !isSafeRelativePath(value.relativePath)) return undefined;
	if (value.role !== "primary" && value.role !== "editable_source" && value.role !== "supporting") return undefined;
	if (!isDigest(value.digest) || !isNonNegativeInteger(value.bytes)) return undefined;
	return { relativePath: value.relativePath, role: value.role, digest: value.digest, bytes: value.bytes };
}

export function parseArtifactVersion(value: unknown, expectedWorkId?: string): DocumentArtifactVersion | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.versionId) || !isWorkId(value.workId)) return undefined;
	if (expectedWorkId !== undefined && value.workId !== expectedWorkId) return undefined;
	if (!isNonNegativeInteger(value.ordinal) || value.ordinal < 1) return undefined;
	if (value.kind !== "create_document" && value.kind !== "revise_document") return undefined;
	if (!isBoundedText(value.title, 120) || !isBoundedText(value.directory, 40) || !/^v\d{4}$/.test(value.directory)) return undefined;
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 64) return undefined;
	const artifacts: DocumentArtifactEntry[] = [];
	for (const entry of value.artifacts) {
		const parsed = parseArtifactEntry(entry);
		if (!parsed) return undefined;
		artifacts.push(parsed);
	}
	if (!isBoundedText(value.snapshotDirectory, 300)) return undefined;
	const inspection = value.inspection === undefined ? undefined : parseDocumentInspection(value.inspection);
	if (value.inspection !== undefined && !inspection) return undefined;
	if (inspection && inspection.versionId !== value.versionId) return undefined;
	const acceptance = parseAcceptance(value.userAcceptance);
	if (!acceptance) return undefined;
	if (!isNonNegativeInteger(value.createdAt)) return undefined;
	const risks = Array.isArray(value.modelRisks) && value.modelRisks.length <= 24 && value.modelRisks.every((item) => typeof item === "string" && item.length <= 500) ? [...(value.modelRisks as string[])] : undefined;
	if (!risks) return undefined;
	return {
		schemaVersion: 1,
		versionId: value.versionId,
		ordinal: value.ordinal,
		workId: value.workId,
		...(isWorkId(value.parentVersionId) ? { parentVersionId: value.parentVersionId } : {}),
		kind: value.kind,
		title: value.title,
		directory: value.directory,
		artifacts,
		snapshotDirectory: value.snapshotDirectory,
		...(isWorkId(value.baseVersionId) ? { baseVersionId: value.baseVersionId } : {}),
		...(isDigest(value.baseDigest) ? { baseDigest: value.baseDigest } : {}),
		...(isRecord(value.generation) && (value.generation.role === "model" || value.generation.role === "user_manual") ? { generation: { role: value.generation.role, ...(isWorkId(value.generation.sourceVersionId) ? { sourceVersionId: value.generation.sourceVersionId } : {}) } } : {}),
		...(typeof value.modelSummary === "string" && value.modelSummary.length <= 4000 ? { modelSummary: value.modelSummary } : {}),
		modelRisks: risks,
		...(inspection ? { inspection } : {}),
		userAcceptance: acceptance,
		...(isRecord(value.manualModification) && isDigest(value.manualModification.digest) && isNonNegativeInteger(value.manualModification.observedAt) ? { manualModification: { digest: value.manualModification.digest, observedAt: value.manualModification.observedAt } } : {}),
		createdAt: value.createdAt,
	};
}

export function parseDocumentWorkRecord(value: unknown): DocumentWorkRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.workId) || !isBoundedText(value.sessionId, 96)) return undefined;
	if (!isNonNegativeInteger(value.revision)) return undefined;
	if (!isBoundedText(value.title, 120) || !isBoundedText(value.outputRootId, 96)) return undefined;
	if (!isBoundedText(value.workDirectory, 400) || !isBoundedText(value.workFolder, 200)) return undefined;
	const sourceTurnIds = parseIdList(value.sourceTurnIds, 64, 200);
	const operationRequestIds = parseIdList(value.operationRequestIds, 512);
	const versionIds = parseIdList(value.versionIds, 512);
	const consumedRevisionTurns = parseIdList(value.consumedRevisionTurns, 256, 200);
	if (!sourceTurnIds || !operationRequestIds || !versionIds || !consumedRevisionTurns) return undefined;
	// 旧记录没有轮标识字段：默认空数组（历史 hash 无法反推 id，不能拿它顶替）。
	const consumedRevisionTurnIds = value.consumedRevisionTurnIds === undefined ? [] : parseIdList(value.consumedRevisionTurnIds, 256, 200);
	// 旧记录没有宿主自造轮字段：默认空数组（历史提示词无法反推 id）。
	const hostDispatchedTurnIds = value.hostDispatchedTurnIds === undefined ? [] : parseIdList(value.hostDispatchedTurnIds, 256, 200);
	if (!consumedRevisionTurnIds || !hostDispatchedTurnIds) return undefined;
	if (!isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)) return undefined;
	return {
		schemaVersion: 1,
		workId: value.workId,
		sessionId: value.sessionId,
		revision: value.revision,
		title: value.title,
		outputRootId: value.outputRootId,
		workDirectory: value.workDirectory,
		workFolder: value.workFolder,
		sourceTurnIds,
		requirementsSummary: typeof value.requirementsSummary === "string" && value.requirementsSummary.length <= 4000 ? value.requirementsSummary : "",
		...(isRequestId(value.activeRequestId) ? { activeRequestId: value.activeRequestId } : {}),
		operationRequestIds,
		versionIds,
		consumedRevisionTurns,
		consumedRevisionTurnIds,
		hostDispatchedTurnIds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function parseIdList(value: unknown, maxItems: number, maxLength = 96): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return undefined;
	if (!value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength)) return undefined;
	return [...(value as string[])];
}

export function parseDocumentWorkBase(value: unknown): DocumentWorkBase | undefined {
	if (!isRecord(value) || !isWorkId(value.versionId)) return undefined;
	if (!isNonNegativeInteger(value.ordinal) || value.ordinal < 1) return undefined;
	if (!isDigest(value.digest) || !isBoundedText(value.fileName, 200) || !isBoundedText(value.frozenPath, 400)) return undefined;
	if (value.origin !== "archived" && value.origin !== "external_manual") return undefined;
	const sections = parseSectionFingerprints(value.sections);
	if (!sections) return undefined;
	return { versionId: value.versionId, ordinal: value.ordinal, digest: value.digest, fileName: value.fileName, frozenPath: value.frozenPath, origin: value.origin, sections };
}

export function parseDocumentWorkPreparation(value: unknown, expectedWorkId?: string): DocumentWorkPreparation | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.preparationId) || !isWorkId(value.workId) || !isDigest(value.digest)) return undefined;
	if (expectedWorkId !== undefined && value.workId !== expectedWorkId) return undefined;
	if (!isNonNegativeInteger(value.workRevision)) return undefined;
	if (value.kind !== "create_document" && value.kind !== "revise_document") return undefined;
	const requirements = parseRequirementsReference(value.requirements);
	if (!requirements) return undefined;
	if (typeof value.requirementsSummary !== "string" || value.requirementsSummary.length > 4000) return undefined;
	if (!isBoundedText(value.outputRootId, 96) || !isBoundedText(value.stagingDirectory, 400)) return undefined;
	if (!Array.isArray(value.materials) || value.materials.length > 32) return undefined;
	const materials = [];
	for (const entry of value.materials) {
		const material = parseDocumentWorkMaterial(entry);
		if (!material) return undefined;
		materials.push(material);
	}
	const base = value.base === undefined ? undefined : parseDocumentWorkBase(value.base);
	if (value.base !== undefined && !base) return undefined;
	const scope = parseDocumentWorkScope(value.scope);
	if (!scope) return undefined;
	const runtime = value.runtime === undefined ? undefined : parseSessionRuntimeTriple(value.runtime);
	if (value.runtime !== undefined && !runtime) return undefined;
	if (!isNonNegativeInteger(value.createdAt)) return undefined;
	return {
		schemaVersion: 1,
		preparationId: value.preparationId,
		digest: value.digest,
		workId: value.workId,
		workRevision: value.workRevision,
		kind: value.kind,
		requirements,
		requirementsSummary: value.requirementsSummary,
		outputRootId: value.outputRootId,
		stagingDirectory: value.stagingDirectory,
		materials,
		...(base ? { base } : {}),
		scope,
		...(runtime ? { runtime } : {}),
		...(isBoundedText(value.nativeSessionId, 200) ? { nativeSessionId: value.nativeSessionId } : {}),
		createdAt: value.createdAt,
	};
}

export function parseDocumentWorkOperation(value: unknown, expectedWorkId?: string): DocumentWorkOperation | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isRequestId(value.requestId) || !isWorkId(value.workId) || !isWorkId(value.attemptId)) return undefined;
	if (expectedWorkId !== undefined && value.workId !== expectedWorkId) return undefined;
	if (value.kind !== "create_document" && value.kind !== "revise_document") return undefined;
	const phase = parseOperationPhase(value.phase);
	if (!phase) return undefined;
	if (!isRecord(value.preparation) || !isWorkId(value.preparation.preparationId) || !isDigest(value.preparation.digest)) return undefined;
	if (!isNonNegativeInteger(value.preparedWorkRevision)) return undefined;
	const runtime = parseSessionRuntimeTriple(value.runtime);
	if (!runtime) return undefined;
	if (!isRecord(value.authorization)) return undefined;
	const authorization =
		value.authorization.kind === "alignment_confirmation" && isBoundedText(value.authorization.briefId, 80) && isNonNegativeInteger(value.authorization.revision)
			? ({ kind: "alignment_confirmation", briefId: value.authorization.briefId, revision: value.authorization.revision } satisfies AuthorizationReference)
			: value.authorization.kind === "revision_instruction" && isBoundedText(value.authorization.sourceTurnId, 200) && isDigest(value.authorization.sourceTurnHash)
				? ({ kind: "revision_instruction", sourceTurnId: value.authorization.sourceTurnId, sourceTurnHash: value.authorization.sourceTurnHash } satisfies AuthorizationReference)
				: undefined;
	if (!authorization) return undefined;
	if (value.authorizationState !== "pending" && value.authorizationState !== "confirmed" && value.authorizationState !== "rejected") return undefined;
	const error = value.error === undefined ? undefined : parseWorkError(value.error);
	if (value.error !== undefined && !error) return undefined;
	if (!isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)) return undefined;
	return {
		schemaVersion: 1,
		requestId: value.requestId,
		workId: value.workId,
		attemptId: value.attemptId,
		kind: value.kind,
		phase,
		preparation: { preparationId: value.preparation.preparationId, digest: value.preparation.digest },
		preparedWorkRevision: value.preparedWorkRevision,
		runtime,
		authorization,
		authorizationState: value.authorizationState,
		extensionBound: value.extensionBound === true,
		dispatchAccepted: value.dispatchAccepted === true,
		dispatchUnknown: value.dispatchUnknown === true,
		...(isWorkId(value.versionId) ? { versionId: value.versionId } : {}),
		...(error ? { error } : {}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/** 运行时租约：身份必须齐全，缺一项就不能用来排他（宁可保守阻塞也不误放）。 */
export function parseDocumentRuntimeLease(value: unknown): DocumentRuntimeLease | undefined {
	if (!isRecord(value) || !isBoundedText(value.sessionId, 96)) return undefined;
	if (!isWorkId(value.workId) || !isRequestId(value.requestId) || !isWorkId(value.attemptId)) return undefined;
	const runtime = parseSessionRuntimeTriple(value);
	if (!runtime) return undefined;
	if (!isNonNegativeInteger(value.acquiredAt)) return undefined;
	return {
		sessionId: value.sessionId,
		agentId: runtime.agentId,
		runtimeGeneration: runtime.runtimeGeneration,
		...(isBoundedText(value.nativeSessionId, 200) ? { nativeSessionId: value.nativeSessionId } : {}),
		workId: value.workId,
		requestId: value.requestId,
		attemptId: value.attemptId,
		acquiredAt: value.acquiredAt,
	};
}

export function parseDocumentOutputRoot(value: unknown): DocumentOutputRoot | undefined {
	if (!isRecord(value) || !isBoundedText(value.outputRootId, 96)) return undefined;
	if (!isBoundedText(value.label, 200) || !isBoundedText(value.path, 400)) return undefined;
	if (!isNonNegativeInteger(value.addedAt)) return undefined;
	return { outputRootId: value.outputRootId, label: value.label, path: value.path, addedAt: value.addedAt };
}

export function parseDocumentWorkChangedEvent(value: unknown): DocumentWorkChangedEvent | undefined {
	if (!isRecord(value) || !isWorkId(value.workId) || !isBoundedText(value.sessionId, 96)) return undefined;
	if (!isNonNegativeInteger(value.revision)) return undefined;
	const kinds = ["created", "prepared", "dispatching", "running", "inspecting", "archived", "failed", "interrupted", "unknown", "cancelled"];
	if (typeof value.changeKind !== "string" || !kinds.includes(value.changeKind)) return undefined;
	return { workId: value.workId, sessionId: value.sessionId, revision: value.revision, changeKind: value.changeKind as DocumentWorkChangedEvent["changeKind"], ...(isWorkId(value.attemptId) ? { attemptId: value.attemptId } : {}) };
}

/** 渲染快照与磁盘记录分开校验：渲染层拿不到正文、检查项细节和快照目录。 */
export function parseDocumentWorkView(value: unknown): DocumentWorkView | undefined {
	if (!isRecord(value) || !isWorkId(value.workId) || !isBoundedText(value.sessionId, 96)) return undefined;
	if (!isNonNegativeInteger(value.revision) || !isBoundedText(value.title, 120)) return undefined;
	if (!isBoundedText(value.outputRootLabel, 200)) return undefined;
	if (typeof value.requirementsSummary !== "string" || value.requirementsSummary.length > 4000) return undefined;
	if (typeof value.revisionReady !== "boolean") return undefined;
	// active 缺席/为 null 表示无在途操作；给了值就必须解析成功，未知字段不能降级成「无操作」。
	let active: NonNullable<DocumentWorkView["active"]> | null = null;
	if (value.active !== undefined && value.active !== null) {
		const parsed = parseViewActive(value.active);
		if (!parsed) return undefined;
		active = parsed;
	}
	if (!Array.isArray(value.versions) || value.versions.length > 512) return undefined;
	const versions: DocumentWorkView["versions"] = [];
	for (const entry of value.versions) {
		const parsed = parseViewVersion(entry);
		if (!parsed) return undefined;
		versions.push(parsed);
	}
	return { workId: value.workId, sessionId: value.sessionId, revision: value.revision, title: value.title, outputRootLabel: value.outputRootLabel, requirementsSummary: value.requirementsSummary, active, versions, revisionReady: value.revisionReady };
}

function parseViewActive(value: unknown): NonNullable<DocumentWorkView["active"]> | undefined {
	if (!isRecord(value) || !isWorkId(value.attemptId)) return undefined;
	if (value.kind !== "create_document" && value.kind !== "revise_document") return undefined;
	const phase = parseOperationPhase(value.phase);
	if (!phase) return undefined;
	if (value.authorizationState !== "pending" && value.authorizationState !== "confirmed" && value.authorizationState !== "rejected") return undefined;
	const error = value.error === undefined ? undefined : parseWorkError(value.error);
	return { attemptId: value.attemptId, kind: value.kind, phase, authorizationState: value.authorizationState, ...(error ? { error } : {}) };
}

function parseViewVersion(value: unknown): DocumentWorkView["versions"][number] | undefined {
	if (!isRecord(value) || !isWorkId(value.versionId)) return undefined;
	if (!isNonNegativeInteger(value.ordinal) || value.ordinal < 1) return undefined;
	if (!isBoundedText(value.title, 120) || !isBoundedText(value.fileName, 200)) return undefined;
	if (value.inspection !== "passed" && value.inspection !== "failed" && value.inspection !== "unverified" && value.inspection !== "pending") return undefined;
	const acceptance = parseAcceptance(value.userAcceptance);
	if (!acceptance) return undefined;
	if (typeof value.manualModification !== "boolean" || !isNonNegativeInteger(value.createdAt)) return undefined;
	return {
		versionId: value.versionId,
		ordinal: value.ordinal,
		title: value.title,
		fileName: value.fileName,
		inspection: value.inspection,
		userAcceptance: acceptance,
		...(isWorkId(value.baseVersionId) ? { baseVersionId: value.baseVersionId } : {}),
		manualModification: value.manualModification,
		createdAt: value.createdAt,
	};
}
