/** Desktop quota accounts have stable identities, independent from model providers. */
export const QUOTA_PROVIDERS = ["codex", "opencode-go", "grok", "glm"] as const;
export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];
export type QuotaAccount = {
	id: string;
	provider: QuotaProvider;
	name: string;
	visible: boolean;
	source: "local" | "manual";
	region: "cn" | "global";
	hasCredential: boolean;
};
export type QuotaAccountInput = Omit<QuotaAccount, "id" | "hasCredential"> & {
	id?: string;
	/** Write only: an empty value preserves the saved credential. */
	credential?: string;
	accountId?: string;
};
export type QuotaWindow = { key: string; usedPercent: number; resetsAt?: number };
export type QuotaResult = {
	status: "ready" | "error";
	windows: QuotaWindow[];
	updatedAt: number;
	error?: "credentials" | "unauthorized" | "network" | "timeout" | "unsupported" | "storage";
};
export type QuotaSnapshot = { accounts: QuotaAccount[]; results: Record<string, QuotaResult>; error?: "storage" | "invalid" | "encryption" };
