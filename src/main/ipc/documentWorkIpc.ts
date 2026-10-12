/**
 * 文稿域 IPC：只做入参校验、边界适配和错误收口。
 *
 * 约定（与仓库其它域一致）：
 * - handler 第一件事是校验入参；渲染层数据一律不可信；
 * - 业务规则在 `DocumentWorkService` / `DocumentWorkStore`，这里不复制一份；
 * - 不抛裸异常跨 IPC：所有失败都变成 `WorkResult` 的 `{ ok: false, error }`；
 * - 输出根只能来自**用户经系统目录选择器显式选择**的路径，或已登记根；
 *   模型和渲染层都不能直接写一个绝对路径进来。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { workFail, type WorkResult } from "../../shared/documentWork";
import type { DocumentWorkChangedEvent } from "../../shared/types/documentWork";
import type { DocumentWorkStore } from "../document-work/DocumentWorkStore";
import type { DocumentWorkService } from "../document-work/DocumentWorkService";

export type DocumentWorkIpcDeps = {
	service: DocumentWorkService;
	store: DocumentWorkStore;
	/** 弹出系统目录选择器；取消返回 undefined。 */
	chooseDirectory: (title: string) => Promise<string | undefined>;
	/** 广播变更（主进程 → 渲染层）。 */
	broadcast: (event: DocumentWorkChangedEvent) => void;
};

export function registerDocumentWorkIpc(deps: DocumentWorkIpcDeps): void {
	ipcMain.handle(ipcChannels.documentWorkCreate, async (_event, input: unknown) => deps.service.create(input));
	ipcMain.handle(ipcChannels.documentWorkGet, async (_event, input: unknown) => deps.service.get(input));
	ipcMain.handle(ipcChannels.documentWorkList, async (_event, sessionId: unknown) => deps.service.listForSession(sessionId));
	ipcMain.handle(ipcChannels.documentWorkPrepare, async (_event, input: unknown) => deps.service.prepare(input));
	ipcMain.handle(ipcChannels.documentWorkStart, async (_event, input: unknown) => deps.service.start(input));
	ipcMain.handle(ipcChannels.documentWorkOperation, async (_event, input: unknown) => deps.service.getOperation(input));
	ipcMain.handle(ipcChannels.documentWorkCancel, async (_event, input: unknown) => deps.service.cancel(input));
	ipcMain.handle(ipcChannels.documentWorkRecover, async (_event, sessionId: unknown) => deps.service.recover(sessionId));
	ipcMain.handle(ipcChannels.documentWorkListRoots, async () => deps.store.listOutputRoots());
	ipcMain.handle(ipcChannels.documentWorkForgetRoot, async (_event, outputRootId: unknown) => (typeof outputRootId === "string" && outputRootId ? deps.store.unregisterOutputRoot(outputRootId) : workFail("INVALID_INPUT", false, { detail: "outputRootId is required" })));

	/** 登记用户选中的成果目录：先弹系统选择器，再把选中的路径交给 store 校验并登记。 */
	ipcMain.handle(ipcChannels.documentWorkChooseRoot, async () => {
		const chosen = await deps.chooseDirectory("选择成果保存目录");
		if (!chosen) return { ok: true, value: { cancelled: true } } as const;
		const registered = deps.store.registerOutputRoot({ path: chosen, label: chosen.split(/[/\\]/).filter(Boolean).pop() ?? "documents" });
		if ("error" in registered) return registered;
		return { ok: true, value: { outputRootId: registered.value.outputRootId, path: registered.value.path, label: registered.value.label } } as const;
	});

	/** 绑定输出根到已有工作记录（首次提交时还没有目录，用户选完再绑）。 */
	ipcMain.handle(ipcChannels.documentWorkSetRoot, async (_event, input: unknown) => bindRoot(deps.store, input));
}

function bindRoot(store: DocumentWorkStore, input: unknown): WorkResult<{ workId: string; revision: number }> {
	if (typeof input !== "object" || input === null) return workFail("INVALID_INPUT", false, { detail: "set-root input must be an object" });
	const value = input as Record<string, unknown>;
	if (typeof value.workId !== "string" || !value.workId || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return workFail("INVALID_INPUT", false, { detail: "workId and expectedRevision are required" });
	if (typeof value.outputRootId !== "string" || !value.outputRootId) return workFail("INVALID_INPUT", false, { detail: "outputRootId is required" });
	const root = store.getOutputRoot(value.outputRootId);
	if ("error" in root) return root;
	return store.withWork(value.workId, value.expectedRevision as number, (bucket) => {
		const record = { ...bucket.record, outputRootId: root.value.outputRootId };
		return { ok: true, value: { bucket: { ...bucket, record }, value: { workId: record.workId, revision: bucket.revision + 1 } } };
	});
}
