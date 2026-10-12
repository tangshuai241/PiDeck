/**
 * 写接口的持久化回执与有界解析。
 *
 * 为什么要单独一层：`requestId` 去重必须能重放**原始结果**，包括失败与 `unknown`。
 * 只存成功值会让「同 requestId 重放」在失败路径上重新执行一次副作用。
 */
import { isRecord, isWorkErrorCode, isRetryableWorkError, workSuccess, type WorkResult } from "../../shared/documentWork";
import { parseDocumentWorkOperation, parseWorkError } from "../../shared/documentWorkRecords";
import type { DocumentWorkOperation, PreparedWork, PreparationReference, WorkErrorCode } from "../../shared/types/documentWork";

/** 台账里保存的结果形态：成功值或结构化错误，二选一。 */
export type WorkReceipt<T> = { ok: true; value: T } | { ok: false; error: { code: WorkErrorCode; retryable: boolean; detail?: string; currentRevision?: number } };

export function encodeReceipt<T>(result: WorkResult<T>): WorkReceipt<T> {
	return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}

/**
 * 回执解析：成功回执交给调用方的 `parseValue` 做有界校验；失败回执直接用结构化错误，
 * 不再执行任何动作。返回 undefined 表示台账内容不可用（调用方 fail-closed）。
 */
export function decodeReceipt<T>(payload: unknown, parseValue: (value: unknown) => T | undefined): WorkResult<T> | undefined {
	if (!isRecord(payload)) return undefined;
	if (payload.ok === true) {
		const value = parseValue(payload.value);
		return value === undefined ? undefined : workSuccess(value);
	}
	if (payload.ok === false) {
		const error = parseWorkError(payload.error);
		if (!error) return undefined;
		return { ok: false, error };
	}
	return undefined;
}

/** 旧格式回执兼容：历史台账里直接存了成功值。 */
export function decodeLegacyReceipt<T>(payload: unknown, parseValue: (value: unknown) => T | undefined): WorkResult<T> | undefined {
	const value = parseValue(payload);
	return value === undefined ? undefined : workSuccess(value);
}

export function readStringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

/** 结构化 detail 只允许标识与枚举，禁止把路径或正文写进错误。 */
export function safeDetail(detail: string): string {
	return /^[A-Za-z0-9_.:-]{1,200}$/.test(detail) ? detail : "detail_redacted";
}

export function workErrorFor(code: WorkErrorCode, detail?: string, currentRevision?: number) {
	return { code, retryable: isRetryableWorkError(code), ...(detail ? { detail: safeDetail(detail) } : {}), ...(currentRevision !== undefined ? { currentRevision } : {}) };
}

export function failureOfDetail<T>(code: WorkErrorCode, detail?: string): WorkResult<T> {
	return { ok: false, error: workErrorFor(code, detail) };
}

export function isKnownWorkErrorCode(value: unknown): value is WorkErrorCode {
	return isWorkErrorCode(value);
}

/** 建立回执：只回 workId，读取路径再按会话归属核对一次。 */
export function parseCreatePayload(value: unknown): { workId: string } | undefined {
	const workId = readStringField(value, "workId");
	return workId ? { workId } : undefined;
}

/** 准备回执：新格式（含失败）与旧格式（只存成功值）都要读得懂。 */
export function parsePreparationPayload(value: unknown): PreparedWork | undefined {
	const workId = readStringField(value, "workId");
	const summary = readStringField(value, "summary");
	const workRevision = typeof value === "object" && value !== null ? Reflect.get(value, "workRevision") : undefined;
	const preparationValue = typeof value === "object" && value !== null ? Reflect.get(value, "preparation") : undefined;
	const preparationId = readStringField(preparationValue, "preparationId");
	const digest = readStringField(preparationValue, "digest");
	if (!workId || typeof workRevision !== "number" || summary === undefined || !preparationId || !digest) return undefined;
	const preparation: PreparationReference = { preparationId, digest };
	return { workId, workRevision, preparation, summary };
}

/**
 * 开始回执：返回原操作记录（含 phase/versionId/error），重放不重新分发。
 * 用与磁盘同一套解析器校验：回执也是不可信输入，缺字段就不能当成有效回执。
 */
export function parseOperationPayload(value: unknown): DocumentWorkOperation | undefined {
	return parseDocumentWorkOperation(value);
}

/** 取消回执：只回 attemptId。 */
export function parseCancelPayload(value: unknown): { attemptId: string } | undefined {
	const attemptId = readStringField(value, "attemptId");
	return attemptId ? { attemptId } : undefined;
}
