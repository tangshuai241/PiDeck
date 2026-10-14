/**
 * 阅读页的状态与文案映射（纯函数）。
 *
 * 与 personalTodoState 同款分工：错误码 → 文案 key、运行期可用性 → 页面该显示哪一块。
 * 界面不落到服务端 message 上，也不用布尔 `ready` 冒充服务在线——`availability` 与
 * `notesApi`/`historyApi` 是三个独立事实（任务规则：入口可用性要真实页面状态）。
 */
import type { ReadingConnectionView, ReadingErrorCode, ReadingErrorInfo, ReadingPositionStaleReason, ReadingServiceStatus } from "../../../shared/types/reading";
import type { TranslationKey } from "../i18n";

/** 结构化错误码 → 文案 key（契约错误码表，界面不显示服务端原文）。 */
export function readingErrorKey(code: ReadingErrorCode): TranslationKey {
	switch (code) {
		case "unavailable":
			return "reading.errorUnavailable";
		case "needsConnection":
			return "reading.errorNeedsConnection";
		case "invalidInput":
			return "reading.errorInvalidInput";
		case "notFound":
			return "reading.errorNotFound";
		case "unsupported":
			return "reading.errorUnsupported";
		case "staleVersion":
			return "reading.errorStaleVersion";
		case "conflict":
			return "reading.errorConflict";
		case "unknownOutcome":
			return "reading.errorUnknownOutcome";
		case "writeFailed":
			return "reading.errorWriteFailed";
		case "secureStorageUnavailable":
			return "reading.errorSecureStorage";
		case "internalError":
		default:
			return "reading.errorInternal";
	}
}

export function readingErrorInfoKey(error: ReadingErrorInfo | null | undefined): TranslationKey | null {
	return error ? readingErrorKey(error.code) : null;
}

/** 位置陈旧原因：none 不提示，其余各给一句话（版本不符必须明确说清「已回到章首」）。 */
export function readingStaleReasonKey(reason: ReadingPositionStaleReason): TranslationKey | null {
	switch (reason) {
		case "versionMismatch":
			return "reading.positionStaleVersion";
		case "missing":
			return "reading.positionStaleMissing";
		case "none":
		default:
			return null;
	}
}

/**
 * 页面级可用性决策：来自 getStatus 的状态 + 读取错误 + 加载中的组合。
 * 刻意区分 `needsConnection`（服务活着但要密码，可以就地输入）与 `unavailable`（连不上），
 * 与 `unknown`（尚未探测出结果，等价于还没拿到）。
 */
export type ReadingAvailabilityDecision = { kind: "loading" } | { kind: "ready" } | { kind: "needsConnection" } | { kind: "unavailable"; errorKey: TranslationKey } | { kind: "unsupported"; errorKey: TranslationKey };

/**
 * 「曾成功连接」的唯一判定：`connected===true`（本次探测通过）或有有效 `lastConnectedAt`（历史上成功过）。
 * 刻意不把 credentialStored / authRequired 当成功证据：前者只说明本地存过凭据（未验证能否用），
 * 后者只是「服务要求密码」的探测结果（浏览器验收种子就是这样：无凭据、无成功历史、authRequired 未定）。
 */
export function readingConnectionHasPriorSuccess(connection: Pick<ReadingConnectionView, "connected" | "lastConnectedAt"> | null | undefined): boolean {
	if (!connection) return false;
	if (connection.connected === true) return true;
	return typeof connection.lastConnectedAt === "string" && connection.lastConnectedAt.length > 0;
}

export function resolveReadingAvailabilityDecision(input: { status: ReadingServiceStatus | null; error: ReadingErrorInfo | null; loading: boolean /** 是否曾成功连接（fresh/手动断开后为 false）：决定 unknown 是「回连接面板」还是「继续等」。 */; hasPriorSuccess?: boolean }): ReadingAvailabilityDecision {
	if (input.error !== null) {
		if (input.error.code === "needsConnection") return { kind: "needsConnection" };
		if (input.error.code === "unsupported") return { kind: "unsupported", errorKey: "reading.errorUnsupported" };
		return { kind: "unavailable", errorKey: readingErrorKey(input.error.code) };
	}
	if (input.loading || input.status === null) return { kind: "loading" };
	switch (input.status.availability) {
		case "ready":
			return { kind: "ready" };
		case "needsConnection":
			return { kind: "needsConnection" };
		case "unavailable":
			return { kind: "unavailable", errorKey: "reading.errorUnavailable" };
		case "unknown":
		default:
			// 未探测：从未成功过就回连接面板（不扫默认端口、不停在 loading）；成功过才继续等首次读取。
			return input.hasPriorSuccess === true ? { kind: "loading" } : { kind: "needsConnection" };
	}
}

/** 能力位（notesApi/historyApi）：null = 未探测，false = 服务未提供，true = 可用。 */
export type ReadingCapabilityState = "unknown" | "available" | "unsupported";

export function readingCapabilityState(flag: boolean | null): ReadingCapabilityState {
	if (flag === null) return "unknown";
	return flag ? "available" : "unsupported";
}

/** 能力不足时的说明：三个事实各自成句，避免一句「服务不可用」把正文也一起挡掉。 */
export function readingCapabilityNoticeKey(state: ReadingCapabilityState): TranslationKey | null {
	return state === "unsupported" ? "reading.capabilityUnsupported" : null;
}

/**
 * 请求是否可发：`invalidInput` 之类的调用方错误不该反复重试；`unsupported` 要停发该能力。
 * 界面据此决定按钮可用性（不做自动重试或轮询）。
 */
export function readingErrorIsRetryable(code: ReadingErrorCode): boolean {
	return code !== "unsupported" && code !== "invalidInput";
}
