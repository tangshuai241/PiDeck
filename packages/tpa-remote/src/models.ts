import { isRecord } from "./crypto.ts";
import type { ModelChoice, RemoteModel } from "./types.ts";

const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
/** Model identity is provider plus ID, never a display label or a credential. */
export function parseModelChoice(value: unknown): ModelChoice {
	if (!isRecord(value) || !identifier(value.provider) || !identifier(value.modelId)) throw new Error("INVALID_MODEL");
	return { provider: value.provider, modelId: value.modelId };
}
/** Bound and normalize the public part of Pi's model catalog. */
export function parseModels(value: unknown): RemoteModel[] {
	if (!Array.isArray(value) || value.length > 2000) throw new Error("INVALID_MODELS");
	return value.map((item) => {
		if (!isRecord(item) || !identifier(item.provider) || !identifier(item.id)) throw new Error("INVALID_MODELS");
		return { provider: item.provider, id: item.id, name: typeof item.name === "string" ? item.name.slice(0, 200) : item.id };
	});
}
