/** Only these stable categories cross the title RPC and IPC boundaries. */
export const SESSION_TITLE_ERROR_CODES = ["TITLE_EXTENSION_UNAVAILABLE", "TITLE_MODEL_UNAVAILABLE", "TITLE_AUTH_UNAVAILABLE", "TITLE_PROVIDER_ERROR", "TITLE_TIMEOUT", "TITLE_INVALID_RESULT", "TITLE_RUNTIME_CHANGED", "TITLE_FAILED"] as const;
export type SessionTitleErrorCode = (typeof SESSION_TITLE_ERROR_CODES)[number];
export function sessionTitleErrorCode(value: unknown): SessionTitleErrorCode {
	return SESSION_TITLE_ERROR_CODES.find((code) => code === value) ?? "TITLE_FAILED";
}
