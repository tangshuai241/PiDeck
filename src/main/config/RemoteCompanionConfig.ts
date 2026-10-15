import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../../packages/tpa-remote/src/crypto";
import { parseRemoteHostSettings, type RemoteHostConfig } from "./remoteHostSettings";
export type { RemoteHostConfig } from "./remoteHostSettings";

/** Secrets stay under the config boundary and are encrypted by the operating system. */
export class RemoteCompanionConfig {
	private readonly path: string;
	private writeTail: Promise<void> = Promise.resolve();
	constructor(path: string) {
		this.path = path;
	}
	async read(): Promise<RemoteHostConfig | undefined> {
		try {
			if (!safeStorage.isEncryptionAvailable() || (await stat(this.path)).size > 32_000) throw new Error("CONFIG_UNAVAILABLE");
			return parseRemoteHostSettings(JSON.parse(safeStorage.decryptString(await readFile(this.path))));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return this.importProvisioning();
			throw error;
		}
	}
	/** Import only the fixed local inbox, only on first setup, and keep remote access off until pairing. */
	private async importProvisioning(): Promise<RemoteHostConfig | undefined> {
		const inbox = `${this.path}.provision.json`;
		try {
			if ((await stat(inbox)).size > 32_000) throw new Error("INVALID_CONFIG");
			const value = parseRemoteHostSettings(JSON.parse(await readFile(inbox, "utf8")));
			if (value.enabled || value.phone || value.invite) throw new Error("INVALID_PROVISIONING");
			await this.write(value);
			await unlink(inbox);
			return value;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
	write(value: RemoteHostConfig): Promise<void> {
		const work = this.writeTail.then(() => this.writeFile(value));
		this.writeTail = work.catch(() => undefined);
		return work;
	}
	private async writeFile(value: RemoteHostConfig): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) throw new Error("CONFIG_UNAVAILABLE");
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
		await rename(temp, this.path);
	}
}
