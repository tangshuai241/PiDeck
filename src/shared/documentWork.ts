/**
 * 文稿协议的有界解析与纯策略（不依赖 Node/Electron/pi）。
 *
 * 这里的所有入口都把输入当成不可信数据：IPC 入参、扩展汇报、磁盘记录和旧会话
 * 快照走同一套边界校验。错误一律用 `WorkResult` 表达，不抛裸异常跨进程。
 */
import {
	DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES,
	DOCUMENT_WORK_ID_MAX_LENGTH,
	DOCUMENT_WORK_PATH_MAX_LENGTH,
	DOCUMENT_WORK_REPORT_MAX_BYTES,
	DOCUMENT_WORK_REPORT_MAX_FILES,
	DOCUMENT_WORK_SCHEMA_VERSION,
	type DocumentArtifactCandidate,
	type DocumentInspection,
	type DocumentInspectionItem,
	type DocumentWorkExtensionState,
	type AuthorizationReference,
	type DocumentWorkMaterial,
	type DocumentWorkScope,
	type InspectionStatus,
	type RequirementsReference,
	type SessionRuntimeTriple,
	type WorkError,
	type WorkErrorCode,
	type WorkResult,
} from "./types/documentWork";

/** 供主进程与测试从同一入口取用结果类型，避免各处重复声明。 */
export type { WorkError, WorkErrorCode, WorkResult };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBoundedText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit;
}

/** 程序生成的 ID：有界、非空、只含安全字符，禁止路径分隔符与点段。 */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value) && value.length <= DOCUMENT_WORK_ID_MAX_LENGTH;
}

export function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
}

/** sha256 十六进制；准备/基稿/成果指纹统一用这一种形态。 */
export function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const WORK_ERROR_CODES: readonly WorkErrorCode[] = [
	"INVALID_INPUT",
	"WORK_NOT_FOUND",
	"OPERATION_NOT_FOUND",
	"REVISION_CONFLICT",
	"IDEMPOTENCY_CONFLICT",
	"RUNTIME_CHANGED",
	"RUNTIME_BUSY",
	"PREPARATION_STALE",
	"APPROVAL_REQUIRED",
	"BASE_AMBIGUOUS",
	"BASE_CHANGED",
	"PATH_DENIED",
	"EXTENSION_UNAVAILABLE",
	"DISPATCH_UNKNOWN",
	"INSPECTION_UNVERIFIED",
	"CANCEL_NOT_APPLICABLE",
	"IO_ERROR",
];

export function isWorkErrorCode(value: unknown): value is WorkErrorCode {
	return typeof value === "string" && (WORK_ERROR_CODES as readonly string[]).includes(value);
}

/** 重试语义集中定义：只有能安全重试的错误才是 retryable。 */
export function isRetryableWorkError(code: WorkErrorCode): boolean {
	return code === "REVISION_CONFLICT" || code === "RUNTIME_BUSY" || code === "RUNTIME_CHANGED" || code === "PREPARATION_STALE" || code === "BASE_CHANGED" || code === "IO_ERROR";
}

export function workError(code: WorkErrorCode, detail?: string, currentRevision?: number): WorkError {
	return { code, retryable: isRetryableWorkError(code), ...(detail ? { detail } : {}), ...(currentRevision !== undefined ? { currentRevision } : {}) };
}

export function workFailure<T>(code: WorkErrorCode, detail?: string, currentRevision?: number): WorkResult<T> {
	return { ok: false, error: workError(code, detail, currentRevision) };
}

export function workSuccess<T>(value: T): WorkResult<T> {
	return { ok: true, value };
}

export function parseSessionRuntimeTriple(value: unknown): SessionRuntimeTriple | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedText(value.sessionId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (!isBoundedText(value.agentId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (!isNonNegativeInteger(value.runtimeGeneration)) return undefined;
	return { sessionId: value.sessionId, agentId: value.agentId, runtimeGeneration: value.runtimeGeneration };
}

export function sameRuntimeTriple(left: SessionRuntimeTriple | undefined, right: SessionRuntimeTriple | undefined): boolean {
	return Boolean(left && right && left.sessionId === right.sessionId && left.agentId === right.agentId && left.runtimeGeneration === right.runtimeGeneration);
}

export function parseRequirementsReference(value: unknown): RequirementsReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment") {
		if (!isBoundedText(value.briefId, 80) || !isNonNegativeInteger(value.revision)) return undefined;
		return { kind: "alignment", briefId: value.briefId, revision: value.revision };
	}
	if (value.kind === "user_instruction") {
		if (!isBoundedText(value.sourceTurnId, 200) || !isDigest(value.sourceTurnHash)) return undefined;
		return { kind: "user_instruction", sourceTurnId: value.sourceTurnId, sourceTurnHash: value.sourceTurnHash };
	}
	return undefined;
}

/** 授权引用：与要求引用同构，但语义是「本次执行的授权来源」，不接受布尔值。 */
export function parseAuthorizationReference(value: unknown): AuthorizationReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment_confirmation") {
		if (!isBoundedText(value.briefId, 80) || !isNonNegativeInteger(value.revision)) return undefined;
		return { kind: "alignment_confirmation", briefId: value.briefId, revision: value.revision };
	}
	if (value.kind === "revision_instruction") {
		if (!isBoundedText(value.sourceTurnId, 200) || !isDigest(value.sourceTurnHash)) return undefined;
		return { kind: "revision_instruction", sourceTurnId: value.sourceTurnId, sourceTurnHash: value.sourceTurnHash };
	}
	return undefined;
}

export function sameRequirements(left: RequirementsReference | undefined, right: RequirementsReference | undefined): boolean {
	if (!left || !right || left.kind !== right.kind) return false;
	if (left.kind === "alignment" && right.kind === "alignment") return left.briefId === right.briefId && left.revision === right.revision;
	if (left.kind === "user_instruction" && right.kind === "user_instruction") return left.sourceTurnId === right.sourceTurnId;
	return false;
}

/** 相对路径必须留在版本目录内：拒绝绝对路径、`..` 段、盘符与反斜杠写法。 */
export function isSafeRelativePath(value: unknown): value is string {
	if (!isBoundedText(value, DOCUMENT_WORK_PATH_MAX_LENGTH)) return false;
	const normalized = value.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
	if (normalized.includes("\0")) return false;
	const segments = normalized.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function collapseHeading(value: string): string {
	return value.replace(/[\s\u3000]+/g, "").toLowerCase();
}

const HEADING_PREFIX_RE = /^(?:第[一二三四五六七八九十百零〇\d]+[章节节篇部分条]|[（(]?[一二三四五六七八九十百零〇\d]+[)）.、]|[0-9]+(?:\.[0-9]+)*[、.．]?)/;

/**
 * 规范化章节引用：折叠空白与小写，并去掉序号前缀。
 * 前缀去掉后为空（例如只写了「第二章」）时回退到原文本，否则「第二章」无法与「第二章 市场分析」对应。
 */
export function normalizeHeadingReference(value: string): string {
	const collapsed = collapseHeading(value);
	const stripped = collapsed.replace(HEADING_PREFIX_RE, "");
	return stripped.length > 0 ? stripped : collapsed;
}

/** 声明的章节引用必须能在基稿标题里找到，否则属于范围冲突（先澄清，不猜）。 */
export function sectionReferenceMatches(reference: string, headings: readonly string[]): boolean {
	const variants = (text: string): string[] => {
		const collapsed = collapseHeading(text);
		const stripped = collapsed.replace(HEADING_PREFIX_RE, "");
		return [...new Set([collapsed, stripped].filter((item) => item.length > 0))];
	};
	const wanted = variants(reference);
	if (wanted.length === 0) return false;
	return headings.some((heading) => {
		const candidates = variants(heading);
		return wanted.some((item) => candidates.some((candidate) => candidate === item || candidate.includes(item) || item.includes(candidate)));
	});
}

export function parseDocumentWorkScope(value: unknown): DocumentWorkScope | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.summary !== "string" || value.summary.length > 2000) return undefined;
	const sections = parseBoundedList(value.sections, 24, 200);
	const preserve = parseBoundedList(value.preserve, 24, 200);
	if (!sections || !preserve) return undefined;
	return { summary: value.summary, sections, preserve };
}

function parseBoundedList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return undefined;
	if (!value.every((item) => typeof item === "string" && item.length <= maxLength)) return undefined;
	return [...value] as string[];
}

export function parseDocumentWorkMaterial(value: unknown): DocumentWorkMaterial | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedText(value.materialId, 40)) return undefined;
	if (!isBoundedText(value.label, 200)) return undefined;
	if (!isBoundedText(value.hostPath, DOCUMENT_WORK_PATH_MAX_LENGTH)) return undefined;
	if (!isDigest(value.digest)) return undefined;
	if (!isNonNegativeInteger(value.bytes)) return undefined;
	return { materialId: value.materialId, label: value.label, hostPath: value.hostPath, digest: value.digest, bytes: value.bytes };
}

export function parseDocumentArtifactCandidate(value: unknown): DocumentArtifactCandidate | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedText(value.reportId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > DOCUMENT_WORK_REPORT_MAX_FILES) return undefined;
	const artifacts: DocumentArtifactCandidate["artifacts"] = [];
	for (const entry of value.artifacts) {
		if (!isRecord(entry) || !isSafeRelativePath(entry.relativePath)) return undefined;
		if (entry.role !== "primary" && entry.role !== "editable_source" && entry.role !== "supporting") return undefined;
		artifacts.push({ relativePath: entry.relativePath, role: entry.role });
	}
	if (typeof value.summary !== "string" || value.summary.length > 4000) return undefined;
	const risks = parseBoundedList(value.risks, 24, 500);
	if (!risks) return undefined;
	const candidate: DocumentArtifactCandidate = { reportId: value.reportId, artifacts, summary: value.summary, risks };
	if (JSON.stringify(candidate).length > DOCUMENT_WORK_REPORT_MAX_BYTES) return undefined;
	return candidate;
}

/** 扩展汇报是不可信输入：身份字段必须齐全且与主进程绑定的尝试逐字段一致。 */
export function parseDocumentWorkExtensionState(value: unknown): DocumentWorkExtensionState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId)) return undefined;
	if (!isDigest(value.digest)) return undefined;
	if (!isBoundedText(value.sessionId, DOCUMENT_WORK_ID_MAX_LENGTH)) return undefined;
	if (value.phase !== "bound" && value.phase !== "reported" && value.phase !== "rejected") return undefined;
	if (!Array.isArray(value.materials) || value.materials.length > 32) return undefined;
	const materials: DocumentWorkExtensionState["materials"] = [];
	for (const entry of value.materials) {
		if (!isRecord(entry) || !isBoundedText(entry.materialId, 40)) return undefined;
		if (entry.status !== "unknown" && entry.status !== "converted" && entry.status !== "failed") return undefined;
		materials.push({
			materialId: entry.materialId,
			status: entry.status,
			...(isDigest(entry.digest) ? { digest: entry.digest } : {}),
			...(isBoundedText(entry.converterVersion, 120) ? { converterVersion: entry.converterVersion } : {}),
			...(typeof entry.error === "string" && entry.error.length <= 500 ? { error: entry.error } : {}),
		});
	}
	const report = value.report === undefined ? undefined : parseDocumentArtifactCandidate(value.report);
	if (value.report !== undefined && !report) return undefined;
	const reason = value.reason;
	if (reason !== undefined && reason !== "invalid_payload" && reason !== "already_bound" && reason !== "mismatch" && reason !== "no_work") return undefined;
	return { schemaVersion: 1, workId: value.workId, attemptId: value.attemptId, preparationId: value.preparationId, digest: value.digest, sessionId: value.sessionId, phase: value.phase, materials, ...(report ? { report } : {}), ...(reason ? { reason } : {}) };
}

/** 身份四元组比对：迟到的候选不能绑定到新的尝试或新的准备。 */
export function extensionStateMatchesBinding(state: Pick<DocumentWorkExtensionState, "workId" | "attemptId" | "preparationId" | "digest" | "sessionId">, binding: Pick<DocumentWorkExtensionState, "workId" | "attemptId" | "preparationId" | "digest" | "sessionId">): boolean {
	return state.workId === binding.workId && state.attemptId === binding.attemptId && state.preparationId === binding.preparationId && state.digest === binding.digest && state.sessionId === binding.sessionId;
}

export function deriveInspectionStatus(items: readonly DocumentInspectionItem[]): InspectionStatus {
	if (items.some((item) => item.status === "failed")) return "failed";
	if (items.some((item) => item.status === "unverified")) return "unverified";
	return "passed";
}

/** 只有检查通过的版本能自动成为下一轮基稿；failed/unverified 必须用户显式指定。 */
export function isUsableAsBase(inspection: Pick<DocumentInspection, "status"> | undefined): boolean {
	return inspection?.status === "passed";
}

/** 稳定序列化：准备摘要按这份规范文本计算，字段顺序不影响 digest。 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 无 Node 依赖的 base64url 编解码：绑定载荷要在 shared、主进程和扩展三处一致。 */
export function encodeBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += BASE64URL_ALPHABET[first >> 2];
		output += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
		if (second === undefined) break;
		output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
		if (third === undefined) break;
		output += BASE64URL_ALPHABET[third & 0x3f];
	}
	return output;
}

export function decodeBase64Url(value: string): string | undefined {
	const normalized = value.trim();
	if (!/^[A-Za-z0-9_-]*$/.test(normalized)) return undefined;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of normalized) {
		const index = BASE64URL_ALPHABET.indexOf(character);
		if (index < 0) return undefined;
		buffer = (buffer << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
	} catch {
		return undefined;
	}
}

/** 绑定载荷一进一出都过同一组字节上限；扩展不会因为载荷过大而拖垮会话。 */
export function encodeBindingPayload(payload: unknown): string | undefined {
	const text = JSON.stringify(payload);
	if (typeof text !== "string" || text.length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES) return undefined;
	return encodeBase64Url(text);
}

export function decodeBindingPayload(encoded: string): Record<string, unknown> | undefined {
	if (encoded.length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES * 2) return undefined;
	const text = decodeBase64Url(encoded);
	if (!text || text.length > DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** 可见标题只用于命名，身份始终是程序生成的 ID。 */
export function sanitizeWorkTitle(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
		.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 80) : fallback;
}

/** 工作目录名只由程序生成的 workId 派生并叠加可读标题，拒绝用户输入直接进路径。 */
export function buildWorkFolder(workId: string, title: string): string {
	const safeTitle = sanitizeWorkTitle(title, "").replace(/\s+/g, "-").slice(0, 40);
	return safeTitle ? `${workId}-${safeTitle}` : workId;
}

/** 版本显示序号与目录名：v0001 起步，固定 4 位便于人工浏览。 */
export function formatVersionDirectory(ordinal: number): string {
	return `v${String(ordinal).padStart(4, "0")}`;
}

export function kindForRequirements(kind: string): kind is "create_document" | "revise_document" {
	return kind === "create_document" || kind === "revise_document";
}

/** 结构化细节只允许标识与枚举，日志与 IPC 错误都不回显用户正文或绝对路径。 */
export function safeErrorDetail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length === 0 || value.length > 200) return undefined;
	if (/[\\/]/.test(value)) return undefined;
	if (/\s/.test(value)) return undefined;
	return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}
