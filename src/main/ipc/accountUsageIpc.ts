/** Quota IPC boundary: validate identities and return only public account fields. */
import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AccountUsageService } from "../accountUsage/AccountUsageService";
import { validQuotaInput } from "../config/quotaAccountConfig";

const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
export function registerAccountUsageIpc(ipc: IpcMain, service: AccountUsageService): void {
	ipc.handle(ipcChannels.accountUsageList, () => service.list());
	ipc.handle(ipcChannels.accountUsageSave, (_event, input: unknown) => (validQuotaInput(input) ? service.save(input) : { accounts: [], results: {}, error: "invalid" }));
	ipc.handle(ipcChannels.accountUsageRemove, (_event, id: unknown) => (validId(id) ? service.remove(id) : { accounts: [], results: {}, error: "invalid" }));
	ipc.handle(ipcChannels.accountUsageRefresh, (_event, id: unknown) => (id === undefined || validId(id) ? service.refresh(id) : { accounts: [], results: {}, error: "invalid" }));
}
