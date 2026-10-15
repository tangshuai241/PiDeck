/** Account count and visibility are user choices; each saved row has its own credential. */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { QUOTA_PROVIDERS, type QuotaAccount, type QuotaAccountInput } from "../../../../shared/types/accountUsage";
import type { AccountUsageController } from "../../hooks/useAccountUsage";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Switch } from "../ui-shadcn/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui-shadcn/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

export const QUOTA_PROVIDER_NAMES = { codex: "Codex", "opencode-go": "OpenCode Go", grok: "Grok", glm: "GLM (ZCode)" };
const newAccount = (): QuotaAccountInput => ({ provider: "opencode-go", name: "OpenCode Go", visible: true, source: "manual", region: "cn", credential: "" });
export function QuotaAccountManager({ controller, onClose }: { controller: AccountUsageController; onClose(): void }) {
	const { snapshot, busy } = controller;
	const [draft, setDraft] = useState<QuotaAccountInput | null>(null);
	const [formError, setFormError] = useState(false);
	const edit = (account: QuotaAccount) => {
		const { hasCredential: _hasCredential, ...fields } = account;
		setDraft({ ...fields, credential: "" });
		setFormError(false);
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" data-testid="quota-account-manager">
				<DialogHeader>
					<DialogTitle>{t("quota.manage")}</DialogTitle>
					<DialogDescription>{t("quota.accountHelp")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					{snapshot.accounts.map((account) => (
						<div key={account.id} className="flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2" data-testid="quota-account-row">
							<Switch
								checked={account.visible}
								disabled={busy}
								aria-label={t("quota.showAccount", { name: account.name })}
								onCheckedChange={(visible) => {
									void controller.save({ ...account, visible });
								}}
							/>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm">{account.name}</div>
								<div className="text-caption text-muted-foreground">{QUOTA_PROVIDER_NAMES[account.provider]}</div>
							</div>
							<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("quota.editAccount", { name: account.name })} onClick={() => edit(account)}>
								<Pencil className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={t("quota.removeAccount", { name: account.name })}
								onClick={() => {
									void controller.remove(account.id);
									if (draft?.id === account.id) setDraft(null);
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
				<Button
					variant="outline"
					disabled={busy || snapshot.accounts.length >= 32}
					onClick={() => {
						setDraft(newAccount());
						setFormError(false);
					}}
				>
					<Plus className="size-4" />
					{t("quota.add")}
				</Button>
				{draft && (
					<form
						className="space-y-3 rounded-lg border border-border p-3"
						onSubmit={(event) => {
							event.preventDefault();
							void controller.save(draft).then((ok) => {
								setFormError(!ok);
								if (ok) setDraft(null);
							});
						}}
					>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label htmlFor="quota-provider">{t("quota.provider")}</Label>
								<Select
									value={draft.provider}
									onValueChange={(provider) => {
										const match = QUOTA_PROVIDERS.find((item) => item === provider);
										if (match) setDraft({ ...draft, provider: match, name: QUOTA_PROVIDER_NAMES[match], credential: "" });
									}}
								>
									<SelectTrigger id="quota-provider">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{QUOTA_PROVIDERS.map((provider) => (
											<SelectItem key={provider} value={provider}>
												{QUOTA_PROVIDER_NAMES[provider]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label htmlFor="quota-name">{t("quota.name")}</Label>
								<Input id="quota-name" required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
							</div>
						</div>
						<div className="space-y-1">
							<Label htmlFor="quota-source">{t("quota.source")}</Label>
							<Select
								value={draft.source}
								onValueChange={(source) => {
									if (source === "local" || source === "manual") setDraft({ ...draft, source });
								}}
							>
								<SelectTrigger id="quota-source">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="local">{t("quota.local")}</SelectItem>
									<SelectItem value="manual">{t("quota.manual")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{draft.provider === "glm" && (
							<div className="space-y-1">
								<Label htmlFor="quota-region">{t("quota.region")}</Label>
								<Select
									value={draft.region}
									onValueChange={(region) => {
										if (region === "cn" || region === "global") setDraft({ ...draft, region });
									}}
								>
									<SelectTrigger id="quota-region">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="cn">{t("quota.cn")}</SelectItem>
										<SelectItem value="global">{t("quota.global")}</SelectItem>
									</SelectContent>
								</Select>
							</div>
						)}
						{draft.source === "manual" && (
							<div className="space-y-1">
								<Label htmlFor="quota-credential">{t("quota.credential")}</Label>
								<Input id="quota-credential" type="password" autoComplete="off" value={draft.credential ?? ""} placeholder={draft.id ? t("quota.keepCredential") : undefined} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} />
								<p className="text-caption text-muted-foreground">{t("quota.secureHelp")}</p>
							</div>
						)}
						{draft.source === "manual" && draft.provider === "codex" && (
							<div className="space-y-1">
								<Label htmlFor="quota-account-id">{t("quota.accountId")}</Label>
								<Input id="quota-account-id" value={draft.accountId ?? ""} placeholder={draft.id ? t("quota.keepCredential") : undefined} onChange={(event) => setDraft({ ...draft, accountId: event.target.value || undefined })} />
							</div>
						)}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setDraft(null)}>
								{t("quota.cancel")}
							</Button>
							<Button type="submit" disabled={busy || !draft.name.trim()}>
								{t("quota.save")}
							</Button>
						</div>
					</form>
				)}
				{(snapshot.error || formError) && (
					<p role="alert" className="text-sm text-destructive">
						{t(snapshot.error === "encryption" ? "quota.error.encryption" : "quota.error.storage")}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
