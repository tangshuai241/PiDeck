import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteCompanionResult } from "../../shared/types/remoteCompanion";
import type { RemoteCompanionService } from "../remote/RemoteCompanionService";

/** Exposes three explicit device actions, without a generic IPC/network proxy. */
export function registerRemoteCompanionIpc(ipc: IpcMain, service: RemoteCompanionService): void {
	const register = (channel: string, action: () => Promise<RemoteCompanionResult>) =>
		ipc.handle(channel, async (_event, input: unknown): Promise<RemoteCompanionResult> => {
			if (input !== undefined) return { ok: false, error: "INVALID_INPUT" };
			try {
				return await action();
			} catch {
				return { ok: false, error: "REMOTE_UNAVAILABLE" };
			}
		});
	register(ipcChannels.remoteCompanionStatus, async () => ({ ok: true, status: service.status() }));
	register(ipcChannels.remoteCompanionPair, () => service.createInvitation());
	register(ipcChannels.remoteCompanionRevoke, () => service.revoke());
}
