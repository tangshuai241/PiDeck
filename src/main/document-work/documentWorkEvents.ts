/**
 * 文稿变化事件：一个 3 行函数放在单独文件里，是为了让「谁发事件」只有一个实现，
 * 服务与尝试协程共用同一份，避免两处 changeKind 拼写漂移。
 */
import type { DocumentWorkChangedEvent, DocumentWorkRecord } from "../../shared/types/documentWork";

export type DocumentWorkChangeEmitter = (event: DocumentWorkChangedEvent) => void;

export function emitWorkChanged(onChanged: DocumentWorkChangeEmitter, record: DocumentWorkRecord, changeKind: DocumentWorkChangedEvent["changeKind"], attemptId?: string): void {
	onChanged({ workId: record.workId, sessionId: record.sessionId, revision: record.revision, changeKind, ...(attemptId ? { attemptId } : {}) });
}
