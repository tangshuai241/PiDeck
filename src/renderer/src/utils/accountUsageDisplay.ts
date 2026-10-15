/** Summary policy: show the tightest known window, with explicit remaining semantics. */
import type { QuotaResult, QuotaWindow } from "../../../shared/types/accountUsage";
export function primaryQuotaWindow(result: QuotaResult | undefined): QuotaWindow | undefined {
	if (result?.status !== "ready") return undefined;
	return result.windows.reduce<QuotaWindow | undefined>((chosen, row) => (!chosen || row.usedPercent > chosen.usedPercent ? row : chosen), undefined);
}
export function quotaCountdown(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
	const minutes = Math.ceil(Math.max(0, resetsAt - now) / 60000);
	if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `${minutes}m`;
}
