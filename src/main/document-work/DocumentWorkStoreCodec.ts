/**
 * TPA 独立文稿：存储编解码（纯函数）。
 *
 * 从 `DocumentWorkStore` 抽出，一是让存储文件专管写入语义，二是让"未知版本/损坏形态"
 * 的判定能单独测。这里只做形状校验与规范化：任何不符都返回 undefined，由存储层
 * 转入"损坏"路径（保留原文件、拒绝写入），不做字段补齐。
 */
import { DOCUMENT_WORK_SCHEMA_VERSION, isNonNegativeInteger, isRecord, isWorkId, parseArtifactVersion, parseOperation, parseOutputRoot, parsePreparation, parseWorkRecord } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentWorkOperation, DocumentWorkOutputRoot, DocumentWorkPreparation, DocumentWorkRecord } from "../../shared/types/documentWork";

export type DocumentWorkIndexState = {
	schemaVersion: number;
	revision: number;
	outputRoots: Record<string, DocumentWorkOutputRoot>;
	/** requestId → 归属（创建或某次操作）；去重与冲突判定的唯一台账。 */
	requests: Record<string, { workId: string; requestDigest: string; kind: "create" | "operation" }>;
	workIds: string[];
};

export type DocumentWorkBucketState = {
	schemaVersion: number;
	revision: number;
	record: DocumentWorkRecord;
	operations: Record<string, DocumentWorkOperation>;
	preparations: Record<string, DocumentWorkPreparation>;
	versions: DocumentArtifactVersion[];
};

export function emptyIndex(): DocumentWorkIndexState {
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: 0, outputRoots: {}, requests: {}, workIds: [] };
}

export function parseIndexState(value: unknown): DocumentWorkIndexState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION) return undefined;
	if (!isNonNegativeInteger(value.revision)) return undefined;
	if (!isRecord(value.outputRoots) || !isRecord(value.requests) || !Array.isArray(value.workIds)) return undefined;
	const outputRoots: Record<string, DocumentWorkOutputRoot> = {};
	for (const [id, root] of Object.entries(value.outputRoots)) {
		const parsed = parseOutputRoot(root);
		if (!parsed || parsed.outputRootId !== id) return undefined;
		outputRoots[id] = parsed;
	}
	const requests: DocumentWorkIndexState["requests"] = {};
	for (const [requestId, entry] of Object.entries(value.requests)) {
		if (!isWorkId(requestId) || !isRecord(entry) || !isWorkId(entry.workId) || typeof entry.requestDigest !== "string" || !entry.requestDigest || (entry.kind !== "create" && entry.kind !== "operation")) return undefined;
		requests[requestId] = { workId: entry.workId, requestDigest: entry.requestDigest, kind: entry.kind };
	}
	if (!value.workIds.every((item) => isWorkId(item))) return undefined;
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: value.revision, outputRoots, requests, workIds: [...(value.workIds as string[])] };
}

export function parseWorkBucket(value: unknown): DocumentWorkBucketState | undefined {
	if (!isRecord(value) || value.schemaVersion !== DOCUMENT_WORK_SCHEMA_VERSION || !isNonNegativeInteger(value.revision)) return undefined;
	const record = parseWorkRecord(value.record);
	if (!record) return undefined;
	if (!isRecord(value.operations) || !isRecord(value.preparations) || !Array.isArray(value.versions)) return undefined;
	const operations: Record<string, DocumentWorkOperation> = {};
	for (const [attemptId, operation] of Object.entries(value.operations)) {
		const parsed = parseOperation(operation);
		if (!parsed || parsed.attemptId !== attemptId) return undefined;
		operations[attemptId] = parsed;
	}
	const preparations: Record<string, DocumentWorkPreparation> = {};
	for (const [preparationId, preparation] of Object.entries(value.preparations)) {
		const parsed = parsePreparation(preparation);
		if (!parsed || parsed.preparationId !== preparationId) return undefined;
		preparations[preparationId] = parsed;
	}
	const versions: DocumentArtifactVersion[] = [];
	for (const version of value.versions) {
		const parsed = parseArtifactVersion(version);
		if (!parsed) return undefined;
		versions.push(parsed);
	}
	return { schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION, revision: value.revision, record, operations, preparations, versions };
}

export function canonicalJsonForStore(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
