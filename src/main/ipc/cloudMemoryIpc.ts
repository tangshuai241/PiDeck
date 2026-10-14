/**
 * 云端记忆 IPC 域：只做入参校验与适配，业务在 CloudMemoryService。
 *
 * 通道（与 shared/ipc.ts 一一对应）：
 * - cloudMemory:get-status / connect / logout / set-enabled / set-sync-enabled / refresh-persona
 *
 * 边界：
 * - 返回值永不包含凭据、令牌或密码；渲染层拿到的只是状态与路径；
 * - 入参在边界收窄（字符串/布尔的形态与长度），越界直接返回结构化错误而不是抛裸异常；
 * - 不提供写入云端人格的通道：发布走现有云端用户确认入口，本节点只读已发布版本。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CloudMemoryStatus, CloudMemoryStatusResult } from "../../shared/types/cloudMemory";
import type { CloudMemoryService } from "../cloudMemory/CloudMemoryService";

export function registerCloudMemoryIpc(deps: { ipc: IpcMain; service: CloudMemoryService; log: (message: string, details?: Record<string, unknown>) => void }): void {
	const { ipc, service, log } = deps;

	ipc.handle(ipcChannels.cloudMemoryGetStatus, async (): Promise<CloudMemoryStatusResult> => ({ ok: true, status: await service.getStatus() }));

	ipc.handle(ipcChannels.cloudMemoryConnect, async (_event, input: unknown) => {
		const result = await service.connect(input);
		log("cloud memory connect", { ok: result.ok, code: result.ok ? undefined : result.error.code });
		return result;
	});

	ipc.handle(ipcChannels.cloudMemoryLogout, async (): Promise<CloudMemoryStatusResult> => ({ ok: true, status: await service.logout() }));

	ipc.handle(ipcChannels.cloudMemorySetEnabled, async (_event, enabled: unknown): Promise<CloudMemoryStatusResult> => {
		if (typeof enabled !== "boolean") return { ok: false, error: { code: "invalidInput", message: "开关取值不合法" } };
		return { ok: true, status: await service.setEnabled(enabled) };
	});

	ipc.handle(ipcChannels.cloudMemorySetSyncEnabled, async (_event, syncEnabled: unknown): Promise<CloudMemoryStatusResult> => {
		if (typeof syncEnabled !== "boolean") return { ok: false, error: { code: "invalidInput", message: "同步范围取值不合法" } };
		return { ok: true, status: await service.setSyncEnabled(syncEnabled) };
	});

	ipc.handle(ipcChannels.cloudMemoryRefreshPersona, async (): Promise<CloudMemoryStatusResult> => {
		await service.refreshPersona({ force: true });
		return { ok: true, status: await service.getStatus() };
	});
}

/** 供 main/index.ts 装配时读取的通道清单（契约测试用它防漏注册）。 */
export const CLOUD_MEMORY_IPC_CHANNELS: readonly string[] = [ipcChannels.cloudMemoryGetStatus, ipcChannels.cloudMemoryConnect, ipcChannels.cloudMemoryLogout, ipcChannels.cloudMemorySetEnabled, ipcChannels.cloudMemorySetSyncEnabled, ipcChannels.cloudMemoryRefreshPersona];

/** 渲染层可见的状态类型别名（preload 与 hook 共用同一份契约）。 */
export type CloudMemoryStatusPayload = CloudMemoryStatus;
