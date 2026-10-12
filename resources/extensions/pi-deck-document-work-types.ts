/**
 * 文稿扩展侧线格式：与 `src/shared/types/documentWork.ts`、`src/shared/documentWork.ts`
 * 逐字段对齐。扩展运行在 pi 进程内，无法 import 源码目录，因此这里保留一份镜像；
 * `tests/documentWorkContract.test.mjs` 用同一组样例同时跑两边，防止漂移。
 *
 * 校验原则：绑定载荷与它携带的路径来自主进程，但扩展仍按「不可信输入」重新校验；
 * 任何越界、绝对路径或超预算的字段都直接拒绝，而不是截断后使用。
 */

export const DOCUMENT_WORK_SCHEMA_VERSION = 1;
export const DOCUMENT_WORK_STATE_TYPE = "pi-deck-document-work-state";
export const DOCUMENT_WORK_REVISION_INTENT_TYPE = "pi-deck-document-revision-intent";
export const DOCUMENT_WORK_BINDING_ENTRY_TYPE = "tpa-document-work-binding";
export const DOCUMENT_WORK_REPORT_ENTRY_TYPE = "tpa-document-work-report";
export const DOCUMENT_WORK_BIND_COMMAND = "/tpa-work";
export const DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES = 64 * 1024;
export const DOCUMENT_WORK_REPORT_MAX_BYTES = 64 * 1024;
export const DOCUMENT_WORK_REPORT_MAX_FILES = 32;
export const DOCUMENT_WORK_PATH_MAX_LENGTH = 1024;
export const DOCUMENT_WORK_ID_MAX_LENGTH = 96;

export type DocumentWorkKind = "create_document" | "revise_document";

export type BoundMaterial = { materialId: string; label: string; path: string; digest: string };

export type DocumentWorkBinding = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	/** 稳定的 SessionRecord.id：工作记录主键，扩展不用它校验会话。 */
	sessionId: string;
	/** pi 进程自身的会话 id：扩展用它与 ctx.sessionManager.getSessionId() 对照。 */
	nativeSessionId: string;
	kind: DocumentWorkKind;
	workDirectory: string;
	stagingDirectory: string;
	/** TPA 管理的材料转换缓存目录（主进程解析并授权），扩展只在其中写 Markdown。 */
	materialCacheDirectory: string;
	materials: BoundMaterial[];
	base?: { versionId: string; path: string; digest: string; fileName: string };
	scope: { summary: string; sections: string[]; preserve: string[] };
	requirements: { summary: string };
};

export type DocumentArtifactCandidate = {
	reportId: string;
	artifacts: Array<{ relativePath: string; role: "primary" | "editable_source" | "supporting" }>;
	summary: string;
	risks: string[];
};

export type DocumentRevisionIntent = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	sessionId: string;
	intentId: string;
	sourceTurnId: string;
	sourceTurnHash: string;
	instruction: string;
	sections: string[];
	preserve: string[];
};

export type DocumentWorkExtensionState = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	sessionId: string;
	phase: "bound" | "reported" | "rejected";
	materials: Array<{ materialId: string; status: "unknown" | "converted" | "failed"; digest?: string; converterVersion?: string; error?: string }>;
	report?: DocumentArtifactCandidate;
	reason?: "invalid_payload" | "already_bound" | "mismatch" | "no_work";
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isId(value: unknown, maxLength = DOCUMENT_WORK_ID_MAX_LENGTH): value is string {
	return typeof value === "string" && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** 绝对路径是绑定载荷的一部分（由主进程解析），扩展只做长度与空值校验。 */
function isAbsoluteHostPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= DOCUMENT_WORK_PATH_MAX_LENGTH && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"));
}

function isSafeRelativePath(value: unknown): value is string {
	if (!boundedText(value, DOCUMENT_WORK_PATH_MAX_LENGTH)) return false;
	const normalized = value.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return false;
	return normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function boundedList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return undefined;
	if (!value.every((item) => typeof item === "string" && item.length <= maxLength)) return undefined;
	return [...(value as string[])];
}

/** 绑定载荷只接受主进程构造的完整形状；缺字段或超预算直接判非法，不做部分采用。 */
export function decodeBinding(payload: unknown): DocumentWorkBinding | undefined {
	if (!isRecord(payload) || payload.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isId(payload.workId) || !isId(payload.attemptId) || !isId(payload.preparationId) || !isDigest(payload.digest)) return undefined;
	if (!boundedText(payload.sessionId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (!boundedText(payload.nativeSessionId, 200)) return undefined;
	if (payload.kind !== "create_document" && payload.kind !== "revise_document") return undefined;
	if (!isAbsoluteHostPath(payload.workDirectory) || !isAbsoluteHostPath(payload.stagingDirectory) || !isAbsoluteHostPath(payload.materialCacheDirectory)) return undefined;
	if (!Array.isArray(payload.materials) || payload.materials.length > 24) return undefined;
	const materials: BoundMaterial[] = [];
	for (const entry of payload.materials) {
		if (!isRecord(entry) || !isId(entry.materialId, 40) || !boundedText(entry.label, 200) || !isAbsoluteHostPath(entry.path) || !isDigest(entry.digest)) return undefined;
		materials.push({ materialId: entry.materialId, label: entry.label, path: entry.path, digest: entry.digest });
	}
	const base = payload.base === undefined ? undefined : isRecord(payload.base) && isId(payload.base.versionId) && isAbsoluteHostPath(payload.base.path) && isDigest(payload.base.digest) && boundedText(payload.base.fileName, 200) ? { versionId: payload.base.versionId, path: payload.base.path, digest: payload.base.digest, fileName: payload.base.fileName } : undefined;
	if (payload.base !== undefined && !base) return undefined;
	const scope = isRecord(payload.scope) ? { summary: typeof payload.scope.summary === "string" && payload.scope.summary.length <= 2000 ? payload.scope.summary : undefined, sections: boundedList(payload.scope.sections, 24, 200), preserve: boundedList(payload.scope.preserve, 24, 200) } : undefined;
	if (!scope?.sections || !scope.preserve || scope.summary === undefined) return undefined;
	const requirements = isRecord(payload.requirements) && typeof payload.requirements.summary === "string" && payload.requirements.summary.length <= 4000 ? { summary: payload.requirements.summary } : undefined;
	if (!requirements) return undefined;
	const binding: DocumentWorkBinding = { schemaVersion: 1, workId: payload.workId, attemptId: payload.attemptId, preparationId: payload.preparationId, digest: payload.digest, sessionId: payload.sessionId, nativeSessionId: payload.nativeSessionId, kind: payload.kind, workDirectory: payload.workDirectory, stagingDirectory: payload.stagingDirectory, materialCacheDirectory: payload.materialCacheDirectory, materials, ...(base ? { base } : {}), scope: { summary: scope.summary, sections: scope.sections, preserve: scope.preserve }, requirements };
	return JSON.stringify(binding).length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES ? undefined : binding;
}

export function decodeArtifactCandidate(value: unknown): DocumentArtifactCandidate | undefined {
	if (!isRecord(value) || !boundedText(value.reportId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > DOCUMENT_WORK_REPORT_MAX_FILES) return undefined;
	const artifacts: DocumentArtifactCandidate["artifacts"] = [];
	for (const entry of value.artifacts) {
		if (!isRecord(entry) || !isSafeRelativePath(entry.relativePath)) return undefined;
		if (entry.role !== "primary" && entry.role !== "editable_source" && entry.role !== "supporting") return undefined;
		artifacts.push({ relativePath: entry.relativePath, role: entry.role });
	}
	if (typeof value.summary !== "string" || value.summary.length > 4000) return undefined;
	const risks = boundedList(value.risks, 24, 500);
	if (!risks) return undefined;
	const candidate: DocumentArtifactCandidate = { reportId: value.reportId, artifacts, summary: value.summary, risks };
	return JSON.stringify(candidate).length > DOCUMENT_WORK_REPORT_MAX_BYTES ? undefined : candidate;
}

export function decodeRevisionIntent(value: unknown): DocumentRevisionIntent | undefined {
	if (!isRecord(value) || !isId(value.workId) || !isId(value.attemptId) || !isId(value.preparationId) || !isDigest(value.digest)) return undefined;
	if (!boundedText(value.sessionId, DOCUMENT_WORK_ID_MAX_LENGTH) || !isId(value.intentId)) return undefined;
	if (!boundedText(value.sourceTurnId, 200) || !isDigest(value.sourceTurnHash)) return undefined;
	if (typeof value.instruction !== "string" || value.instruction.length > 2000) return undefined;
	const sections = boundedList(value.sections, 24, 200);
	const preserve = boundedList(value.preserve, 24, 200);
	if (!sections || !preserve) return undefined;
	return { schemaVersion: 1, workId: value.workId, attemptId: value.attemptId, preparationId: value.preparationId, digest: value.digest, sessionId: value.sessionId, intentId: value.intentId, sourceTurnId: value.sourceTurnId, sourceTurnHash: value.sourceTurnHash, instruction: value.instruction, sections, preserve };
}

/** 无 Node 依赖的 base64url 解码：与 shared 里的编码器对称，含长度上限与 UTF-8 严格校验。 */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function decodeBase64Url(value: string): string | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of value) {
		const index = BASE64URL_ALPHABET.indexOf(character);
		if (index < 0) return undefined;
		buffer = (buffer << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		return decoder.decode(new Uint8Array(bytes));
	} catch {
		return undefined;
	}
}

/** 命令参数 → 绑定载荷；超预算或 JSON 损坏一律判非法。 */
export function decodeBindingCommandArgument(argument: string): DocumentWorkBinding | undefined {
	if (argument.length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES * 2) return undefined;
	const text = decodeBase64Url(argument);
	if (!text || text.length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES) return undefined;
	try {
		return decodeBinding(JSON.parse(text) as unknown);
	} catch {
		return undefined;
	}
}

/** 扩展发布的状态快照：与主进程 `parseDocumentWorkExtensionState` 同构。 */
export function decodeExtensionState(value: unknown): DocumentWorkExtensionState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isId(value.workId) || !isId(value.attemptId) || !isId(value.preparationId) || !isDigest(value.digest)) return undefined;
	if (!boundedText(value.sessionId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (value.phase !== "bound" && value.phase !== "reported" && value.phase !== "rejected") return undefined;
	if (!Array.isArray(value.materials) || value.materials.length > 32) return undefined;
	const materials: DocumentWorkExtensionState["materials"] = [];
	for (const entry of value.materials) {
		if (!isRecord(entry) || !isId(entry.materialId, 40)) return undefined;
		if (entry.status !== "unknown" && entry.status !== "converted" && entry.status !== "failed") return undefined;
		materials.push({ materialId: entry.materialId, status: entry.status, ...(isDigest(entry.digest) ? { digest: entry.digest } : {}), ...(boundedText(entry.converterVersion, 120) ? { converterVersion: entry.converterVersion } : {}), ...(typeof entry.error === "string" && entry.error.length <= 500 ? { error: entry.error } : {}) });
	}
	const report = value.report === undefined ? undefined : decodeArtifactCandidate(value.report);
	if (value.report !== undefined && !report) return undefined;
	const reason = value.reason;
	if (reason !== undefined && reason !== "invalid_payload" && reason !== "already_bound" && reason !== "mismatch" && reason !== "no_work") return undefined;
	return { schemaVersion: 1, workId: value.workId, attemptId: value.attemptId, preparationId: value.preparationId, digest: value.digest, sessionId: value.sessionId, phase: value.phase, materials, ...(report ? { report } : {}), ...(reason ? { reason } : {}) };
}
