/** Normalize official subscription windows. Missing values remain unknown, never zero. */
import type { QuotaProvider, QuotaWindow } from "../../shared/types/accountUsage";
import { isBox } from "../config/quotaAccountConfig";
import { parseUsageResponseBody } from "../config/providerUsageProbe";

function number(value: unknown): number | undefined {
	if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}
function reset(value: unknown): number | undefined {
	const n = typeof value === "string" && !/^\d+(\.\d+)?$/.test(value) ? Date.parse(value) : number(value);
	return n !== undefined && Number.isFinite(n) && n > 0 ? (n < 100000000000 ? n * 1000 : n) : undefined;
}
function window(key: string, percent: unknown, resets: unknown): QuotaWindow[] {
	const used = number(percent);
	if (used === undefined) return [];
	const resetsAt = reset(resets);
	return [{ key, usedPercent: Math.max(0, Math.min(100, used)), ...(resetsAt ? { resetsAt } : {}) }];
}
export function parseQuotaWindows(provider: QuotaProvider, body: unknown): QuotaWindow[] {
	if (!isBox(body)) return [];
	if (provider === "opencode-go") {
		const usage = isBox(body.usage) ? body.usage : undefined;
		return ["rolling", "weekly", "monthly"].flatMap((key) => {
			const row = usage?.[key];
			return isBox(row) ? window(key, row.percent, row.resetsAt) : [];
		});
	}
	if (provider === "codex") {
		const limits = isBox(body.rate_limit) ? body.rate_limit : undefined;
		return ["primary", "secondary"].flatMap((key) => {
			const row = limits?.[`${key}_window`];
			if (!isBox(row)) return [];
			const seconds = number(row.limit_window_seconds);
			const label = seconds === 18000 ? "rolling" : seconds === 604800 ? "weekly" : seconds === 2592000 ? "monthly" : key;
			return window(label, row.used_percent, row.reset_at);
		});
	}
	if (provider === "glm") {
		const data = isBox(body.data) ? body.data : body;
		return (Array.isArray(data.limits) ? data.limits : []).flatMap((row) => {
			if (!isBox(row)) return [];
			const total = number(row.usage);
			const used = number(row.currentValue) ?? (total !== undefined && number(row.remaining) !== undefined ? total - Number(row.remaining) : undefined);
			const percent = total !== undefined && total > 0 && used !== undefined ? (used / total) * 100 : row.percentage;
			const key = row.type === "TIME_LIMIT" ? "mcp" : row.unit === 3 ? "rolling" : row.unit === 6 ? "weekly" : "monthly";
			return window(key, percent, row.nextResetTime);
		});
	}
	// Grok's cent wrappers and optional on-demand budget already have a dedicated parser.
	const parsed = parseUsageResponseBody(isBox(body.config) ? body : { config: body }, "", { kind: "custom", resolver: "xai-billing" });
	const config = isBox(body.config) ? body.config : body;
	const period = isBox(config.currentPeriod) ? config.currentPeriod : undefined;
	return (parsed.credits?.windows ?? []).flatMap((row) => window(row.key, row.total && row.used !== undefined ? (row.used / row.total) * 100 : undefined, row.key === "onDemand" ? config.billingPeriodEnd : (period?.end ?? config.billingPeriodEnd)));
}
