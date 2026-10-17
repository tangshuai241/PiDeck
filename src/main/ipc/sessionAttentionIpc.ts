/**
 * 会话状态摘要 IPC 域：查询列表、确认结果已读。
 * 推送通道由装配层经 service.subscribe 转发，渲染层只订 `sessions:attention-changed`。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionAttentionSummary } from "../../shared/types/sessionAttention";
import type { SessionAttentionService } from "../sessions/attention/SessionAttentionService";

export function registerSessionAttentionIpc(service: SessionAttentionService): void {
	ipcMain.handle(ipcChannels.sessionsAttentionList, async (): Promise<SessionAttentionSummary[]> => {
		await service.start();
		return service.list();
	});
	ipcMain.handle(ipcChannels.sessionsAttentionMarkRead, async (_event, input: unknown): Promise<SessionAttentionSummary | undefined> => {
		if (!input || typeof input !== "object") throw new Error("INVALID_ATTENTION_ACK");
		const { sessionId, completionId } = input as { sessionId?: unknown; completionId?: unknown };
		if (typeof sessionId !== "string" || !sessionId || typeof completionId !== "string" || !completionId) throw new Error("INVALID_ATTENTION_ACK");
		await service.start();
		return service.acknowledge(sessionId, completionId);
	});
}
