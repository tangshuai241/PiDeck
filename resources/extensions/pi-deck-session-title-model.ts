/** 标题旁路使用固定默认模型及其原生认证，不改变主会话的模型。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TitleModelSelection = { provider: string; modelId: string };
const DEFAULT_MODEL: TitleModelSelection = { provider: "opencode-go", modelId: "deepseek-v4.1-flash" };

/** Command arguments and environment settings are data, never prompt instructions. */
function readModel(value: unknown): TitleModelSelection | undefined {
	if (typeof value !== "object" || value === null || !("provider" in value) || !("modelId" in value) || typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
	const provider = value.provider.trim();
	const modelId = value.modelId.trim();
	return provider && modelId && provider.length <= 200 && modelId.length <= 200 && !/[\x00-\x1f\x7f]/.test(provider + modelId) ? { provider, modelId } : undefined;
}

/** Legacy UUID-only commands retain the launch default; new hosts pass the latest saved selection. */
export function parseTitleCommand(args: string): { requestId: string; model?: TitleModelSelection } {
	if (/^[\w-]{1,80}$/.test(args)) return { requestId: args };
	if (args.length > 1500) throw new Error("TITLE_INVALID_REQUEST");
	const value: unknown = JSON.parse(args);
	if (typeof value !== "object" || value === null || !("requestId" in value) || typeof value.requestId !== "string" || !/^[\w-]{1,80}$/.test(value.requestId) || !("model" in value)) throw new Error("TITLE_INVALID_REQUEST");
	const model = readModel(value.model);
	if (!model) throw new Error("TITLE_INVALID_REQUEST");
	return { requestId: value.requestId, model };
}

export function resolveTitleModel(ctx: ExtensionContext, override?: TitleModelSelection): ExtensionContext["model"] {
	let configured = override;
	if (!configured) {
		try { configured = readModel(JSON.parse(process.env.PIDECK_TITLE_MODEL ?? "null")); } catch { /* Invalid legacy settings use the documented default. */ }
	}
	const selected = configured ?? DEFAULT_MODEL;
	// 缺失时关闭标题请求，不静默回退到主会话模型。
	return ctx.modelRegistry.find(selected.provider, selected.modelId);
}
