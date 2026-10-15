/** Local quota settings: bounded atomic writes, encrypted manual credentials, no auth-file writes. */
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { QuotaAccount, QuotaAccountInput, QuotaProvider } from "../../shared/types/accountUsage";
import { QUOTA_PROVIDERS } from "../../shared/types/accountUsage";

export type StoredQuotaAccount = Omit<QuotaAccount, "hasCredential"> & { secret?: string; accountId?: string };
export type QuotaCipher = { encrypt(value: string): string; decrypt(value: string): string };
export const isBox = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Runtime validator shared by the IPC boundary and on-disk reader. */
export function isQuotaProvider(value: unknown): value is QuotaProvider {
	return QUOTA_PROVIDERS.some((provider) => provider === value);
}
export function validQuotaInput(value: unknown): value is QuotaAccountInput {
	if (!isBox(value)) return false;
	return (
		isQuotaProvider(value.provider) &&
		typeof value.name === "string" &&
		value.name.trim().length > 0 &&
		value.name.length <= 80 &&
		!/[\p{Cc}]/u.test(value.name) &&
		typeof value.visible === "boolean" &&
		(value.source === "local" || value.source === "manual") &&
		(value.region === "cn" || value.region === "global") &&
		[value.id, value.accountId].every((item) => item === undefined || (typeof item === "string" && /^[\w-]{1,160}$/.test(item))) &&
		(value.credential === undefined || (typeof value.credential === "string" && value.credential.length <= 16384 && !/[\r\n\0]/.test(value.credential)))
	);
}
/** Read a small JSON config without ever allocating an unbounded credential file. */
export async function readSmallJson(path: string): Promise<unknown> {
	let file;
	try {
		file = await open(path, "r");
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 1024 * 1024) throw new Error("quota config too large");
		return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
	} catch (error) {
		if (isBox(error) && error.code === "ENOENT") return undefined;
		throw error;
	} finally {
		await file?.close();
	}
}
export class QuotaAccountConfig {
	constructor(
		private readonly path: string,
		readonly cipher: QuotaCipher,
	) {}
	async load(): Promise<StoredQuotaAccount[]> {
		const data = await readSmallJson(this.path);
		if (data === undefined) return QUOTA_PROVIDERS.map((provider) => ({ id: provider, provider, name: { codex: "Codex", "opencode-go": "OpenCode Go", grok: "Grok", glm: "GLM (ZCode)" }[provider], source: "local", visible: true, region: "cn" }));
		if (!isBox(data) || data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 32) throw new Error("Invalid quota config");
		const accounts: StoredQuotaAccount[] = [];
		const ids = new Set<string>();
		for (const item of data.accounts) {
			if (!validQuotaInput(item) || typeof item.id !== "string" || ids.has(item.id) || ("secret" in item && (typeof item.secret !== "string" || item.secret.length > 50000))) throw new Error("Invalid quota account");
			ids.add(item.id);
			accounts.push({ id: item.id, provider: item.provider, name: item.name, visible: item.visible, source: item.source, region: item.region, ...(typeof item.accountId === "string" ? { accountId: item.accountId } : {}), ...("secret" in item && typeof item.secret === "string" ? { secret: item.secret } : {}) });
		}
		return accounts;
	}
	async write(accounts: StoredQuotaAccount[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify({ version: 1, accounts }, null, 2));
			} finally {
				await file.close();
			}
			await rename(temp, this.path);
		} finally {
			await rm(temp, { force: true });
		}
	}
}
