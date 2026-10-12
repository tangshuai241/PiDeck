/**
 * 文稿域 IPC：只做入参边界校验与适配，业务在 `main/document-work/`。
 *
 * 渲染层数据一律不可信：ID 形态、枚举、列表上限与「同 requestId 必须同载荷」
 * 都在这里先过一遍。输出根与材料路径只能来自用户经系统选择器授权的结果，
 * 渲染层自己拼的绝对路径在这里直接判 PATH_DENIED。
 */
import { ipcMain, dialog, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isDigest, isRequestId, isWorkId, parseAuthorizationReference, parseDocumentWorkScope, parseRequirementsReference, parseSessionRuntimeTriple, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import { parseDocumentWorkView } from "../../shared/documentWorkRecords";
import type { DocumentOutputRoot, DocumentWorkView } from "../../shared/types/documentWork";
import type { DocumentWorkService } from "../document-work/DocumentWorkService";

export type DocumentWorkIpcDeps = {
	service: DocumentWorkService;
	/** 当前主窗口；对话框挂在它上面，避免选择器被主窗口遮住。 */
	getWindow: () => BrowserWindow | null;
	/** 输出根授权：用户选定后登记为允许目录，渲染层只拿得到 ID。 */
	registerOutputRoot: (realPath: string) => Promise<DocumentOutputRoot | undefined>;
	/** 会话用户消息里已经出现过的材料路径：由主进程独立复核，不信任渲染层传入的授权。 */
	registerChatMaterials: (sessionId: string, paths: readonly string[]) => Promise<string[]>;
};

const MATERIAL_PICK_FILTERS = [
	{ name: "文稿与文本材料", extensions: ["doc", "docx", "pdf", "ppt", "pptx", "xls", "xlsx", "odt", "odf", "rtf", "epub", "csv", "md", "txt"] },
	{ name: "全部文件", extensions: ["*"] },
];

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseMutation(value: unknown): { requestId: string; workId: string; expectedRevision: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const requestId = Reflect.get(value, "requestId");
	const workId = Reflect.get(value, "workId");
	const expectedRevision = Reflect.get(value, "expectedRevision");
	if (!isRequestId(requestId) || !isWorkId(workId)) return undefined;
	if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return undefined;
	return { requestId, workId, expectedRevision };
}

export function registerDocumentWorkIpc({ service, getWindow, registerOutputRoot, registerChatMaterials }: DocumentWorkIpcDeps): void {
	ipcMain.handle(ipcChannels.documentWorkChooseOutputRoot, async (): Promise<WorkResult<DocumentOutputRoot>> => {
		const window = getWindow();
		const options: Electron.OpenDialogOptions = { title: "选择文稿保存目录", properties: ["openDirectory", "createDirectory"] };
		const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const first = picked.filePaths[0];
		if (!first) return workFailure<DocumentOutputRoot>("INVALID_INPUT", "cancelled");
		const root = await registerOutputRoot(first);
		return root ? { ok: true, value: root } : workFailure<DocumentOutputRoot>("PATH_DENIED");
	});

	ipcMain.handle(ipcChannels.documentWorkChooseMaterials, async (_event, sessionId: unknown): Promise<WorkResult<{ paths: string[]; count: number }>> => {
		if (!isBoundedString(sessionId, 96)) return workFailure("INVALID_INPUT", "session_required");
		const window = getWindow();
		const options: Electron.OpenDialogOptions = { title: "选择本轮材料", properties: ["openFile", "multiSelections"], filters: MATERIAL_PICK_FILTERS };
		const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const paths = picked.filePaths.filter((path) => path.length <= 1024).slice(0, 24);
		if (paths.length === 0) return workSuccess({ paths: [], count: 0 });
		service.allowMaterials(sessionId, paths);
		return workSuccess({ paths, count: paths.length });
	});

	ipcMain.handle(ipcChannels.documentWorkRegisterMaterials, async (_event, raw: unknown): Promise<WorkResult<{ paths: string[]; count: number }>> => {
		if (typeof raw !== "object" || raw === null) return workFailure("INVALID_INPUT", "payload_required");
		const sessionId = Reflect.get(raw, "sessionId");
		const paths = Reflect.get(raw, "paths");
		if (!isBoundedString(sessionId, 96)) return workFailure("INVALID_INPUT", "session_required");
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 24) return workFailure("INVALID_INPUT", "materials");
		if (!paths.every((path) => isBoundedString(path, 1024))) return workFailure("INVALID_INPUT", "materials");
		// 只在「这段路径确实出现在本会话的用户消息里」时登记：用户已经在聊天里引用/拖入的文件
		// 不需要再选一次，但模型或渲染层凭空写出的路径不能借这条通道获得授权。
		const accepted = await registerChatMaterials(sessionId, paths as string[]);
		return accepted.length ? workSuccess({ paths: accepted, count: accepted.length }) : workFailure("PATH_DENIED", "material_not_referenced");
	});

	ipcMain.handle(ipcChannels.documentWorkAutoRevise, async (_event, raw: unknown): Promise<WorkResult<{ engaged: boolean }>> => {
		if (typeof raw !== "object" || raw === null) return workFailure("INVALID_INPUT", "payload_required");
		const sessionId = Reflect.get(raw, "sessionId");
		const requestId = Reflect.get(raw, "requestId");
		if (!isBoundedString(sessionId, 96) || !isRequestId(requestId)) return workFailure("INVALID_INPUT", "auto_revise_fields");
		// 判定完全在主进程：渲染层只报告「有新用户消息了」，不提供任何授权布尔值。
		return service.autoRevise(sessionId, requestId);
	});

	ipcMain.handle(ipcChannels.documentWorkCreate, async (_event, raw: unknown): Promise<WorkResult<DocumentWorkView>> => {
		if (typeof raw !== "object" || raw === null) return workFailure("INVALID_INPUT", "payload_required");
		const requestId = Reflect.get(raw, "requestId");
		const sessionId = Reflect.get(raw, "sessionId");
		const sourceTurnId = Reflect.get(raw, "sourceTurnId");
		const outputRootId = Reflect.get(raw, "outputRootId");
		const title = Reflect.get(raw, "title");
		if (!isRequestId(requestId) || !isBoundedString(sessionId, 96) || !isBoundedString(sourceTurnId, 200) || !isBoundedString(outputRootId, 96)) return workFailure("INVALID_INPUT", "create_fields");
		if (title !== undefined && title !== null && !(typeof title === "string" && title.length <= 120)) return workFailure("INVALID_INPUT", "title_too_long");
		return service.createWork({ requestId, sessionId, sourceTurnId, outputRootId, ...(typeof title === "string" ? { title } : {}) });
	});

	ipcMain.handle(ipcChannels.documentWorkGet, async (_event, raw: unknown): Promise<WorkResult<DocumentWorkView>> => {
		if (typeof raw !== "object" || raw === null) return workFailure("INVALID_INPUT", "payload_required");
		const workId = Reflect.get(raw, "workId");
		const sessionId = Reflect.get(raw, "sessionId");
		if (!isWorkId(workId) || !isBoundedString(sessionId, 96)) return workFailure("INVALID_INPUT", "get_fields");
		return service.getView(workId, sessionId);
	});

	ipcMain.handle(ipcChannels.documentWorkList, async (_event, sessionId: unknown): Promise<DocumentWorkView[]> => {
		if (!isBoundedString(sessionId, 96)) return [];
		return service.listForSession(sessionId);
	});

	ipcMain.handle(ipcChannels.documentWorkPrepare, async (_event, raw: unknown): Promise<WorkResult<unknown>> => {
		const mutation = parseMutation(raw);
		if (!mutation) return workFailure("INVALID_INPUT", "mutation_fields");
		const body = raw as Record<string, unknown>;
		const kind = body.kind;
		if (kind !== "create_document" && kind !== "revise_document") return workFailure("INVALID_INPUT", "kind");
		const requirementsRef = parseRequirementsReference(body.requirementsRef);
		if (!requirementsRef) return workFailure("INVALID_INPUT", "requirements_ref");
		const scope = parseDocumentWorkScope(body.scope);
		if (!scope) return workFailure("INVALID_INPUT", "scope");
		const materialPaths = Array.isArray(body.materialPaths) ? body.materialPaths : [];
		if (!materialPaths.every((path) => isBoundedString(path, 1024)) || materialPaths.length > 24) return workFailure("INVALID_INPUT", "materials");
		const baseVersionId = body.baseVersionId;
		if (baseVersionId !== undefined && baseVersionId !== null && !isWorkId(baseVersionId)) return workFailure("INVALID_INPUT", "base_version");
		return service.prepare({ ...mutation, kind, requirementsRef, scope, materialPaths, ...(typeof baseVersionId === "string" ? { baseVersionId } : {}) });
	});

	ipcMain.handle(ipcChannels.documentWorkStart, async (_event, raw: unknown): Promise<WorkResult<unknown>> => {
		const mutation = parseMutation(raw);
		if (!mutation) return workFailure("INVALID_INPUT", "mutation_fields");
		const body = raw as Record<string, unknown>;
		const preparation = typeof body.preparation === "object" && body.preparation !== null ? (body.preparation as Record<string, unknown>) : undefined;
		const preparationId = preparation ? Reflect.get(preparation, "preparationId") : undefined;
		const digest = preparation ? Reflect.get(preparation, "digest") : undefined;
		if (!isWorkId(preparationId) || !isDigest(digest)) return workFailure("INVALID_INPUT", "preparation_ref");
		const expectedRuntime = parseSessionRuntimeTriple(body.expectedRuntime);
		if (!expectedRuntime) return workFailure("INVALID_INPUT", "runtime_triple");
		const authorization = parseAuthorizationReference(body.authorization);
		if (!authorization) return workFailure("INVALID_INPUT", "authorization");
		return service.start({ ...mutation, preparation: { preparationId, digest }, expectedRuntime, authorization });
	});

	ipcMain.handle(ipcChannels.documentWorkOperation, async (_event, raw: unknown): Promise<WorkResult<unknown>> => {
		if (typeof raw !== "object" || raw === null) return workFailure("INVALID_INPUT", "payload_required");
		const workId = Reflect.get(raw, "workId");
		const requestId = Reflect.get(raw, "requestId");
		const sessionId = Reflect.get(raw, "sessionId");
		if (!isWorkId(workId) || !isRequestId(requestId) || !isBoundedString(sessionId, 96)) return workFailure("INVALID_INPUT", "operation_fields");
		return service.getOperation(workId, requestId, sessionId);
	});

	ipcMain.handle(ipcChannels.documentWorkCancel, async (_event, raw: unknown): Promise<WorkResult<unknown>> => {
		const mutation = parseMutation(raw);
		if (!mutation) return workFailure("INVALID_INPUT", "mutation_fields");
		const body = raw as Record<string, unknown>;
		const attemptId = body.attemptId;
		const expectedRuntime = parseSessionRuntimeTriple(body.expectedRuntime);
		if (!isWorkId(attemptId) || !expectedRuntime) return workFailure("INVALID_INPUT", "cancel_fields");
		return service.cancel({ ...mutation, attemptId, expectedRuntime });
	});
}

/** 主进程推送用的快照过滤：只发解析得动的有界事件。 */
export function isDeliverableDocumentWorkView(value: unknown): value is DocumentWorkView {
	return parseDocumentWorkView(value) !== undefined;
}
