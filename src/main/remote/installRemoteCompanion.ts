import { dialog, ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { RemoteCompanionConfig } from "../config/RemoteCompanionConfig";
import { registerRemoteCompanionIpc } from "../ipc/remoteCompanionIpc";
import { RemoteCommandLedger } from "./RemoteCommandLedger";
import { RemoteCompanionService } from "./RemoteCompanionService";
import { createRemoteSessionGateway } from "./RemoteSessionGateway";

/** Keeps Electron assembly thin; absence of local provisioning leaves remote access disabled. */
export function installRemoteCompanion(deps: Parameters<typeof createRemoteSessionGateway>[0] & { userDataPath: string; getWindow: () => BrowserWindow | null; copy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string; log: (event: string) => void }): RemoteCompanionService {
	const service = new RemoteCompanionService({
		config: new RemoteCompanionConfig(join(deps.userDataPath, "remote-companion.bin")),
		ledger: new RemoteCommandLedger(join(deps.userDataPath, "remote-companion", "receipts.json")),
		gateway: createRemoteSessionGateway(deps),
		log: deps.log,
		confirmDevice: async (name) => {
			const window = deps.getWindow();
			if (!window || window.isDestroyed()) return false;
			const result = await dialog.showMessageBox(window, {
				type: "question",
				title: deps.copy("remoteCompanion.pairTitle"),
				message: deps.copy("remoteCompanion.pairMessage", { name }),
				detail: deps.copy("remoteCompanion.pairDetail"),
				buttons: [deps.copy("remoteCompanion.deny"), deps.copy("remoteCompanion.allow")],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
			return result.response === 1;
		},
	});
	registerRemoteCompanionIpc(ipcMain, service);
	void service.start().catch(() => deps.log("remote_unavailable"));
	return service;
}
