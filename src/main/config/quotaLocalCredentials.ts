/** Read only the selected software's native credentials; never refresh or rewrite its login. */
import { join } from "node:path";
import { homedir } from "node:os";
import { isBox, readSmallJson, type StoredQuotaAccount } from "./quotaAccountConfig";

export type QuotaCredential = { token: string; accountId?: string };
function token(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.length <= 16384 && !/[\r\n\0]/.test(value) ? value.trim() : undefined;
}
/** Native source selection is fixed in code, so renderer input cannot read arbitrary paths. */
export async function readQuotaLocalCredential(account: StoredQuotaAccount, home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<QuotaCredential | undefined> {
	if (account.provider === "codex") {
		const data = await readSmallJson(join(env.CODEX_HOME || join(home, ".codex"), "auth.json"));
		const tokens = isBox(data) && isBox(data.tokens) ? data.tokens : undefined;
		const access = token(tokens?.access_token);
		if (access) return { token: access, ...(typeof tokens?.account_id === "string" && /^[\w-]{1,160}$/.test(tokens.account_id) ? { accountId: tokens.account_id } : {}) };
	}
	if (account.provider === "opencode-go") {
		const data = await readSmallJson(join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"));
		const entry = isBox(data) ? data["opencode-go"] : undefined;
		const access = isBox(entry) && entry.type === "api" ? token(entry.key) : undefined;
		if (access) return { token: access };
	}
	if (account.provider === "grok") {
		const data = await readSmallJson(join(env.GROK_HOME || join(home, ".grok"), "auth.json"));
		if (isBox(data)) {
			const entry = data["https://auth.x.ai"] ?? Object.entries(data).find(([key]) => key.startsWith("https://auth.x.ai::"))?.[1];
			const access = isBox(entry) ? token(entry.key) : undefined;
			if (access) return { token: access };
		}
	}
	if (account.provider === "glm") {
		const data = await readSmallJson(join(home, ".zcode", "cli", "config.json"));
		if (isBox(data) && isBox(data.provider)) {
			const model = typeof data.model === "string" ? data.model : isBox(data.model) ? data.model.main : undefined;
			const provider = typeof model === "string" ? data.provider[model.split("/")[0]] : undefined;
			const options = isBox(provider) && isBox(provider.options) ? provider.options : undefined;
			const access = token(options?.apiKey);
			const origin = account.region === "global" ? "https://api.z.ai" : "https://open.bigmodel.cn";
			if (access && typeof options?.baseURL === "string" && new URL(options.baseURL).origin === origin) return { token: access };
		}
	}
	// pi's own credentials are an explicit fallback, only for the same provider.
	const pi = await readSmallJson(join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "auth.json"));
	const keys = { codex: ["openai-codex"], "opencode-go": ["opencode-go"], grok: ["xai", "grok"], glm: account.region === "global" ? ["zai", "z-ai"] : ["zhipu", "zhipuai"] }[account.provider];
	for (const key of keys) {
		const entry = isBox(pi) ? pi[key] : undefined;
		const access = isBox(entry) ? token(entry.access ?? entry.key) : undefined;
		if (access) return { token: access };
	}
	return undefined;
}
