/** A single footer, outside all panes, owns the account roster and quota details. */
import { useState } from "react";
import { Gauge, RefreshCw, Settings2 } from "lucide-react";
import type { QuotaAccount, QuotaResult } from "../../../../shared/types/accountUsage";
import { useAccountUsage } from "../../hooks/useAccountUsage";
import { t } from "../../i18n";
import { primaryQuotaWindow, quotaCountdown } from "../../utils/accountUsageDisplay";
import { usageToneForPercent, USAGE_TONE_TEXT_CLASS, USAGE_TONE_BAR_CLASS } from "../../utils/providerUsageDisplay";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { QuotaAccountManager } from "./QuotaAccountManager";
import { QuotaProviderIcon } from "./QuotaProviderIcon";

function QuotaItem({ account, result, now, busy, refresh, manage }: { account: QuotaAccount; result?: QuotaResult; now: number; busy: boolean; refresh(): void; manage(): void }) {
	const primary = primaryQuotaWindow(result);
	const countdown = quotaCountdown(primary?.resetsAt, now);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="xs" className="h-5 shrink-0 gap-1.5 rounded px-1.5 py-0 text-[length:min(var(--font-size-micro),11px)] font-normal leading-none" aria-label={account.name} title={account.name} data-testid="quota-bar-account" data-account-id={account.id}>
					<QuotaProviderIcon provider={account.provider} />
					{primary ? (
						<span className={`tabular-nums ${USAGE_TONE_TEXT_CLASS[usageToneForPercent(primary.usedPercent)]}`}>{t("quota.remaining", { n: Math.round(100 - primary.usedPercent) })}</span>
					) : (
						<span className="text-muted-foreground">{result?.status === "error" ? t("quota.unavailable") : t("quota.waiting")}</span>
					)}
					{countdown && <span className="text-muted-foreground tabular-nums">{countdown}</span>}
				</Button>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-24px)] space-y-3" data-testid="quota-details">
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-[length:var(--font-size-caption)] font-medium">{account.name}</span>
					<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("quota.refresh")} onClick={refresh}>
						<RefreshCw className={`size-3.5 ${busy ? "motion-safe:animate-spin" : ""}`} />
					</Button>
				</div>
				{result?.windows.map((row, index) => {
					const tone = usageToneForPercent(row.usedPercent);
					const time = quotaCountdown(row.resetsAt, now);
					const keys = { rolling: "quota.window.rolling", weekly: "quota.window.weekly", monthly: "quota.window.monthly", primary: "quota.window.primary", secondary: "quota.window.secondary", mcp: "quota.window.mcp", included: "quota.window.subscription", onDemand: "quota.window.onDemand" } as const;
					const label = Object.entries(keys).find(([key]) => key === row.key)?.[1];
					return (
						<div key={`${row.key}:${index}`} className="space-y-1">
							<div className="flex justify-between gap-2 text-caption">
								<span>{label ? t(label) : row.key}</span>
								<span className={USAGE_TONE_TEXT_CLASS[tone]}>{t("quota.remaining", { n: Math.round(100 - row.usedPercent) })}</span>
							</div>
							<div className="h-1.5 overflow-hidden rounded-full bg-muted">
								<div className={`h-full ${USAGE_TONE_BAR_CLASS[tone]}`} style={{ width: `${row.usedPercent}%` }} />
							</div>
							<div className="flex justify-between text-micro text-muted-foreground">
								<span>{t("quota.used", { n: Math.round(row.usedPercent) })}</span>
								<span title={row.resetsAt ? new Date(row.resetsAt).toLocaleString() : undefined}>{time ? t("quota.resetsIn", { time }) : t("quota.resetUnknown")}</span>
							</div>
						</div>
					);
				})}
				{result?.error && (
					<p role="status" className="text-caption text-muted-foreground">
						{t(`quota.error.${result.error}`)}
					</p>
				)}
				{!result && <p className="text-caption text-muted-foreground">{t("quota.waiting")}</p>}
				{result && <p className="text-micro text-muted-foreground">{t("quota.updatedAt", { time: new Date(result.updatedAt).toLocaleTimeString() })}</p>}
				<Button variant="outline" className="h-7 w-full text-[length:var(--font-size-caption)]" onClick={manage}>
					<Settings2 className="size-3.5" />
					{t("quota.manage")}
				</Button>
			</PopoverContent>
		</Popover>
	);
}

export function AccountUsageBar() {
	const controller = useAccountUsage();
	const [manageOpen, setManageOpen] = useState(false);
	return (
		<footer className="grid h-7 min-h-7 shrink-0 grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center border-t border-border bg-background px-2 text-foreground" data-testid="account-usage-bar">
			<Button variant="ghost" size="icon-xs" className="size-6" aria-label={t("quota.title")} title={t("quota.manage")} onClick={() => setManageOpen(true)}>
				<Gauge className="size-3" />
			</Button>
			<div className="flex min-w-0 justify-center overflow-hidden">
				<div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto" data-testid="quota-bar-roster">
					{controller.snapshot.accounts
						.filter((account) => account.visible)
						.map((account) => (
							<QuotaItem
								key={account.id}
								account={account}
								result={controller.snapshot.results[account.id]}
								now={controller.now}
								busy={controller.busy}
								refresh={() => {
									void controller.refresh(account.id);
								}}
								manage={() => setManageOpen(true)}
							/>
						))}
					{controller.snapshot.error && (
						<span role="status" className="shrink-0 px-2 text-[length:var(--font-size-micro)] text-destructive">
							{t("quota.error.storage")}
						</span>
					)}
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				className="size-6 shrink-0"
				disabled={controller.busy}
				aria-label={t("quota.refreshAll")}
				onClick={() => {
					void controller.refresh();
				}}
			>
				<RefreshCw className={`size-3 ${controller.busy ? "motion-safe:animate-spin" : ""}`} />
			</Button>
			{manageOpen && <QuotaAccountManager controller={controller} onClose={() => setManageOpen(false)} />}
		</footer>
	);
}
