/** Account-isolated, bounded quota queries. Credentials never cross the preload boundary. */
import { randomUUID } from "node:crypto";
import type { QuotaAccountInput, QuotaResult, QuotaSnapshot } from "../../shared/types/accountUsage";
import { QuotaAccountConfig, isBox, type StoredQuotaAccount } from "../config/quotaAccountConfig";
import { readQuotaLocalCredential, type QuotaCredential } from "../config/quotaLocalCredentials";
import { usageProbeRequest, type UsageProbeRequestInit, type UsageProbeHttpResult } from "../config/usageProbeTransport";
import { parseQuotaWindows } from "./quotaParsers";

type Request = (url: string, init: UsageProbeRequestInit) => Promise<UsageProbeHttpResult>;
type CredentialReader = (account: StoredQuotaAccount) => Promise<QuotaCredential | undefined>;
/** Login HTML and invalid JSON are unsupported responses, never authentication-file errors. */
function parseBody(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}
export class AccountUsageService {
	private readonly results = new Map<string, QuotaResult>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private mutations: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly config: QuotaAccountConfig,
		private readonly request: Request = usageProbeRequest,
		private readonly readCredential: CredentialReader = readQuotaLocalCredential,
	) {}
	async list(): Promise<QuotaSnapshot> {
		try {
			const accounts = await this.config.load();
			return {
				accounts: accounts.map(({ secret, accountId: _accountId, ...account }) => ({ ...account, hasCredential: !!secret })),
				results: Object.fromEntries(
					accounts.flatMap((account) => {
						const result = this.results.get(account.id);
						return result ? [[account.id, result]] : [];
					}),
				),
			};
		} catch {
			return { accounts: [], results: {}, error: "storage" };
		}
	}
	/** Serialize writes so saving two accounts cannot lose the earlier write. */
	private mutate(operation: () => Promise<QuotaSnapshot>): Promise<QuotaSnapshot> {
		const pending = this.mutations.then(operation, operation);
		this.mutations = pending.catch(() => undefined);
		return pending;
	}
	save(input: QuotaAccountInput): Promise<QuotaSnapshot> {
		return this.mutate(async () => {
			try {
				const accounts = await this.config.load();
				const old = accounts.find((account) => account.id === input.id);
				if ((input.id && !old) || (!old && accounts.length >= 32)) return { ...(await this.list()), error: "invalid" };
				let secret = old?.provider === input.provider ? old.secret : undefined;
				if (input.source === "manual" && input.credential?.trim()) {
					try {
						secret = this.config.cipher.encrypt(input.credential.trim());
					} catch {
						return { ...(await this.list()), error: "encryption" };
					}
				}
				if (input.source === "manual" && !secret) return { ...(await this.list()), error: "invalid" };
				const account: StoredQuotaAccount = {
					id: old?.id ?? randomUUID(),
					provider: input.provider,
					name: input.name.trim(),
					visible: input.visible,
					source: input.source,
					region: input.region,
					...(input.source === "manual" && secret ? { secret } : {}),
					...(input.accountId || old?.accountId ? { accountId: input.accountId || old?.accountId } : {}),
				};
				await this.config.write(old ? accounts.map((row) => (row.id === old.id ? account : row)) : [...accounts, account]);
				this.results.delete(account.id);
				return this.list();
			} catch {
				return { ...(await this.list()), error: "storage" };
			}
		});
	}
	remove(id: string): Promise<QuotaSnapshot> {
		return this.mutate(async () => {
			try {
				await this.config.write((await this.config.load()).filter((row) => row.id !== id));
				this.results.delete(id);
				return this.list();
			} catch {
				return { ...(await this.list()), error: "storage" };
			}
		});
	}
	async refresh(id?: string): Promise<QuotaSnapshot> {
		let accounts: StoredQuotaAccount[];
		try {
			accounts = await this.config.load();
		} catch {
			return { accounts: [], results: {}, error: "storage" };
		}
		// Sequential refresh bounds pressure on providers; concurrent clicks share each account's request.
		for (const account of accounts.filter((row) => (id ? row.id === id : row.visible))) {
			let pending = this.inFlight.get(account.id);
			if (!pending) {
				pending = this.fetch(account).finally(() => {
					this.inFlight.delete(account.id);
				});
				this.inFlight.set(account.id, pending);
			}
			await pending;
		}
		return this.list();
	}
	private credential(account: StoredQuotaAccount): Promise<QuotaCredential | undefined> {
		return account.source === "local" ? this.readCredential(account) : Promise.resolve(account.secret ? { token: this.config.cipher.decrypt(account.secret), accountId: account.accountId } : undefined);
	}
	private async fetch(account: StoredQuotaAccount): Promise<void> {
		let result: QuotaResult = { status: "error", windows: [], updatedAt: Date.now(), error: "credentials" };
		let resolvedCredential = false;
		try {
			const credential = await this.credential(account);
			if (credential) {
				resolvedCredential = true;
				const headers: Record<string, string> = { Authorization: `Bearer ${credential.token}`, Accept: "application/json" };
				let url = "";
				if (account.provider === "codex") {
					url = "https://chatgpt.com/backend-api/wham/usage";
					if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
				}
				if (account.provider === "opencode-go") url = "https://opencode.ai/zen/go/v1/usage";
				if (account.provider === "glm") {
					url = `https://${account.region === "global" ? "api.z.ai" : "open.bigmodel.cn"}/api/monitor/usage/quota/limit`;
					headers.Authorization = credential.token;
				}
				const init: UsageProbeRequestInit = { headers, timeoutMs: 10000, maxBytes: 1024 * 1024 };
				if (account.provider === "grok") {
					url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
					Object.assign(headers, { "X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": "1.0.10", "x-grok-client-mode": "interactive" });
					const user = await this.request("https://cli-chat-proxy.grok.com/v1/user?include=subscription", init);
					if ("status" in user && user.status === 200) {
						const body = parseBody(user.raw);
						const id = isBox(body) ? body.userId : undefined;
						if (typeof id === "string" && /^[\w-]{1,160}$/.test(id)) headers["x-userid"] = id;
					}
				}
				const response = await this.request(url, init);
				if ("error" in response) result.error = response.error;
				else if (response.status === 401 || response.status === 403) result.error = "unauthorized";
				else if (response.status !== 200) result.error = "network";
				else {
					const windows = parseQuotaWindows(account.provider, parseBody(response.raw));
					result = windows.length ? { status: "ready", windows, updatedAt: Date.now() } : { ...result, error: "unsupported" };
				}
				// A switched login must not receive the previous account's late response.
				const current = await this.credential(account);
				if (current?.token !== credential.token || current?.accountId !== credential.accountId) return;
			}
		} catch {
			result.error = resolvedCredential ? "network" : "credentials";
		}
		try {
			const current = (await this.config.load()).find((row) => row.id === account.id);
			result.updatedAt = Date.now();
			if (JSON.stringify(current) === JSON.stringify(account)) this.results.set(account.id, result);
		} catch {
			/* A corrupt config is surfaced by list; never publish stale account data. */
		}
	}
}
