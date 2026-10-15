/** Title model preference shared by settings, process launch and the manual RPC request. */
export type SessionTitleModel = { provider: string; modelId: string };
export const DEFAULT_SESSION_TITLE_MODEL: Readonly<SessionTitleModel> = { provider: "opencode-go", modelId: "deepseek-v4.1-flash" };

/** Missing or invalid legacy settings use the explicit default; identifiers may contain URL syntax. */
export function normalizeSessionTitleModel(value: unknown): SessionTitleModel {
	if (typeof value === "object" && value !== null && "provider" in value && "modelId" in value && typeof value.provider === "string" && typeof value.modelId === "string") {
		const provider = value.provider.trim();
		const modelId = value.modelId.trim();
		if (provider && modelId && provider.length <= 200 && modelId.length <= 200 && !/[\x00-\x1f\x7f]/.test(provider + modelId)) return { provider, modelId };
	}
	return { ...DEFAULT_SESSION_TITLE_MODEL };
}
