/**
 * TPA 独立文稿：记录与协议载荷的解析（纯函数，不依赖任何运行时）。
 *
 * 三方输入（Renderer、模型、历史记录）都不可信。任何形状不符、超预算、未知版本或
 * 字段缺失都返回 undefined，由调用方转成结构化 WorkResult 错误；解析器从不抛异常，
 * 也从不补齐默认值伪造缺失字段。
 */
import { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_SCHEMA_VERSION, isBoundedText, isHexDigest, isNonNegativeInteger, isRecord, isSafeRelativePath, isWorkErrorCode, isWorkId, utf8ByteLength, parseWorkError, canonicalJson } from "./documentWorkProtocol";
import type {
	AuthorizationReference,
	DocumentArtifactCandidateReport,
	DocumentArtifactFile,
	DocumentArtifactVersion,
	DocumentChangeScope,
	DocumentInspection,
	DocumentInspectionChannelResult,
	DocumentInspectionStatus,
	DocumentMaterialReference,
	DocumentMaterialRoot,
	DocumentVersionProvenance,
	DocumentWorkBindingState,
	DocumentWorkKind,
	DocumentWorkOperation,
	DocumentWorkOperationState,
	DocumentWorkOutputRoot,
	DocumentWorkPreparation,
	DocumentWorkRecord,
	DocumentWorkRevisionIntent,
	PreparationReference,
	RequirementsReference,
} from "./types/documentWork";

function parseRequirementsReference(value: unknown): RequirementsReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment" && isWorkId(value.briefId) && isNonNegativeInteger(value.revision)) return { kind: "alignment", briefId: value.briefId, revision: value.revision };
	if (value.kind === "user_instruction" && isBoundedText(value.sourceTurnId, 200) && value.sourceTurnId) return { kind: "user_instruction", sourceTurnId: value.sourceTurnId };
	return undefined;
}

function parseAuthorizationReference(value: unknown): AuthorizationReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment_confirmation" && isWorkId(value.briefId) && isNonNegativeInteger(value.revision)) return { kind: "alignment_confirmation", briefId: value.briefId, revision: value.revision };
	if (value.kind === "revision_instruction" && isBoundedText(value.sourceTurnId, 200) && value.sourceTurnId) return { kind: "revision_instruction", sourceTurnId: value.sourceTurnId };
	return undefined;
}

export function parsePreparationReference(value: unknown): PreparationReference | undefined {
	if (!isRecord(value) || !isWorkId(value.preparationId) || !isBoundedText(value.digest, 200) || !value.digest) return undefined;
	return { preparationId: value.preparationId, digest: value.digest };
}

const OPERATION_STATES: ReadonlySet<string> = new Set<DocumentWorkOperationState>(["prepared", "dispatching", "running", "inspecting", "archived", "failed", "interrupted", "unknown"]);
const INSPECTION_STATUSES: ReadonlySet<string> = new Set<DocumentInspectionStatus>(["passed", "failed", "unverified"]);
const WORK_KINDS: ReadonlySet<string> = new Set<DocumentWorkKind>(["create_document", "revise_document"]);
const BINDING_PHASES: ReadonlySet<string> = new Set(["bound", "running", "reported", "failed"]);

/**
 * 修改范围规范化：去重、去空、有界；整篇授权必须是显式布尔真值。
 *
 * `allowWholeDocumentWithPreserve` 只给**初稿**用：初稿没有可比对象，要求单里的
 * "必须保留"与新文档不矛盾。改稿里"整篇重写 + 必须逐字保留"才必须澄清。
 */

export function normalizeChangeScope(value: unknown, options: { allowWholeDocumentWithPreserve?: boolean } = {}): DocumentChangeScope | undefined {
	if (!isRecord(value)) return undefined;
	const allow = value.allow;
	const preserve = value.preserve;
	if (!Array.isArray(allow) || !Array.isArray(preserve) || allow.length > 200 || preserve.length > 200) return undefined;
	const bounded = (items: unknown[]): string[] | undefined => {
		const result: string[] = [];
		for (const item of items) {
			if (!isBoundedText(item, 500)) return undefined;
			const trimmed = item.trim();
			if (!trimmed) return undefined;
			if (!result.includes(trimmed)) result.push(trimmed);
		}
		return result;
	};
	const normalizedAllow = bounded(allow);
	const normalizedPreserve = bounded(preserve);
	if (!normalizedAllow || !normalizedPreserve) return undefined;
	if (value.wholeDocument !== undefined && typeof value.wholeDocument !== "boolean") return undefined;
	const wholeDocument = value.wholeDocument === true;
	// 整篇授权与保留块互斥：矛盾的保留要求要澄清，不能静默降级成"允许改"（改稿规则）。
	if (wholeDocument && normalizedPreserve.length > 0 && !options.allowWholeDocumentWithPreserve) return undefined;
	if (!wholeDocument && normalizedAllow.length === 0) return undefined;
	return { allow: normalizedAllow, preserve: normalizedPreserve, wholeDocument };
}

function parseMaterialReferences(value: unknown): DocumentMaterialReference[] | undefined {
	if (!Array.isArray(value) || value.length > 64) return undefined;
	const materials: DocumentMaterialReference[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isWorkId(item.materialId) || !isWorkId(item.rootId) || !isSafeRelativePath(item.relativePath) || !isHexDigest(item.sha256) || !isNonNegativeInteger(item.bytes) || !isBoundedText(item.converter, 80) || !item.converter) return undefined;
		materials.push({ materialId: item.materialId, rootId: item.rootId, relativePath: item.relativePath, sha256: item.sha256, bytes: item.bytes, converter: item.converter });
	}
	return materials;
}

/** 材料根：只能是已有授权入口登记过的目录（成果根 / 项目根）。 */
function parseMaterialRoots(value: unknown): DocumentMaterialRoot[] | undefined {
	if (!Array.isArray(value) || value.length > 16) return undefined;
	const roots: DocumentMaterialRoot[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isWorkId(item.rootId) || (item.kind !== "output_root" && item.kind !== "project_root")) return undefined;
		if (!isBoundedText(item.path, 4000) || !item.path || !isBoundedText(item.label, 200) || !item.label) return undefined;
		roots.push({ rootId: item.rootId, kind: item.kind, path: item.path, label: item.label });
	}
	return roots;
}

function parseBaseSelection(value: unknown): DocumentWorkPreparation["base"] | undefined {
	if (value === undefined) return undefined;
	// artifactId 是「版本 + 相对路径」的复合键，不是 id 形态；只做有界文本校验。
	if (!isRecord(value) || !isWorkId(value.versionId) || !isBoundedText(value.artifactId, 300) || !value.artifactId || !isSafeRelativePath(value.relativePath) || !isHexDigest(value.sha256) || !isNonNegativeInteger(value.bytes)) return undefined;
	if (typeof value.explicit !== "boolean" || typeof value.handEdited !== "boolean") return undefined;
	return { versionId: value.versionId, artifactId: value.artifactId, relativePath: value.relativePath, sha256: value.sha256, bytes: value.bytes, explicit: value.explicit, handEdited: value.handEdited };
}

export function parsePreparation(value: unknown): DocumentWorkPreparation | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.preparationId) || typeof value.kind !== "string" || !WORK_KINDS.has(value.kind)) return undefined;
	if (!isNonNegativeInteger(value.workRevision) || !isNonNegativeInteger(value.createdAt)) return undefined;
	const kind = value.kind as DocumentWorkKind;
	const requirementsRef = parseRequirementsReference(value.requirementsRef);
	const authorization = parseAuthorizationReference(value.authorization);
	const materials = parseMaterialReferences(value.materials);
	const materialRoots = parseMaterialRoots(value.materialRoots);
	const base = parseBaseSelection(value.base);
	const scope = normalizeChangeScope(value.scope, { allowWholeDocumentWithPreserve: kind === "create_document" });
	if (!requirementsRef || !authorization || !materials || !materialRoots || !scope) return undefined;
	if (!isSafeRelativePath(value.stagingRelativeDir) || !isSafeRelativePath(value.outputRelativeDir)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	// 改稿必须有基稿：没有可用基稿时不能靠"最新文件"补一个。
	if (kind === "revise_document" && !base) return undefined;
	// 改稿授权必须带本轮冻结的指令正文与指纹；首版只允许对齐确认单触发首次制作。
	let instruction: DocumentWorkPreparation["instruction"];
	if (value.instruction !== undefined) {
		if (!isRecord(value.instruction) || !isWorkId(value.instruction.sourceTurnId) || !isBoundedText(value.instruction.text, DOCUMENT_WORK_BUDGETS.instructionChars) || !value.instruction.text) return undefined;
		if (!isHexDigest(value.instruction.textDigest)) return undefined;
		instruction = { sourceTurnId: value.instruction.sourceTurnId, text: value.instruction.text, textDigest: value.instruction.textDigest };
	}
	if (kind === "create_document" && authorization.kind !== "alignment_confirmation") return undefined;
	if (kind === "revise_document") {
		if (authorization.kind !== "revision_instruction") return undefined;
		if (!instruction || instruction.sourceTurnId !== authorization.sourceTurnId) return undefined;
	}
	// 材料必须指向已登记的根，否则扩展无法在授权范围内解析它。
	const rootIds = new Set(materialRoots.map((root) => root.rootId));
	if (materials.some((material) => !rootIds.has(material.rootId))) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		preparationId: value.preparationId,
		kind,
		workRevision: value.workRevision,
		requirementsRef,
		authorization,
		materials,
		materialRoots,
		...(base ? { base } : {}),
		scope,
		...(instruction ? { instruction } : {}),
		stagingRelativeDir: value.stagingRelativeDir,
		outputRelativeDir: value.outputRelativeDir,
		digest: value.digest,
		createdAt: value.createdAt,
	};
}

function parseArtifactFiles(value: unknown): DocumentArtifactFile[] | undefined {
	if (!Array.isArray(value) || value.length > DOCUMENT_WORK_BUDGETS.reportFiles) return undefined;
	const files: DocumentArtifactFile[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isSafeRelativePath(item.relativePath) || !isHexDigest(item.sha256) || !isNonNegativeInteger(item.bytes)) return undefined;
		if (item.existenceOnly !== undefined && typeof item.existenceOnly !== "boolean") return undefined;
		files.push({ relativePath: item.relativePath, sha256: item.sha256, bytes: item.bytes, ...(item.existenceOnly === true ? { existenceOnly: true } : {}) });
	}
	return files;
}

function parseInspectionChannel(value: unknown): DocumentInspectionChannelResult | undefined {
	if (!isRecord(value) || (value.channel !== "fingerprint" && value.channel !== "text" && value.channel !== "format")) return undefined;
	if (typeof value.status !== "string" || !INSPECTION_STATUSES.has(value.status)) return undefined;
	if (!isBoundedText(value.coverage, 500)) return undefined;
	const changes = value.changes === undefined ? undefined : Array.isArray(value.changes) && value.changes.length <= 200 && value.changes.every((item) => isBoundedText(item, 300)) ? [...(value.changes as string[])] : undefined;
	if (value.changes !== undefined && !changes) return undefined;
	return { channel: value.channel, status: value.status as DocumentInspectionStatus, coverage: value.coverage, ...(changes ? { changes } : {}), ...(isBoundedText(value.reason, 500) && value.reason ? { reason: value.reason } : {}) };
}

export function parseInspection(value: unknown): DocumentInspection | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (typeof value.status !== "string" || !INSPECTION_STATUSES.has(value.status)) return undefined;
	if (!Array.isArray(value.channels) || value.channels.length > 8) return undefined;
	const channels: DocumentInspectionChannelResult[] = [];
	for (const item of value.channels) {
		const channel = parseInspectionChannel(item);
		if (!channel) return undefined;
		channels.push(channel);
	}
	if (!isBoundedText(value.inspectorVersion, 80) || !value.inspectorVersion) return undefined;
	if (!isNonNegativeInteger(value.bytes) || !isNonNegativeInteger(value.budgetBytes) || !isNonNegativeInteger(value.elapsedMs)) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		status: value.status as DocumentInspectionStatus,
		channels,
		inspectorVersion: value.inspectorVersion,
		bytes: value.bytes,
		budgetBytes: value.budgetBytes,
		elapsedMs: value.elapsedMs,
		...(isBoundedText(value.reason, 500) && value.reason ? { reason: value.reason } : {}),
	};
}

function parseProvenance(value: unknown): DocumentVersionProvenance | undefined {
	if (!isRecord(value) || (value.method !== "word_local_edit" && value.method !== "markdown_source")) return undefined;
	if (value.kind === "generated_from_source" && isSafeRelativePath(value.sourceRelativePath) && isBoundedText(value.generator, 200) && value.generator) return { kind: "generated_from_source", sourceRelativePath: value.sourceRelativePath, generator: value.generator };
	if (value.kind === "revised_from_base" && isWorkId(value.baseVersionId)) return { kind: "revised_from_base", baseVersionId: value.baseVersionId, method: value.method };
	if (value.kind === "created") return { kind: "created", method: value.method };
	return undefined;
}

export function parseArtifactVersion(value: unknown): DocumentArtifactVersion | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.workId) || !isWorkId(value.versionId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId)) return undefined;
	if (!isNonNegativeInteger(value.ordinal) || value.ordinal < 1 || !isNonNegativeInteger(value.archivedAt)) return undefined;
	if (typeof value.kind !== "string" || !WORK_KINDS.has(value.kind)) return undefined;
	// 版本目录形态 `<workId>/versions/v0001`（归档按工作分目录）；只接受以 versions/<name> 结尾的相对路径。
	if (!isSafeRelativePath(value.relativeDir) || !/\/versions\/[^/]+$/.test(value.relativeDir)) return undefined;
	const artifacts = parseArtifactFiles(value.artifacts);
	const editableSources = parseArtifactFiles(value.editableSources);
	const snapshots = parseArtifactFiles(value.snapshots);
	const provenance = parseProvenance(value.provenance);
	const inspection = parseInspection(value.inspection);
	const base = parseBaseSelection(value.base);
	if (!artifacts || !editableSources || !snapshots || !provenance || !inspection) return undefined;
	if (artifacts.length === 0) return undefined;
	if (value.parentVersionId !== undefined && !isWorkId(value.parentVersionId)) return undefined;
	if (value.userAcceptance !== "not_collected" && value.userAcceptance !== "accepted" && value.userAcceptance !== "rejected") return undefined;
	const risks = value.modelRisks === undefined ? undefined : Array.isArray(value.modelRisks) && value.modelRisks.length <= 20 && value.modelRisks.every((item) => isBoundedText(item, 500)) ? [...(value.modelRisks as string[])] : undefined;
	if (value.modelRisks !== undefined && !risks) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		workId: value.workId,
		versionId: value.versionId,
		ordinal: value.ordinal,
		attemptId: value.attemptId,
		preparationId: value.preparationId,
		...(value.parentVersionId === undefined ? {} : { parentVersionId: value.parentVersionId }),
		kind: value.kind as DocumentWorkKind,
		relativeDir: value.relativeDir,
		artifacts,
		editableSources,
		snapshots,
		provenance,
		...(base ? { base } : {}),
		inspection,
		...(isBoundedText(value.modelSummary, 4000) && value.modelSummary ? { modelSummary: value.modelSummary } : {}),
		...(risks ? { modelRisks: risks } : {}),
		userAcceptance: value.userAcceptance,
		archivedAt: value.archivedAt,
	};
}

export function parseOperation(value: unknown): DocumentWorkOperation | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.requestId) || !isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId)) return undefined;
	if (typeof value.kind !== "string" || !WORK_KINDS.has(value.kind)) return undefined;
	if (typeof value.state !== "string" || !OPERATION_STATES.has(value.state)) return undefined;
	if (!isRecord(value.runtime) || !isBoundedText(value.runtime.agentId, 200) || !value.runtime.agentId || !isNonNegativeInteger(value.runtime.runtimeGeneration)) return undefined;
	if (!isBoundedText(value.preparationDigest, 200) || !value.preparationDigest || !isBoundedText(value.requestDigest, 200) || !value.requestDigest) return undefined;
	if (!isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)) return undefined;
	const error = value.error === undefined ? undefined : parseWorkError(value.error);
	if (value.error !== undefined && !error) return undefined;
	if (value.versionId !== undefined && !isWorkId(value.versionId)) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		requestId: value.requestId,
		workId: value.workId,
		attemptId: value.attemptId,
		kind: value.kind as DocumentWorkKind,
		preparationId: value.preparationId,
		preparationDigest: value.preparationDigest,
		state: value.state as DocumentWorkOperationState,
		runtime: { agentId: value.runtime.agentId, runtimeGeneration: value.runtime.runtimeGeneration },
		requestDigest: value.requestDigest,
		...(error ? { error } : {}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(value.versionId === undefined ? {} : { versionId: value.versionId }),
	};
}

export function parseWorkRecord(value: unknown): DocumentWorkRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.workId) || !isBoundedText(value.sessionId, 200) || !value.sessionId) return undefined;
	if (!isNonNegativeInteger(value.revision) || !isBoundedText(value.title, 200) || !isBoundedText(value.sourceTurnId, 200) || !value.sourceTurnId) return undefined;
	// 空 outputRootId = 尚未绑定成果目录（首次提交时用户还没选）；绑定后必须是已登记 ID。
	if ((value.outputRootId !== "" && !isWorkId(value.outputRootId)) || !isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt)) return undefined;
	const requirementsRef = value.requirementsRef === undefined ? undefined : parseRequirementsReference(value.requirementsRef);
	if (value.requirementsRef !== undefined && !requirementsRef) return undefined;
	if (value.activeOperationId !== undefined && !isWorkId(value.activeOperationId)) return undefined;
	if (!isRecord(value.requests)) return undefined;
	const requests: DocumentWorkRecord["requests"] = {};
	for (const [requestId, entry] of Object.entries(value.requests)) {
		if (!isWorkId(requestId) || !isRecord(entry) || !isWorkId(entry.attemptId) || !isBoundedText(entry.requestDigest, 200) || !entry.requestDigest || typeof entry.state !== "string" || !OPERATION_STATES.has(entry.state)) return undefined;
		requests[requestId] = { attemptId: entry.attemptId, requestDigest: entry.requestDigest, state: entry.state as DocumentWorkOperationState };
	}
	if (!Array.isArray(value.versions) || value.versions.length > 1000 || !value.versions.every((item) => isWorkId(item))) return undefined;
	const lastFailure =
		value.lastFailure === undefined
			? undefined
			: isRecord(value.lastFailure) && isWorkId(value.lastFailure.attemptId) && isWorkErrorCode(value.lastFailure.code) && isNonNegativeInteger(value.lastFailure.at)
				? { attemptId: value.lastFailure.attemptId, code: value.lastFailure.code, at: value.lastFailure.at }
				: undefined;
	if (value.lastFailure !== undefined && !lastFailure) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		workId: value.workId,
		sessionId: value.sessionId,
		revision: value.revision,
		title: value.title,
		sourceTurnId: value.sourceTurnId,
		outputRootId: value.outputRootId,
		...(requirementsRef ? { requirementsRef } : {}),
		...(value.activeOperationId === undefined ? {} : { activeOperationId: value.activeOperationId }),
		requests,
		versions: [...(value.versions as string[])],
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(lastFailure ? { lastFailure } : {}),
	};
}

/** 是否已绑定成果目录；未绑定时准备阶段必须拒绝。 */
export function recordHasOutputRoot(record: DocumentWorkRecord): boolean {
	return record.outputRootId.length > 0;
}

export function parseOutputRoot(value: unknown): DocumentWorkOutputRoot | undefined {
	if (!isRecord(value) || !isWorkId(value.outputRootId) || !isBoundedText(value.path, 2000) || !value.path || !isBoundedText(value.label, 200) || !value.label || !isNonNegativeInteger(value.registeredAt)) return undefined;
	return { outputRootId: value.outputRootId, path: value.path, label: value.label, registeredAt: value.registeredAt };
}

/** Pi 隐藏状态：`details.documentWork`。未知版本/形状一律丢弃，不回退到更早的绑定。 */
export function parseBindingState(value: unknown): DocumentWorkBindingState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isBoundedText(value.sessionId, 200) || !value.sessionId || !isBoundedText(value.nativeSessionId, 200) || !value.nativeSessionId) return undefined;
	if (!isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest || typeof value.phase !== "string" || !BINDING_PHASES.has(value.phase)) return undefined;
	if (value.reportId !== undefined && !isWorkId(value.reportId)) return undefined;
	if (value.kind !== undefined && (typeof value.kind !== "string" || !WORK_KINDS.has(value.kind))) return undefined;
	if (value.updatedAt !== undefined && !isNonNegativeInteger(value.updatedAt)) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		sessionId: value.sessionId,
		nativeSessionId: value.nativeSessionId,
		workId: value.workId,
		attemptId: value.attemptId,
		preparationId: value.preparationId,
		digest: value.digest,
		phase: value.phase as DocumentWorkBindingState["phase"],
		...(isWorkId(value.reportId) ? { reportId: value.reportId } : {}),
		...(typeof value.kind === "string" && WORK_KINDS.has(value.kind) ? { kind: value.kind as DocumentWorkKind } : {}),
		...(isSafeRelativePath(value.stagingRelativeDir) ? { stagingRelativeDir: value.stagingRelativeDir } : {}),
		...(isNonNegativeInteger(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
	};
}

/**
 * 普通聊天的改稿意向（候选）。形状不符或字段超界直接丢弃：候选永远不能变成授权。
 */
export function parseRevisionIntent(value: unknown): DocumentWorkRevisionIntent | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isBoundedText(value.sessionId, 200) || !value.sessionId || !isBoundedText(value.nativeSessionId, 200) || !value.nativeSessionId) return undefined;
	if (!isWorkId(value.workId) || !isWorkId(value.sourceTurnId)) return undefined;
	if (!isHexDigest(value.instructionDigest)) return undefined;
	if (!isBoundedText(value.summary, 500)) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		sessionId: value.sessionId,
		nativeSessionId: value.nativeSessionId,
		workId: value.workId,
		sourceTurnId: value.sourceTurnId,
		instructionDigest: value.instructionDigest,
		summary: value.summary,
	};
}

/** 成果候选汇报：模型文本永远只是候选，不是批准或检查结论。 */
export function parseArtifactCandidateReport(value: unknown): DocumentArtifactCandidateReport | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId) || !isWorkId(value.reportId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > DOCUMENT_WORK_BUDGETS.reportFiles) return undefined;
	if (!value.artifacts.every((item) => isSafeRelativePath(item))) return undefined;
	if (!Array.isArray(value.editableSources) || value.editableSources.length > DOCUMENT_WORK_BUDGETS.reportFiles || !value.editableSources.every((item) => isSafeRelativePath(item))) return undefined;
	if (!isBoundedText(value.summary, 4000)) return undefined;
	if (!Array.isArray(value.risks) || value.risks.length > 20 || !value.risks.every((item) => isBoundedText(item, 500))) return undefined;
	const report: DocumentArtifactCandidateReport = {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		workId: value.workId,
		attemptId: value.attemptId,
		preparationId: value.preparationId,
		digest: value.digest,
		reportId: value.reportId,
		artifacts: [...(value.artifacts as string[])],
		editableSources: [...(value.editableSources as string[])],
		summary: value.summary,
		risks: [...(value.risks as string[])],
	};
	return utf8ByteLength(canonicalJson(report)) <= DOCUMENT_WORK_BUDGETS.reportBytes ? report : undefined;
}
