/**
 * TPA 独立文稿：Pi 侧协议（常量、形状判定、路径校验）。
 *
 * 扩展跑在 pi 进程里，无法 import `src/shared/`，因此这里保留同一组常量的副本。
 * `tests/documentWorkContract.test.mjs` 逐字段比对两份常量，任何一侧漂移都会红灯。
 *
 * 三层输入都不可信：主进程下来的绑定载荷可能损坏、模型给的汇报路径可能逃逸、
 * 历史分支里的快照可能来自旧版本。判定一律 fail-closed：形状不符/超预算/未知版本
 * 直接返回 undefined，不补齐默认值也不猜。
 */
import { createHash } from "node:crypto";

export const DOCUMENT_WORK_PROTOCOL = {
	schemaVersion: 1,
	stateType: "tpa-document-work-state",
	snapshotType: "tpa-document-work-snapshot",
	command: "tpa-work",
	materialTool: "tpa_read_material",
	reportTool: "tpa_artifact_report",
	converterVersion: "anydoc-v1",
	budgets: {
		bindPayloadBytes: 64 * 1024,
		reportBytes: 64 * 1024,
		reportFiles: 32,
		reportPathLength: 1024,
		artifactBytes: 32 * 1024 * 1024,
		ooxmlTotalBytes: 64 * 1024 * 1024,
		ooxmlPartBytes: 8 * 1024 * 1024,
		ooxmlParts: 10000,
		inspectionMs: 2000,
		conversionMs: 120000,
		materialBytes: 64 * 1024 * 1024,
		concurrentInspections: 2,
		concurrentConversions: 2,
		bindAckMs: 20000,
		settleMs: 15 * 60_000,
	},
} as const;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function isBoundedText(value: unknown, maxLength = 4000): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

export function isHexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** 相对路径形态：绝对路径、`..`、反斜杠、NUL、盘符一律拒绝。 */
export function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > DOCUMENT_WORK_PROTOCOL.budgets.reportPathLength) return false;
	if (value.includes("\0") || value.includes("\\")) return false;
	if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
	return !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

/** 规范 JSON（键排序）：绑定摘要两侧必须得到同一字符串。 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value) ?? "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return "null";
}

export type DocumentChangeScope = { allow: string[]; preserve: string[]; wholeDocument: boolean };

function parseScope(value: unknown): DocumentChangeScope | undefined {
	if (!isRecord(value) || !Array.isArray(value.allow) || !Array.isArray(value.preserve)) return undefined;
	if (value.allow.length > 200 || value.preserve.length > 200) return undefined;
	if (!value.allow.every((item) => isBoundedText(item, 500)) || !value.preserve.every((item) => isBoundedText(item, 500))) return undefined;
	if (typeof value.wholeDocument !== "boolean") return undefined;
	return { allow: [...(value.allow as string[])], preserve: [...(value.preserve as string[])], wholeDocument: value.wholeDocument };
}

export type DocumentMaterialBinding = { materialId: string; relativePath: string; sha256: string; converter: string };

export type DocumentWorkBindingPayload = {
	schemaVersion: 1;
	sessionId: string;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	kind: "create_document" | "revise_document";
	stagingRelativeDir: string;
	outputRelativeDir: string;
	outputRootPath: string;
	materials: DocumentMaterialBinding[];
	base?: { relativePath: string; sha256: string };
	scope: DocumentChangeScope;
	budgetBytes: number;
	/** 本轮对应哪份确认单（初稿轮）；改稿轮没有这一项。 */
	briefId?: string;
	briefRevision?: number;
};

/**
 * 解码 `/tpa-work bind` 的 base64url 载荷。
 * 重新编码必须与输入完全一致——拒绝重复键、非规范 JSON 和任何多余字段。
 */
export function decodeBindingPayload(encoded: string): DocumentWorkBindingPayload | undefined {
	if (typeof encoded !== "string" || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
	if (encoded.length > DOCUMENT_WORK_PROTOCOL.budgets.bindPayloadBytes * 2) return undefined;
	let decoded: string;
	try {
		decoded = Buffer.from(encoded, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(decoded, "utf8") > DOCUMENT_WORK_PROTOCOL.budgets.bindPayloadBytes) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || canonicalJson(parsed) !== decoded) return undefined;
	return parseBindingPayload(parsed);
}

export function parseBindingPayload(value: unknown): DocumentWorkBindingPayload | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_PROTOCOL.schemaVersion) return undefined;
	if (!isBoundedText(value.sessionId, 200) || !value.sessionId) return undefined;
	if (!isBoundedId(value.workId) || !isBoundedId(value.attemptId) || !isBoundedId(value.preparationId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	if (value.kind !== "create_document" && value.kind !== "revise_document") return undefined;
	if (!isSafeRelativePath(value.stagingRelativeDir) || !isSafeRelativePath(value.outputRelativeDir)) return undefined;
	if (!isBoundedText(value.outputRootPath, 4000) || !value.outputRootPath) return undefined;
	const scope = parseScope(value.scope);
	if (!scope) return undefined;
	if (!Array.isArray(value.materials) || value.materials.length > 32) return undefined;
	const materials: DocumentMaterialBinding[] = [];
	for (const item of value.materials) {
		if (!isRecord(item) || !isBoundedId(item.materialId) || !isSafeRelativePath(item.relativePath) || !isHexDigest(item.sha256) || !isBoundedText(item.converter, 80) || !item.converter) return undefined;
		materials.push({ materialId: item.materialId, relativePath: item.relativePath, sha256: item.sha256, converter: item.converter });
	}
	let base: { relativePath: string; sha256: string } | undefined;
	if (value.base !== undefined) {
		if (!isRecord(value.base) || !isSafeRelativePath(value.base.relativePath) || !isHexDigest(value.base.sha256)) return undefined;
		base = { relativePath: value.base.relativePath, sha256: value.base.sha256 };
	}
	if (!isBoundedText(value.outputRootPath, 4000)) return undefined;
	const briefId = value.briefId === undefined ? undefined : isBoundedId(value.briefId) ? value.briefId : null;
	if (briefId === null) return undefined;
	if (value.briefRevision !== undefined && !(typeof value.briefRevision === "number" && Number.isSafeInteger(value.briefRevision) && value.briefRevision >= 0)) return undefined;
	if (briefId === undefined && value.briefRevision !== undefined) return undefined;
	return {
		schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
		sessionId: value.sessionId,
		workId: value.workId,
		attemptId: value.attemptId,
		preparationId: value.preparationId,
		digest: value.digest,
		kind: value.kind,
		stagingRelativeDir: value.stagingRelativeDir,
		outputRelativeDir: value.outputRelativeDir,
		outputRootPath: value.outputRootPath,
		materials,
		...(base ? { base } : {}),
		scope,
		budgetBytes: typeof value.budgetBytes === "number" && Number.isSafeInteger(value.budgetBytes) && value.budgetBytes > 0 ? value.budgetBytes : DOCUMENT_WORK_PROTOCOL.budgets.artifactBytes,
		...(briefId === undefined ? {} : { briefId }),
		...(value.briefRevision === undefined ? {} : { briefRevision: value.briefRevision as number }),
	};
}

/** 绑定摘要：与主进程用同一规范字符串。 */
export function bindingDigest(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** 内容指纹：材料与成果文件都用它。 */
export function contentDigest(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** 绑定状态：`details.documentWork`，与主进程 parseBindingState 字段一致。 */
export type DocumentWorkBindingState = {
	schemaVersion: 1;
	sessionId: string;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	phase: "bound" | "running" | "reported" | "failed";
	reportId?: string;
	kind?: "create_document" | "revise_document";
	stagingRelativeDir?: string;
	updatedAt?: number;
};

export function parseBindingState(value: unknown): DocumentWorkBindingState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_PROTOCOL.schemaVersion) return undefined;
	if (!isBoundedText(value.sessionId, 200) || !value.sessionId || !isBoundedId(value.workId) || !isBoundedId(value.attemptId) || !isBoundedId(value.preparationId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	if (value.phase !== "bound" && value.phase !== "running" && value.phase !== "reported" && value.phase !== "failed") return undefined;
	if (value.reportId !== undefined && !isBoundedId(value.reportId)) return undefined;
	const state: DocumentWorkBindingState = {
		schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
		sessionId: value.sessionId,
		workId: value.workId,
		attemptId: value.attemptId,
		preparationId: value.preparationId,
		digest: value.digest,
		phase: value.phase,
	};
	if (isBoundedId(value.reportId)) state.reportId = value.reportId;
	if (value.kind === "create_document" || value.kind === "revise_document") state.kind = value.kind;
	if (isSafeRelativePath(value.stagingRelativeDir)) state.stagingRelativeDir = value.stagingRelativeDir;
	if (typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt)) state.updatedAt = value.updatedAt;
	return state;
}

/** 成果候选汇报（工具参数 → 隐藏消息 details.report）。 */
export type DocumentArtifactCandidateReport = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	reportId: string;
	artifacts: string[];
	editableSources: string[];
	summary: string;
	risks: string[];
};

export function parseArtifactReport(value: unknown): DocumentArtifactCandidateReport | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_PROTOCOL.schemaVersion) return undefined;
	if (!isBoundedId(value.workId) || !isBoundedId(value.attemptId) || !isBoundedId(value.preparationId) || !isBoundedId(value.reportId)) return undefined;
	if (!isBoundedText(value.digest, 200) || !value.digest) return undefined;
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > DOCUMENT_WORK_PROTOCOL.budgets.reportFiles) return undefined;
	if (!value.artifacts.every((item) => isSafeRelativePath(item))) return undefined;
	if (!Array.isArray(value.editableSources) || value.editableSources.length > DOCUMENT_WORK_PROTOCOL.budgets.reportFiles || !value.editableSources.every((item) => isSafeRelativePath(item))) return undefined;
	if (!isBoundedText(value.summary, 4000)) return undefined;
	if (!Array.isArray(value.risks) || value.risks.length > 20 || !value.risks.every((item) => isBoundedText(item, 500))) return undefined;
	const report: DocumentArtifactCandidateReport = {
		schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
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
	return Buffer.byteLength(canonicalJson(report), "utf8") <= DOCUMENT_WORK_PROTOCOL.budgets.reportBytes ? report : undefined;
}

export function ensureTrailingSeparatorFree(value: string): string {
	return value.replace(/[/\\]+$/, "");
}

/** 汇报路径必须落在本轮 staging 目录内；越界直接拒绝。 */
export function isInsideStaging(stagingRelativeDir: string, candidate: string): boolean {
	return isSafeRelativePath(candidate) && candidate.startsWith(`${stagingRelativeDir}/`) && !candidate.includes("/_tpa/");
}
