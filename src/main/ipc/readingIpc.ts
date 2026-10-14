/**
 * 阅读 IPC 域（P03）：只做入参校验与适配，业务在 ReadingService。
 *
 * 通道（与 shared/ipc.ts 一一对应）：
 * reading:get-status | connect | disconnect | list-library | get-edition | get-chapter | resolve-quote |
 * list-notes | read-note | write-note | list-note-drafts | discard-note-draft | resume-note-draft |
 * get-position | save-position | history-sources | list-history | read-history-session |
 * list-bindings | resolve-binding | bind-session | unbind-session（后四条为 P04 会话绑定）
 *
 * 边界：
 * - handler 第一行职责是校验（readingValidation），非法入参返回结构化 invalidInput，不抛裸异常；
 * - 返回值不含凭据/服务端原文；服务地址由主进程连接存储给出，渲染层只能提交密码与回环地址；
 * - 不落业务：位置、笔记草稿、注册索引、unsupported 判定都在 Service。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ReadingPositionGetResult, ReadingStatusResult } from "../../shared/types/reading";
import type { ReadingService } from "../personal-workbench/reading/ReadingService";
import {
	parseEditionRef,
	parseReadingBindSessionInput,
	parseReadingBindingRef,
	parseReadingChapterRequest,
	parseReadingConnectInput,
	parseReadingHistoryQuery,
	parseReadingHistoryRef,
	parseReadingNoteDraftRef,
	parseReadingNoteRef,
	parseReadingNoteWriteInput,
	parseReadingPositionRef,
	parseReadingPositionSaveInput,
	parseReadingResolveQuoteInput,
} from "../personal-workbench/reading/readingValidation";

export function registerReadingIpc(deps: { ipc: IpcMain; service: ReadingService; log: (message: string, details?: Record<string, unknown>) => void }): void {
	const { ipc, service, log } = deps;

	ipc.handle(ipcChannels.readingGetStatus, async (): Promise<ReadingStatusResult> => service.getStatus());

	ipc.handle(ipcChannels.readingConnect, async (_event, raw): Promise<ReadingStatusResult> => {
		const parsed = parseReadingConnectInput(raw);
		if (!parsed.ok) return parsed;
		const result = await service.connect(parsed.input);
		log("reading connect", { ok: result.ok, code: result.ok ? undefined : result.error.code });
		return result;
	});

	ipc.handle(ipcChannels.readingDisconnect, async (): Promise<ReadingStatusResult> => service.disconnect());

	ipc.handle(ipcChannels.readingListLibrary, async () => service.listLibrary());

	ipc.handle(ipcChannels.readingGetEdition, async (_event, raw) => {
		const parsed = parseEditionRef(raw);
		if (!parsed.ok) return parsed;
		return service.getEdition(parsed.workId, parsed.editionId);
	});

	ipc.handle(ipcChannels.readingGetChapter, async (_event, raw) => {
		const parsed = parseReadingChapterRequest(raw);
		if (!parsed.ok) return parsed;
		return service.getChapter(parsed.workId, parsed.editionId, parsed.chapter);
	});

	ipc.handle(ipcChannels.readingResolveQuote, async (_event, raw) => {
		const parsed = parseReadingResolveQuoteInput(raw);
		if (!parsed.ok) return parsed;
		return service.resolveQuote(parsed.workId, parsed.editionId, parsed.text, parsed.chapterHref, parsed.expectedVersion);
	});

	ipc.handle(ipcChannels.readingListNotes, async (_event, raw) => {
		const parsed = parseEditionRef(raw);
		if (!parsed.ok) return parsed;
		return service.listNotes(parsed.workId, parsed.editionId);
	});

	ipc.handle(ipcChannels.readingReadNote, async (_event, raw) => {
		const parsed = parseReadingNoteRef(raw);
		if (!parsed.ok) return parsed;
		return service.readNote(parsed.workId, parsed.noteId);
	});

	ipc.handle(ipcChannels.readingWriteNote, async (_event, raw) => {
		const parsed = parseReadingNoteWriteInput(raw);
		if (!parsed.ok) return parsed;
		const result = await service.writeNote(parsed.input);
		log("reading write note", { ok: result.ok, code: result.ok ? undefined : result.error.code, op: parsed.input.operation.op });
		return result;
	});

	ipc.handle(ipcChannels.readingListNoteDrafts, async () => service.listNoteDrafts());

	ipc.handle(ipcChannels.readingDiscardNoteDraft, async (_event, raw) => {
		const parsed = parseReadingNoteDraftRef(raw);
		if (!parsed.ok) return parsed;
		const result = await service.discardNoteDraft(parsed.ref);
		log("reading discard note draft", { ok: result.ok });
		return result;
	});

	ipc.handle(ipcChannels.readingResumeNoteDraft, async (_event, raw) => {
		const parsed = parseReadingNoteDraftRef(raw);
		if (!parsed.ok) return parsed;
		const result = await service.resumeNoteDraft(parsed.ref);
		log("reading resume note draft", { ok: result.ok, code: result.ok ? undefined : result.error.code });
		return result;
	});

	ipc.handle(ipcChannels.readingGetPosition, async (_event, raw): Promise<ReadingPositionGetResult> => {
		const parsed = parseReadingPositionRef(raw);
		if (!parsed.ok) return parsed;
		return service.getPosition(parsed.workId, parsed.editionId, parsed.contentVersion);
	});

	ipc.handle(ipcChannels.readingSavePosition, async (_event, raw) => {
		const parsed = parseReadingPositionSaveInput(raw);
		if (!parsed.ok) return parsed;
		return service.savePosition(parsed.input);
	});

	ipc.handle(ipcChannels.readingHistorySources, async () => service.historySources());

	ipc.handle(ipcChannels.readingListHistory, async (_event, raw) => {
		const parsed = parseReadingHistoryQuery(raw);
		if (!parsed.ok) return parsed;
		return service.listHistory(parsed.source, parsed.cursor, parsed.limit);
	});

	ipc.handle(ipcChannels.readingReadHistorySession, async (_event, raw) => {
		const parsed = parseReadingHistoryRef(raw);
		if (!parsed.ok) return parsed;
		return service.readHistorySession(parsed.source, parsed.id);
	});

	// P04 会话绑定：本地关系读写（不碰 Pi session 文件/不新增 agent 渠道）
	ipc.handle(ipcChannels.readingListBindings, async () => service.listBindings());

	ipc.handle(ipcChannels.readingResolveBinding, async (_event, raw) => {
		const parsed = parseReadingBindingRef(raw);
		if (!parsed.ok) return parsed;
		return service.resolveBinding(parsed.ref);
	});

	ipc.handle(ipcChannels.readingBindSession, async (_event, raw) => {
		const parsed = parseReadingBindSessionInput(raw);
		if (!parsed.ok) return parsed;
		const result = await service.bindSession(parsed.input);
		log("reading bind session", { ok: result.ok, code: result.ok ? undefined : result.error.code });
		return result;
	});

	ipc.handle(ipcChannels.readingUnbindSession, async (_event, raw) => {
		const parsed = parseReadingBindingRef(raw);
		if (!parsed.ok) return parsed;
		return service.unbindSession(parsed.ref);
	});
}

/** 供 main/index.ts 装配与契约测试读取的通道清单（防漏注册）。 */
export const READING_IPC_CHANNELS: readonly string[] = [
	ipcChannels.readingGetStatus,
	ipcChannels.readingConnect,
	ipcChannels.readingDisconnect,
	ipcChannels.readingListLibrary,
	ipcChannels.readingGetEdition,
	ipcChannels.readingGetChapter,
	ipcChannels.readingResolveQuote,
	ipcChannels.readingListNotes,
	ipcChannels.readingReadNote,
	ipcChannels.readingWriteNote,
	ipcChannels.readingListNoteDrafts,
	ipcChannels.readingDiscardNoteDraft,
	ipcChannels.readingResumeNoteDraft,
	ipcChannels.readingGetPosition,
	ipcChannels.readingSavePosition,
	ipcChannels.readingHistorySources,
	ipcChannels.readingListHistory,
	ipcChannels.readingReadHistorySession,
	ipcChannels.readingListBindings,
	ipcChannels.readingResolveBinding,
	ipcChannels.readingBindSession,
	ipcChannels.readingUnbindSession,
];
