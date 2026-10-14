/**
 * 个人待办 IPC 域（P02）：只做入参校验与适配，业务在 PersonalTodoService。
 *
 * 通道（与 shared/ipc.ts 一一对应）：
 * - personal-todo:get-status / list / get / submit / retry / resolve-conflict
 * 推送（主进程 → 渲染层）：personal-todo:changed（事件自带 scope/summary，渲染层按账号过滤）。
 *
 * 边界：
 * - 第一行职责是校验：非法入参返回结构化 invalidInput，不抛裸异常；
 * - 返回值永不包含令牌/密码；账号一律由主进程从已连接云端身份推导，入参里没有账号字段；
 * - handler 不落业务：草稿/队列/云端的规则都在 Service。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { PersonalTodoGetResult, PersonalTodoListResult, PersonalTodoResolveConflictResult, PersonalTodoRetryResult, PersonalTodoStatusResult, PersonalTodoSubmitResult } from "../../shared/types/personalTodo";
import type { PersonalTodoService } from "../personal-workbench/PersonalTodoService";
import { parsePersonalTodoId, parsePersonalTodoQuery, parsePersonalTodoResolveConflictInput, parsePersonalTodoRetryInput, parsePersonalTodoSubmitInput } from "../personal-workbench/personalTodoValidation";

function invalidId(): PersonalTodoGetResult {
	return { ok: false, error: { code: "invalidInput", message: "事项 id 不合法", detail: { field: "id" } } };
}

export function registerPersonalTodoIpc(deps: { ipc: IpcMain; service: PersonalTodoService; log: (message: string, details?: Record<string, unknown>) => void }): void {
	const { ipc, service, log } = deps;

	ipc.handle(ipcChannels.personalTodoGetStatus, async (): Promise<PersonalTodoStatusResult> => service.getStatus());

	ipc.handle(ipcChannels.personalTodoList, async (_event, raw): Promise<PersonalTodoListResult> => {
		const parsed = parsePersonalTodoQuery(raw);
		if (!parsed.ok) return parsed;
		return service.list(parsed.query);
	});

	ipc.handle(ipcChannels.personalTodoGet, async (_event, raw): Promise<PersonalTodoGetResult> => {
		const id = parsePersonalTodoId(raw);
		if (!id) return invalidId();
		return service.get(id);
	});

	ipc.handle(ipcChannels.personalTodoSubmit, async (_event, raw): Promise<PersonalTodoSubmitResult> => {
		const parsed = parsePersonalTodoSubmitInput(raw);
		if (!parsed.ok) return parsed;
		const result = await service.submit(parsed.input);
		log("personal todo submit", { ok: result.ok, kind: parsed.input.operation.kind, code: result.ok ? undefined : result.error.code });
		return result;
	});

	ipc.handle(ipcChannels.personalTodoRetry, async (_event, raw): Promise<PersonalTodoRetryResult> => {
		const parsed = parsePersonalTodoRetryInput(raw);
		if (!parsed.ok) return parsed;
		return service.retry(parsed.input);
	});

	ipc.handle(ipcChannels.personalTodoResolveConflict, async (_event, raw): Promise<PersonalTodoResolveConflictResult> => {
		const parsed = parsePersonalTodoResolveConflictInput(raw);
		if (!parsed.ok) return parsed;
		return service.resolveConflict(parsed.input);
	});
}

/** 供 main/index.ts 装配与契约测试读取的通道清单（防漏注册）。 */
export const PERSONAL_TODO_IPC_CHANNELS: readonly string[] = [ipcChannels.personalTodoGetStatus, ipcChannels.personalTodoList, ipcChannels.personalTodoGet, ipcChannels.personalTodoSubmit, ipcChannels.personalTodoRetry, ipcChannels.personalTodoResolveConflict];
