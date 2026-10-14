/**
 * 阅读域本地路径与数据布局（P03）。
 *
 * 所有 TPA 侧阅读数据都在 `<userData>/personal-workbench/reading/` 下：
 * - connection.json：服务地址与「是否记住密码」（受保护密码由 safeStorage 加密后存这里）；
 * - positions/<editionId>.json：每版阅读位置（版本、fraction、章节摘要、时间）；
 * - notes-index/<workId>.json：noteId 与 revision 的本地投影（主账仍在 DeepRead）；
 * - positions/*.bak 与 *.corrupt-*：原件保护（写前备份、损坏隔离）。
 *
 * 边界：路径只在这里推导；id 先经 readingValidation 校验（不含路径分隔符/控制字符），
 * 构建文件名时再做一次白名单过滤，绝不直接把 IPC 输入拼进路径。
 */

import { join } from "node:path";

export const READING_DIR_NAME = "reading";
export const READING_CONNECTION_FILE = "connection.json";
export const READING_POSITIONS_DIR = "positions";
export const READING_NOTES_INDEX_DIR = "notes-index";
export const READING_SESSIONS_DIR = "sessions";
/** 未确认笔记草稿（服务端确认前持久保留，重开可复原）。 */
export const READING_NOTE_DRAFTS_FILE = "note-drafts.json";

export type ReadingPaths = {
	/** <userData>/personal-workbench/reading */
	dataDir: string;
	connectionFile: string;
	positionsDir: string;
	notesIndexDir: string;
	/** 未确认笔记草稿文件。 */
	noteDraftsFile: string;
	/** P04 预留：每书会话绑定；本节点只建目录不写。 */
	sessionsDir: string;
};

export function resolveReadingPaths(userDataDir: string): ReadingPaths {
	const dataDir = join(userDataDir, "personal-workbench", READING_DIR_NAME);
	return {
		dataDir,
		connectionFile: join(dataDir, READING_CONNECTION_FILE),
		positionsDir: join(dataDir, READING_POSITIONS_DIR),
		notesIndexDir: join(dataDir, READING_NOTES_INDEX_DIR),
		noteDraftsFile: join(dataDir, READING_NOTE_DRAFTS_FILE),
		sessionsDir: join(dataDir, READING_SESSIONS_DIR),
	};
}

/** 文件名安全化：只允许 [A-Za-z0-9_.-]（id 已在边界校验，这里是第二道防线）。 */
export function readingFileNameFromId(id: string): string {
	return id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160);
}

export function readingPositionFile(paths: ReadingPaths, editionId: string): string {
	return join(paths.positionsDir, `${readingFileNameFromId(editionId)}.json`);
}

export function readingNoteIndexFile(paths: ReadingPaths, workId: string): string {
	return join(paths.notesIndexDir, `${readingFileNameFromId(workId)}.json`);
}
