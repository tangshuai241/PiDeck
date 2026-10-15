/** OS-protected storage is mandatory for manually supplied quota credentials. */
import { safeStorage } from "electron";
import { join } from "node:path";
import { AccountUsageService } from "../accountUsage/AccountUsageService";
import { QuotaAccountConfig } from "./quotaAccountConfig";

export function createAccountUsageService(userData: string): AccountUsageService {
	return new AccountUsageService(
		new QuotaAccountConfig(join(userData, "quota-accounts.json"), {
			encrypt(value) {
				if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("Secure storage unavailable");
				return safeStorage.encryptString(value).toString("base64");
			},
			decrypt(value) {
				if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage unavailable");
				return safeStorage.decryptString(Buffer.from(value, "base64"));
			},
		}),
	);
}
