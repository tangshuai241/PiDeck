/**
 * TPA 独立文稿：有界协议解析与版本校验（纯函数，不依赖任何运行时）。
 *
 * 主进程、Renderer 和 Pi 扩展共用同一套形状判定。扩展在 `resources/extensions/`
 * 下无法 import 本文件，故 `pi-deck-document-work-protocol.ts` 复制同一组常量，
 * 由 `tests/documentWorkContract.test.mjs` 逐字段比对，防止两侧漂移。
 *
 * 解析原则：三方输入（Renderer、模型、历史记录）都不可信。任何形状不符、超预算、
 * 未知版本或字段缺失都返回 undefined，由调用方转成结构化 `WorkResult` 错误；
 * 解析器从不抛异常，也从不补齐默认值伪造缺失字段。
 */
import {
	DOCUMENT_WORK_BUDGETS,
	DOCUMENT_WORK_SCHEMA_VERSION,
	DOCUMENT_WORK_STATE_TYPE,
	DOCUMENT_WORK_SNAPSHOT_TYPE,
	DOCUMENT_WORK_COMMAND,
	DOCUMENT_WORK_MATERIAL_TOOL,
	DOCUMENT_WORK_REPORT_TOOL,
	DOCUMENT_WORK_CONVERTER_VERSION,
	type AuthorizationReference,
	type DocumentArtifactCandidateReport,
	type DocumentArtifactFile,
	type DocumentArtifactVersion,
	type DocumentChangeScope,
	type DocumentInspection,
	type DocumentInspectionChannelResult,
	type DocumentInspectionStatus,
	type DocumentMaterialReference,
	type DocumentVersionProvenance,
	type DocumentWorkBindingState,
	type DocumentWorkKind,
	type DocumentWorkOperation,
	type DocumentWorkOperationState,
	type DocumentWorkPreparation,
	type DocumentWorkRecord,
	type DocumentWorkOutputRoot,
	type PreparationReference,
	type RequirementsReference,
	type WorkError,
	type WorkErrorCode,
	type WorkResult,
} from "./types/documentWork";

// 主进程模块直接从本文件引常量与结果类型，避免每处再写一遍 types 路径。
export { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_SCHEMA_VERSION, DOCUMENT_WORK_STATE_TYPE, DOCUMENT_WORK_SNAPSHOT_TYPE, DOCUMENT_WORK_COMMAND, DOCUMENT_WORK_MATERIAL_TOOL, DOCUMENT_WORK_REPORT_TOOL, DOCUMENT_WORK_CONVERTER_VERSION };
export type { WorkResult, WorkError, WorkErrorCode, AuthorizationReference, DocumentChangeScope, DocumentMaterialReference, DocumentWorkKind, DocumentWorkOperation, DocumentWorkPreparation, DocumentWorkRecord, DocumentWorkOutputRoot, PreparationReference, RequirementsReference };

/** 扩展侧需要逐字段比对的协议标识集合（契约测试的唯一比对源）。 */
export const DOCUMENT_WORK_PROTOCOL = {
	schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
	stateType: DOCUMENT_WORK_STATE_TYPE,
	snapshotType: DOCUMENT_WORK_SNAPSHOT_TYPE,
	command: DOCUMENT_WORK_COMMAND,
	materialTool: DOCUMENT_WORK_MATERIAL_TOOL,
	reportTool: DOCUMENT_WORK_REPORT_TOOL,
	converterVersion: DOCUMENT_WORK_CONVERTER_VERSION,
	budgets: DOCUMENT_WORK_BUDGETS,
} as const;

const WORK_ERROR_CODES: ReadonlySet<string> = new Set<WorkErrorCode>([
	"INVALID_INPUT",
	"WORK_NOT_FOUND",
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
	"IO_ERROR",
]);

const OPERATION_STATES: ReadonlySet<string> = new Set<DocumentWorkOperationState>(["prepared", "dispatching", "running", "inspecting", "archived", "failed", "interrupted", "unknown"]);
const INSPECTION_STATUSES: ReadonlySet<string> = new Set<DocumentInspectionStatus>(["passed", "failed", "unverified"]);
const WORK_KINDS: ReadonlySet<string> = new Set<DocumentWorkKind>(["create_document", "revise_document"]);
const BINDING_PHASES: ReadonlySet<string> = new Set(["bound", "running", "reported", "failed"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ID 形态：程序生成的有界非空字符串。 */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function isHexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isBoundedText(value: unknown, maxLength = 4000): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

export function isWorkErrorCode(value: unknown): value is WorkErrorCode {
	return typeof value === "string" && WORK_ERROR_CODES.has(value);
}

export function workOk<T>(value: T): WorkResult<T> {
	return { ok: true, value };
}

/** 结构化错误：跨越 IPC 边界只传代码与可判定字段，不抛裸异常。 */
export function workFail<T = never>(code: WorkErrorCode, retryable = false, extra: { currentRevision?: number; detail?: string } = {}): Extract<WorkResult<T>, { ok: false }> {
	return { ok: false, error: { code, retryable, ...(extra.currentRevision === undefined ? {} : { currentRevision: extra.currentRevision }), ...(extra.detail ? { detail: extra.detail } : {}) } };
}

export function parseWorkError(value: unknown): WorkError | undefined {
	if (!isRecord(value) || !isWorkErrorCode(value.code) || typeof value.retryable !== "boolean") return undefined;
	const currentRevision = value.currentRevision === undefined ? undefined : isNonNegativeInteger(value.currentRevision) ? value.currentRevision : undefined;
	if (value.currentRevision !== undefined && currentRevision === undefined) return undefined;
	return { code: value.code, retryable: value.retryable, ...(currentRevision === undefined ? {} : { currentRevision }), ...(isBoundedText(value.detail, 500) && value.detail ? { detail: value.detail } : {}) };
}

/**
 * 确定性 JSON 序列化：对象键按码位排序，数组保持顺序。
 * 同一逻辑载荷必须得到同一字符串，绑定摘要才可跨进程比对。
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value) ?? "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return "null";
}

/** 绑定载荷的规范字符串；两侧各自对其做 SHA-256，得到同一个 digest。 */
export function canonicalWorkBinding(payload: unknown): string {
	return canonicalJson(payload);
}

/** UTF-8 字节长度：shared 层不依赖 Buffer（Renderer 没有），但预算判定必须按字节。 */
export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			// 代理对合成一个码点（4 字节）；单独的代理项按 3 字节计，不猜测修复。
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url（无填充）：命令载荷用，避免空格/引号/换行进 RPC 消息。 */
export function encodeWorkBinding(payload: unknown): string {
	return base64UrlEncode(canonicalWorkBinding(payload));
}

/** 纯函数 base64url：两端（Node 主进程 / pi 扩展）得到同一字符串。 */
export function base64UrlEncode(value: string): string {
	const bytes: number[] = [];
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += BASE64URL_ALPHABET[first >> 2];
		output += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >> 4)];
		if (second !== undefined) output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >> 6)];
		if (third !== undefined) output += BASE64URL_ALPHABET[third & 0x3f];
	}
	return output;
}

/** base64url 解码；任何非法字符/长度返回 undefined（调用方按 INVALID_INPUT 处理）。 */
export function base64UrlDecode(value: string): string | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
	if (value.length % 4 === 1) return undefined;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of value) {
		const digit = BASE64URL_ALPHABET.indexOf(character);
		if (digit < 0) return undefined;
		buffer = (buffer << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	let decoded = "";
	for (let index = 0; index < bytes.length; ) {
		const first = bytes[index];
		if (first < 0x80) {
			decoded += String.fromCharCode(first);
			index += 1;
			continue;
		}
		const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 0;
		if (length === 0 || index + length > bytes.length) return undefined;
		let code = first & (0x7f >> length);
		for (let offset = 1; offset < length; offset++) {
			const next = bytes[index + offset];
			if ((next & 0xc0) !== 0x80) return undefined;
			code = (code << 6) | (next & 0x3f);
		}
		// 过长编码 / 代理区码点视为损坏输入。
		if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
		decoded += String.fromCodePoint(code);
		index += length;
	}
	return decoded;
}

/**
 * 解码 `/tpa-work bind` 载荷。超过字节上限、非 JSON、非对象或形态不符一律拒绝。
 * 只在内存中解码一次；调用方随后用同一规范字符串核对 digest。
 */
export function decodeWorkBinding(text: string, maxBytes = DOCUMENT_WORK_BUDGETS.bindPayloadBytes): Record<string, unknown> | undefined {
	if (typeof text !== "string" || !text || text.length > maxBytes * 2) return undefined;
	const trimmed = text.trim();
	// 只接受 base64url 字母表；其他编码形态在边界就拒绝，不尝试容错。
	if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
	const decoded = base64UrlDecode(trimmed);
	if (decoded === undefined) return undefined;
	if (utf8ByteLength(decoded) > maxBytes) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	// 重新编码必须与输入一致：拒绝重复键/非规范 JSON 等歧义载荷。
	return canonicalWorkBinding(parsed) === decoded ? parsed : undefined;
}

/** 相对路径判定的唯一实现：绝对路径、`..`、反斜杠、NUL、盘符一律拒绝。 */
export function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > DOCUMENT_WORK_BUDGETS.reportPathLength) return false;
	if (value.includes("\0") || value.includes("\\")) return false;
	if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
	return true;
}

/** 规范化成相对路径（posix 分隔符）；不规范时返回 undefined，不做"尽量修好"。 */
export function normalizeRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "");
	return isSafeRelativePath(normalized) ? normalized : undefined;
}

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

/** 修改范围规范化：去重、去空、有界；整篇授权必须是显式布尔真值。 */
export function normalizeChangeScope(value: unknown): DocumentChangeScope | undefined {
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
	// 整篇授权与保留块互斥：矛盾的保留要求要澄清，不能静默降级成"允许改"。
	if (wholeDocument && normalizedPreserve.length > 0) return undefined;
	if (!wholeDocument && normalizedAllow.length === 0) return undefined;
	return { allow: normalizedAllow, preserve: normalizedPreserve, wholeDocument };
}

function parseMaterialReferences(value: unknown): DocumentMaterialReference[] | undefined {
	if (!Array.isArray(value) || value.length > 64) return undefined;
	const materials: DocumentMaterialReference[] = [];
	for (const item of value) {
		if (!isRecord(item) || !isWorkId(item.materialId) || !isSafeRelativePath(item.relativePath) || !isHexDigest(item.sha256) || !isNonNegativeInteger(item.bytes) || !isBoundedText(item.converter, 80) || !item.converter) return undefined;
		materials.push({ materialId: item.materialId, relativePath: item.relativePath, sha256: item.sha256, bytes: item.bytes, converter: item.converter });
	}
	return materials;
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
	const requirementsRef = parseRequirementsReference(value.requirementsRef);
	const authorization = parseAuthorizationReference(value.authorization);
	const materials = parseMaterialReferences(value.materials);
	const base = parseBaseSelection(value.base);
	const scope = normalizeChangeScope(value.scope);
	if (!requirementsRef || !authorization || !materials || !scope) return undefined;
	if (!isSafeRelativePath(value.stagingRelativeDir) || !isSafeRelativePath(value.outputRelativeDir)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	const kind = value.kind as DocumentWorkKind;
	// 改稿必须有基稿：没有可用基稿时不能靠"最新文件"补一个。
	if (kind === "revise_document" && !base) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		preparationId: value.preparationId,
		kind,
		workRevision: value.workRevision,
		requirementsRef,
		authorization,
		materials,
		...(base ? { base } : {}),
		scope,
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
	if (!isSafeRelativePath(value.relativeDir) || !value.relativeDir.startsWith("versions/")) return undefined;
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
	if (!isBoundedText(value.sessionId, 200) || !value.sessionId || !isWorkId(value.workId) || !isWorkId(value.attemptId) || !isWorkId(value.preparationId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest || typeof value.phase !== "string" || !BINDING_PHASES.has(value.phase)) return undefined;
	if (value.reportId !== undefined && !isWorkId(value.reportId)) return undefined;
	if (value.kind !== undefined && (typeof value.kind !== "string" || !WORK_KINDS.has(value.kind))) return undefined;
	if (value.updatedAt !== undefined && !isNonNegativeInteger(value.updatedAt)) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
		sessionId: value.sessionId,
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
