import { isActiveAgentBackend } from "../../shared/activeAgentBackends";
/**
 * Session IPC handlers: session list, catalog, runtime management, importers.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isRewindRestoreScope } from "../../shared/types/rewind";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { modelThinkingLevelOf } from "../../shared/modelThinkingLevels";
import type {
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SendSessionPromptInput,
	SessionUiResponseInput,
	SessionRuntimeTarget,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeEvent,
	SessionCommandError,
	SessionCommandResult,
	SendPromptInput,
	SendPromptResult,
	SessionRecord,
	SessionProcessEvent,
	FetchedModel,
	SessionBranchTree,
	SessionMessagePage,
	SessionModelPreference,
	RewindCheckpointPageParams,
	ResolveLaunchDefaultsInput,
	ResolvedLaunchDefaults,
} from "../../shared/types";
import type { BridgeEventInput, BridgeResyncInput } from "../../shared/types/bridge";
import { parseSessionProcessEventsFromFile } from "../sessions/sessionProcessEventsFile";
import { dshSessionFilePath, resolveDshLegacyHome } from "../sessions/dshLegacyPath";
import type { SessionForkCommands } from "../sessions/sessionForkCommands";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "../pi/derivedSubagents";
import { getCachedModelList } from "../pi/modelListCache";
import { resolveLaunchDefaultOptions, isModelInModelsConfig } from "../sessions/launchDefaults";
import { sanitizeRendererPromptInput } from "../sessions/internalPromptDelivery";
import { BackgroundScanCoordinator } from "../sessions/BackgroundScanCoordinator";
import { DIRECTORY_IMPORT_MAX_SUMMARIES } from "../sessions/directorySessionImport";
import type { DirectorySessionImporter } from "../sessions/DirectorySessionImporter";
import { registerSessionImageMutationIpc } from "./sessionImageMutationIpc";
import { registerSessionTitleIpc } from "./sessionTitleIpc";

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Control actions are bound to the exact runtime shown by the initiating composer. */
function isValidExpectedPromptRuntime(input: SendSessionPromptInput): boolean {
	const target = input.expectedRuntime;
	if (target === undefined) return true;
	if (!isRecord(target)) return false;
	const validIdentity = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
	return validIdentity(target.sessionId) && target.sessionId === input.sessionId && validIdentity(target.agentId) && Number.isSafeInteger(target.runtimeGeneration) && typeof target.runtimeGeneration === "number" && target.runtimeGeneration >= 0;
}

/** Normalize untrusted model input before it reaches the persisted catalog. */
function normalizeSessionModelPreference(input: unknown): SessionModelPreference | undefined {
	if (!isRecord(input) || typeof input.provider !== "string" || typeof input.modelId !== "string" || (input.modelName !== undefined && typeof input.modelName !== "string")) return undefined;
	const provider = input.provider.trim();
	const modelId = input.modelId.trim();
	if (!provider || !modelId || provider.length > 128 || modelId.length > 256 || (typeof input.modelName === "string" && input.modelName.length > 256)) return undefined;
	return createSessionModelPreference(provider, modelId, input.modelName);
}
/**
 * 已扫描过项目的集合（模块级）：决定 catalogList 走「首次同步扫描」还是
 * 「缓存先回显 + 后台扫描推送」。进程生命周期内单调增长，无需清理。
 */
const scannedProjects = new Set<string>();

/** 后台目录扫描协调器：同项目触发去重 + 冷却合并（3 秒轮询不会演变成并发重扫）。 */
const catalogScanCoordinator = new BackgroundScanCoordinator(5000);

/**
 * 供主进程装配层（启动预扫描）触发的后台扫描调度入口。
 * 标记项目为已扫描，保证预热后首次展开项目走缓存回显路径。
 */
export function scheduleCatalogBackgroundScan(projectId: string, task: () => Promise<void>): boolean {
	scannedProjects.add(projectId);
	return catalogScanCoordinator.schedule(projectId, task);
}
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import { appendSessionForkSuffix } from "../sessions/sessionForkTitle";
import type { AgentManager } from "../pi/AgentManager";
import type { ConfigManager } from "../config/ConfigManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import type { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import type { QoderSessionImporter } from "../sessions/QoderSessionImporter";
import type { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import type { ZCodeSessionImporter } from "../sessions/ZCodeSessionImporter";
import type { WorkBuddySessionImporter } from "../sessions/WorkBuddySessionImporter";
import type { CursorSessionImporter } from "../sessions/CursorSessionImporter";
import type { KimiSessionImporter } from "../sessions/KimiSessionImporter";
import type { KimiWorkSessionImporter } from "../sessions/KimiWorkSessionImporter";
import type { MinimaxSessionImporter } from "../sessions/MinimaxSessionImporter";
import type { AppLogger } from "../logging/AppLogger";

export type SessionIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	sessionScanner: SessionScanner;
	sessionCatalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	agentManager: AgentManager;
	configManager: ConfigManager;
	codexSessionImporter: CodexSessionImporter;
	claudeSessionImporter: ClaudeSessionImporter;
	qoderSessionImporter: QoderSessionImporter;
	openCodeSessionImporter: OpenCodeSessionImporter;
	zcodeSessionImporter: ZCodeSessionImporter;
	workbuddySessionImporter: WorkBuddySessionImporter;
	cursorSessionImporter: CursorSessionImporter;
	kimiSessionImporter: KimiSessionImporter;
	/** Kimi Work（桌面版）会话导入：daimon-share 位置可被用户自定义，scan/import 内部走探测链。 */
	kimiWorkSessionImporter: KimiWorkSessionImporter;
	/** MinimaxCode（CLI）会话导入：数据目录固定 ~/.minimax/v2/sessions，无探测链。 */
	minimaxSessionImporter: MinimaxSessionImporter;
	/** 外置目录会话导入（项目目录移动/改名后找回历史；只建 catalog 引用，不复制原文件）。 */
	directorySessionImporter: DirectorySessionImporter;
	appLogger: AppLogger;
	terminalManager: TerminalSessionManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	emitSessionRuntimeEvent: (agentId: string, channel: string, payload: unknown) => boolean;
	emitSessionRuntimeDetach: (target: SessionRuntimeTarget) => void;
	createAnonymousSession: (input: CreateAnonymousSessionInput) => Promise<CreateAnonymousSessionResult>;
	stopSessionRuntime: (target: SessionRuntimeTarget) => void;
	emitReplacementState: (runtime: SessionRuntimeInfo, includeMessages: boolean) => void;
	readCatalogSessionReferenceMessages: (sessionId: string) => Promise<unknown[]>;
	/**
	 * 无 pi 会话文件的会话（纯生图草稿）历史读取：回退 ImageSession 独立存储。
	 * 未装配（单测/无生图域）时 undefined；调用处 `?? []` 兜底空页。
	 */
	readImageSessionMessages?: (sessionId: string) => Promise<import("../../shared/types").ChatMessage[]>;
	/**
	 * 无 pi 会话文件的会话（生视频后端）历史读取：回退 VideoSession 独立存储。
	 * 未装配（单测/无生视频域）时 undefined；调用处 `?? []` 兜底空页。
	 */
	readVideoSessionMessages?: (sessionId: string) => Promise<import("../../shared/types").ChatMessage[]>;
	copyCatalogSession: (sessionId: string) => Promise<{ cancelled: boolean; targetSessionId?: string }>;
	exportCatalogSessionHtml: (sessionId: string) => Promise<Record<string, unknown> & { path: string }>;
	replaceAgentSession: (agentId: string, fn: () => Promise<unknown>, options?: { markForked?: boolean; markSuperseded?: boolean }) => Promise<unknown>;
	/** fork/clone 统一命令层（与 Web HTTP 共用）：重发/编辑 fork 化语义只在这一处维护。 */
	sessionForkCommands: SessionForkCommands;
};

function sessionCommandIpcError(error: SessionCommandError, appLogger: Pick<AppLogger, "warn">, mainCopy: (key: string, params?: Record<string, string | number>) => string): SessionCommandIpcError {
	logSessionCommandFailure(appLogger, error);
	return new SessionCommandIpcError(error, mainCopy);
}

/**
 * 会话命令失败日志：edit/delete/resend 等 IPC 直接返回 SessionCommandResult，
 * 不走 sessionCommandIpcError 抛错，漏打这条就会出现「toast 失败、主进程无日志」。
 * 标题带上错误码：按 code/关键词（如 edit、BUSY）就能在日志里搜到对应失败，
 * 不依赖结构化字段（2026-10 教训：按「编辑」搜正文一无所获）。
 */
function logSessionCommandFailure(appLogger: Pick<AppLogger, "warn">, error: SessionCommandError, extra?: Record<string, unknown>): void {
	void appLogger.warn("session-command", `Session command failed (${error.code})`, {
		code: error.code,
		...(error.debugDetails ? { debugDetails: error.debugDetails } : {}),
		...extra,
	});
}

async function handleSessionCommandResult<T>(appLogger: Pick<AppLogger, "warn">, operation: string, target: SessionRuntimeTarget, extra: Record<string, unknown>, run: () => Promise<SessionCommandResult<T>>): Promise<SessionCommandResult<T>> {
	const result = await run();
	if (!result.ok) {
		logSessionCommandFailure(appLogger, result.error, {
			operation,
			sessionId: target.sessionId,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
			...extra,
		});
	}
	return result;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
	const titleRequests = registerSessionTitleIpc(ipcMain, deps);
	const {
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		qoderSessionImporter,
		openCodeSessionImporter,
		zcodeSessionImporter,
		workbuddySessionImporter,
		cursorSessionImporter,
		kimiSessionImporter,
		kimiWorkSessionImporter,
		minimaxSessionImporter,
		directorySessionImporter,
		appLogger,
		terminalManager,
		mainCopy,
		getMainWindow,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		// 无 pi 会话文件（纯生图草稿）历史读取回退：ImageSession 独立存储
		readImageSessionMessages,
		// 生视频后端会话历史读取回退：VideoSession 独立存储
		readVideoSessionMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
	} = deps;

	/**
	 * 历史页读取后把文件里的最后模型/思考档位补回 catalog。
	 * 仅补缺失字段，避免旧历史读取覆盖用户后来明确选择的值；运行中 runtime
	 * 有自己的 state，历史回放不参与覆盖。
	 */
	const backfillHistoricalSessionMetadata = async (sessionId: string, metadata: Pick<SessionMessagePage, "model" | "thinkingLevel">): Promise<void> => {
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend === "dsh" || !entry.filePath) return;
		if (entry.model && entry.thinkingLevel) return;
		if (!metadata.model && !metadata.thinkingLevel) return;
		try {
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend === "dsh" || !current.filePath) return;
			const patch: {
				model?: SessionModelPreference;
				thinkingLevel?: string;
				updatedAt: number;
			} = { updatedAt: current.updatedAt };
			if (!current.model && metadata.model) patch.model = createSessionModelPreference(metadata.model.provider, metadata.model.modelId, undefined);
			if (!current.thinkingLevel && metadata.thinkingLevel) {
				patch.thinkingLevel = metadata.thinkingLevel;
			}
			if (!patch.model && patch.thinkingLevel === undefined) return;
			const updated = await sessionCatalog.update(sessionId, patch);
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "Historical session metadata backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	ipcMain.handle(ipcChannels.sessionsList, async (_event, projectId?: string) => {
		const project = projectId ? projectStore.get(projectId) : undefined;
		let projectPath = project?.path;
		// WSL 模式：将 Windows 项目路径转为 WSL /mnt/ 格式，
		// 使 WSL 会话（CWD = /mnt/c/...）能正确匹配到项目。
		if (projectPath && settingsStore.get().wslEnabled && settingsStore.get().wslDistro) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
		}
		return sessionScanner.list(projectPath);
	});
	ipcMain.handle(ipcChannels.sessionsCatalogList, async (_event, projectId: string, options?: { scan?: boolean }) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		let projectPath = project.path;
		const settings = settingsStore.get();
		if (settings.wslEnabled && settings.wslDistro) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
		}
		const { wslEnabled, wslDistro, wslUser } = settings;

		// 扫描 + 合并 + 运行时绑定（首次同步路径与后台路径共用）
		const runScanAndMerge = async (): Promise<SessionRecord[]> => {
			const summaries = await sessionScanner.list(projectPath);
			const records = await sessionCatalog.mergeScanned(projectId, summaries, wslEnabled ? { wslDistro, wslUser } : {});
			// 重发/编辑 fork 化替换：被子会话接替的旧记录不出现在列表（文件保留可恢复，
			// 用户要求 fork 后历史会话不重复）
			const visibleRecords = records.filter((record) => !record.supersededBy);
			const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(visibleRecords);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			return visibleRecords;
		};

		// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）
		const cachedRecords = sessionCatalog
			.listEntries()
			// 与扫描路径同口径：替换标记记录直接跳过（都不必走 getRecord）
			.filter((entry) => entry.projectId === projectId && !entry.supersededBy)
			.map((entry) => sessionCatalog.getRecord(entry.id))
			.filter((record): record is SessionRecord => Boolean(record))
			// 与 mergeScanned 同口径排序：小窗项目选择器直接取 sessions[0]，
			// 乱序会把陈旧记录顶到最前（陈旧子代理记录曾因此在小窗报 ENOENT）。
			.sort((left, right) => right.updatedAt - left.updatedAt)
			// 死链过滤：文件已删但清理闸还没跑到（mergeScanned 在后台异步调度）时，
			// 别让「最近会话」落到一个必然 ENOENT 的记录上。
			// 豁免：无文件记录（imagegen/草稿）、dsh（filePath 由 host 侧解析，
			// 本地路径可能不存在）、UNC/WSL 路径（发行版停机时 existsSync
			// 恒 false，不能误藏整组会话）、活绑定运行时（standby 预分配的
			// sessionPath 在 pi 首条消息前不落盘，existsSync 恒 false；若按死链
			// 隐藏，catalog 刷新会把当前选中的草稿剔出列表 → 渲染层
			// replaceProjectSessionsAtom 清空焦点 → 闪回引导页、输入丢失、
			// 引导页重发另建会话留下孤儿空闲 Agent——2026-10-06 事故，与
			// mergeScanned 的 liveness 豁免同口径）。
			.filter((record) => {
				if (!record.filePath || record.backend === "dsh" || record.backend === "acp" || record.filePath.startsWith("\\\\")) return true;
				// WSL 条目豁免：catalog 存的是 Linux 侧路径（/home/...），宿主 existsSync 恒
				// false，按死链滤掉会把 WSL 用户的全部会话从列表里抹掉（2026-10-07 升级
				// 0.7.9 反馈：58 条会话一条不少躺在 catalog，列表却全空）。
				// 与 mergeScanned 清理闸（environment=wsl 跳过）同口径。
				if (record.environment === "wsl") return true;
				if (sessionRuntimeCoordinator.hasLiveRuntime(record.id)) return true;
				return existsSync(record.filePath);
			});

		// 纯读路径：事件回调/订阅刷新专用，不再触发扫描（防止推送-拉取循环触发）
		if (options?.scan === false) return cachedRecords;

		// 一律先回磁盘 catalog：打包正式 userData 的历史 JSONL 远多于 dev，
		// 首次 await 全量扫描会让侧栏「正在加载历史会话」卡住整窗。
		// 无缓存时回 []，渲染层保持 loading，等 catalog-refreshed 再揭开。
		scannedProjects.add(projectId);
		catalogScanCoordinator.schedule(projectId, async () => {
			try {
				await runScanAndMerge();
			} catch (error) {
				void appLogger.warn("session", "Background catalog scan failed", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				// 成功/失败都通知渲染层：空项目不能永远转圈，失败也要让 UI 可操作。
				const window = getMainWindow();
				if (window && !window.isDestroyed()) {
					window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
				}
			}
		});
		return cachedRecords;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogCreateDraft, async (_event, input: CreateSessionDraftInput) => {
		if (input.backend !== undefined && !isActiveAgentBackend(input.backend)) throw new Error(mainCopy("session.backendRemoved"));
		const project = projectStore.get(input.projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		// DSH 运行能力已移除：历史 dsh 记录保留，但不得再新建 dsh 会话。
		if (input.backend === "dsh") throw new Error(mainCopy("session.dshRuntimeRemoved"));
		// Auto-fill model / thinkingLevel from pi config when the caller hasn't
		// provided them, so the composer bar shows the effective default.
		let model = normalizeSessionModelPreference(input.model);
		let thinkingLevel = input.thinkingLevel;
		if (!model || !thinkingLevel) {
			try {
				const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
				// 引导页/渲染层显式传入的模型（如欢迎页偏好）也可能指向已删除的供应商/模型：
				// 校验其仍存在（models.json ∪ pi 目录，与选择器可选范围一致），不存在则交给
				// 解析器按欢迎页点选 → 配置默认 → enabledModels → lastUsed 的顺序兜底，
				// 避免新会话带着幽灵模型启动。
				if (model) {
					if (
						typeof model.provider !== "string" ||
						typeof model.modelId !== "string" ||
						!isModelInModelsConfig(
							modelsResult.parsed,
							{
								provider: model.provider,
								modelId: model.modelId,
							},
							getCachedModelList(),
						)
					) {
						model = undefined;
					}
				}
				// 缺省填充与引导页展示共用同一解析器（launchDefaults），
				// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
				// 欢迎页偏好（renderer localStorage）同样经主进程校验存在性后按
				// 「欢迎页点选 > 显式默认 > enabledModels > 上次使用 > 空」参与解析；
				// explicit model（用户主动指名）仍优先于一切（input.model，见上方校验）。
				const defaults = resolveLaunchDefaultOptions({
					backend: input.backend,
					settings: settingsResult.parsed,
					models: modelsResult.parsed,
					// pi 目录快照（同步，冷时 null）：lastUsed/welcomeModel 的存在性校验
					// 按 models.json ∪ 目录判定，与选择器可选范围一致。
					catalogModels: getCachedModelList(),
					// lastUsed 语义：用户最近一次实际发送所用模型；仅无显式默认与偏好时参与。
					lastUsedModel: settingsStore.get().lastUsedModel,
					welcomeModel: input.welcomeModel && typeof input.welcomeModel.provider === "string" && typeof input.welcomeModel.modelId === "string" ? input.welcomeModel : undefined,
				});
				if (!model) {
					model = defaults.model;
				}
				if (!thinkingLevel) {
					// 每模型默认档位优先于全局默认，且必须按**最终生效的模型**查（显式传入的
					// model / welcomeModel 可能不是解析器选出的默认模型）：pi 在新建与切换模型时
					// 都按「显式选择 > 每模型默认 > 全局默认」解析再 clamp，这里同序才能保证
					// 首轮请求用的档位与引导页底栏展示的一致。DSH 无 pi 模型身份，跳过。
					const perModelThinkingLevel = model && typeof model.provider === "string" && typeof model.modelId === "string" ? modelThinkingLevelOf(settingsResult.parsed, model.provider, model.modelId) : undefined;
					thinkingLevel = perModelThinkingLevel ?? defaults.thinkingLevel;
				}
			} catch {
				// Config read is best-effort; draft creation must never block.
			}
		}
		const draft = await sessionCatalog.createDraft({
			projectId: input.projectId,
			title: input.title?.trim() || mainCopy("session.newTitle"),
			environment: settingsStore.get().wslEnabled ? "wsl" : "native",
			// 后端透传：仅接受白名单枚举，其余视为 pi（渲染层不可信输入校验在边界）。
			backend: undefined,
			// ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI。

			model,
			thinkingLevel,
		});
		void appLogger.info("session", "Session draft created", {
			sessionId: draft.id,
			projectId: input.projectId,
			title: draft.title,
			model: draft.model,
		});
		// standby 补热：草稿创建是「用户马上要开聊」的最强信号，趁用户阅读/输入的空窗
		// 后台预热一个 pi 进程待命（fire-and-forget；ensure 幂等且受 standbyRuntimeEnabled 闸）。
		agentManager.ensureStandbyAgent(input.projectId);
		return draft;
	});
	ipcMain.handle(ipcChannels.sessionsResolveLaunchDefaults, async (_event, input?: ResolveLaunchDefaultsInput): Promise<ResolvedLaunchDefaults> => {
		// 后端仅剩 pi（DSH/ACP 已移除），默认偏好按 pi 链路解析。
		try {
			const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
			return resolveLaunchDefaultOptions({
				settings: settingsResult.parsed,
				models: modelsResult.parsed,
				// 与 createDraft 同源：存在性校验含 pi 目录，否则引导页预选与创建再次分叉。
				catalogModels: getCachedModelList(),
				// lastUsed 语义：引导页预选默认 = 用户最后一次实际使用的模型。
				lastUsedModel: settingsStore.get().lastUsedModel,
			});
		} catch {
			// 配置读取失败返回空默认：引导页退回「无预选」形态，不阻塞 UI；
			// 创建会话链路自身仍会 best-effort 重试。
			return {};
		}
	});
	ipcMain.handle(ipcChannels.sessionsCreateAnonymous, async (_event, input: CreateAnonymousSessionInput) => {
		if (input.backend !== undefined && !isActiveAgentBackend(input.backend)) throw new Error(mainCopy("session.backendRemoved"));
		// DSH 运行能力已移除：匿名会话同样不得落在 dsh 后端上。
		if (input.backend === "dsh") throw new Error(mainCopy("session.dshRuntimeRemoved"));
		const result = await createAnonymousSession(input);
		void appLogger.info("session", "Anonymous session created", {
			sessionId: result.session.id,
			projectId: input.projectId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUpdate, async (_event, sessionId: string, patch: UpdateSessionRecordInput) => {
		if (patch.backend !== undefined && !isActiveAgentBackend(patch.backend)) throw new Error(mainCopy("session.backendRemoved"));
		const normalizedModel = patch.model === undefined ? undefined : patch.model === null ? null : normalizeSessionModelPreference(patch.model);
		if (patch.model !== undefined && patch.model !== null && !normalizedModel) {
			throw new Error(mainCopy("session.invalidModel"));
		}
		if (patch.model !== undefined) {
			patch = { ...patch, model: normalizedModel };
		}
		const entry = sessionCatalog.get(sessionId);
		if (!entry) throw new Error(mainCopy("session.notFound"));
		// 后端锁定（草稿期可改，激活后禁止）：pi 会话文件（JSONL）与 DSH 会话
		// （host session log）格式不同，中途切换会导致消息同步渲染不可靠。
		// 已 active 或已有 runtime 的会话拒绝 backend 变更（渲染层已隐藏入口，这里是边界防御）。
		if (patch.backend !== undefined && patch.backend !== entry.backend && (entry.status === "active" || sessionRuntimeCoordinator.getTarget(sessionId))) {
			throw new Error(mainCopy("session.backendLocked"));
		}
		// 草稿会话切到非 pi 后端时回收本项目的 standby 预热进程：它服务不了这个会话，
		// 不主动丢就只能等 10min TTL 自然到期（用户反馈的「没用到还占着内存」）。
		// 放在锁定判定之后：已锁定的会话会先报错，不改状态也不回收进程。
		if (patch.backend !== undefined && patch.backend !== entry.backend && patch.backend !== "pi") {
			agentManager.releaseStandbyAgent(entry.projectId);
		}
		const title = patch.title?.trim();
		if (title) titleRequests.invalidate(sessionId);
		if (title && title !== entry.title) {
			// Reserve the catalog before the asynchronous pi rename. A late automatic-title
			// result must observe manual ownership even while set_session_name is in flight.
			await sessionCatalog.claimTitleOwnership(sessionId);
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) {
				const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
				if (!renamed.ok) throw sessionCommandIpcError(renamed.error, appLogger, mainCopy);
			} else if (entry.filePath) {
				await sessionScanner.rename(entry.filePath, title);
				void appLogger.info("session", "Session renamed (file)", {
					sessionId,
					oldTitle: entry.title,
					newTitle: title,
				});
			}
		}
		return sessionCatalog.update(sessionId, {
			...patch,
			title: title || undefined,
			// 切到生图/生视频/ACP 后端时甩开 pi 会话文件引用：生图历史独立存 ImageSessionStore，
			// 生视频独立存 VideoSessionStore，ACP 会话由 agent CLI 自持（session/new 在远端）；
			// 残留 filePath 会让历史加载误落到不存在的 pi 文件（ENOENT 根因，imagegen 同款）。
			...(patch.backend === "imagegen" || patch.backend === "videogen" || patch.backend === "acp" ? { filePath: null, piSessionId: null } : {}),
		});
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDelete, async (_event, sessionId: string) => {
		const entry = sessionCatalog.get(sessionId);
		if (!entry) return false;
		// 删除即先杀后删：失败一次/卡在 bound 的会话也能删掉。
		// 仍按路径扫一遍游离 agent，避免只解绑 catalog 却留着进程。
		await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
		try {
			// DSH 没有 session.delete：host 目录会留在 $DSH_HOME。先记墓碑再删映射，
			// 否则 refreshProjectTree 的自动同步会把同一条再导入。运行中也允许删。
			if (entry.backend === "dsh" && entry.dshSessionId) {
				await sessionCatalog.rememberDismissedDshSession(entry.dshSessionId);
			}
			if (entry.filePath) {
				const normalizedTarget = canonicalizeSessionPath(entry.filePath, entry.environment);
				const usingAgent = agentManager
					.list()
					.find((agent) => agent.sessionPath && agent.sessionEnvironment === entry.environment && (entry.environment !== "wsl" || (agent.wslDistro === entry.wslDistro && agent.wslUser === entry.wslUser)) && canonicalizeSessionPath(agent.sessionPath, entry.environment) === normalizedTarget);
				if (usingAgent) {
					await sessionRuntimeCoordinator.stopAgentById(usingAgent.id).catch(() => undefined);
					await agentManager.stop(usingAgent.id).catch(() => undefined);
				}
				await sessionScanner.delete(entry.filePath);
			}
			// 磁盘会把 sibling `<stem>/` 一并删掉；catalog 必须同步摘掉整棵子树，
			// 否则 mergeScanned 只增改不删，子会话会孤儿提升成顶层行。
			await sessionCatalog.removeWithDescendants(sessionId);
			void appLogger.info("session", "Catalog session deleted", { sessionId, filePath: entry.filePath });
			return true;
		} catch (error) {
			// 会话删除失败（文件删除失败/记录移除失败/会话使用中拦截）也要留痕，便于事后追踪。
			void appLogger.error("session", "Catalog session delete failed", {
				sessionId,
				filePath: entry.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsCatalogArchive, async (_event, sessionId: string) => {
		const entry = sessionCatalog.get(sessionId);
		// DSH 运行能力已移除：归档要搬移 host 目录，已无运行时可用。原文件保留在
		// $DSH_HOME/sessions，用户可经「复制会话文件路径」定位；这里明确拒绝而不是
		// 删记录假装归档成功。
		if (entry?.backend === "dsh") {
			throw new Error(mainCopy("session.dshRuntimeRemoved"));
		}
		if (!entry?.filePath) return false;
		// 运行中的会话不能归档（同删除）：移动文件会破坏 pi 对当前写入位置的引用。
		if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
			throw new Error(mainCopy("session.stopBeforeDelete"));
		}
		const archivedPath = await sessionScanner.archive(entry.filePath);
		// scanner.archive 会把 sibling `<stem>/` 一并移走；catalog 同步清子树，避免幽灵子会话。
		await sessionCatalog.removeWithDescendants(sessionId);
		void appLogger.info("session", "Session archived", { sessionId, archivedPath });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUnarchive, async (_event, archivedPath: string) => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		const restoredPath = await sessionScanner.unarchive(archivedPath);
		void appLogger.info("session", "Session restored from archive", { restoredPath });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogListArchived, async () => sessionScanner.listArchived());
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteArchived, async (_event, archivedPath: unknown): Promise<boolean> => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		// 是否真的位于归档目录内由 sessionScanner.deleteArchived 兜底校验。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		await sessionScanner.deleteArchived(archivedPath);
		void appLogger.info("session", "Archived session deleted", { archivedPath });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessages, async (_event, sessionId: string) => {
		const entry = sessionCatalog.get(sessionId);
		// DSH 运行能力已移除：历史不可解析（会话日志在 $DSH_HOME，读取依赖 host）。
		// 渲染层对 dsh 条目直接展示「运行时已移除」专态，不依赖本接口返回内容。
		if (entry?.backend === "dsh") return [];
		// ACP 后端在更早的功能减负中已移除：旧记录无历史可读。
		if (entry?.backend === "acp") return [];
		if (entry?.backend === "imagegen") {
			// imagegen 后端会话：历史独立存 ImageSessionStore，不走 pi 文件
			return (await readImageSessionMessages?.(sessionId)) ?? [];
		}
		if (entry?.backend === "videogen") {
			// videogen 后端会话：历史独立存 VideoSessionStore（任务占位/终态按消息 id 折叠）
			return (await readVideoSessionMessages?.(sessionId)) ?? [];
		}
		if (!entry?.filePath) return [];
		// 有界「加载窗口」（9 轮 + 条目预算），不是全量历史：整量读出在大会话上
		// 会同时顶爆主进程与渲染层（#213）；需要更早历史走 readRecordMessagePage。
		const window = await agentManager.readSessionLoadWindow(entry.filePath, sessionId, { projectId: entry.projectId });
		const messages = window.messages;
		const metadata = await agentManager.readSessionDisplayMetadata(entry.filePath);
		await backfillHistoricalSessionMetadata(sessionId, metadata);
		return messages;
	});
	/** 会话分支树（右侧抽屉「分支」面板）：只读文件索引，无需活 runtime；DSH/imagegen 无 pi 文件返回 null。 */
	ipcMain.handle(ipcChannels.sessionsGetBranchTree, async (_event, sessionId: unknown): Promise<SessionBranchTree | null> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid branch-tree request");
		const entry = sessionCatalog.get(sessionId);
		// DSH / imagegen / videogen 会话没有 pi JSONL：面板按空态处理，不报错。
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen" || entry.backend === "acp") return null;
		return agentManager.readSessionBranchTree(entry.filePath);
	});
	/** 子代理列表：从会话文件 subagents:record + catalog 子会话回填合成。 */
	ipcMain.handle(ipcChannels.sessionsListSubagents, async (_event, sessionId: string) => {
		if (typeof sessionId !== "string" || !sessionId) return [];
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) return [];
		// 锚点对账要在读取侧做（liveRuntimeStartedAt）：record 完成时才写，运行中
		// 子代理只剩 start 锚点，不传对账时间会一律合成 stopped，面板在子代理
		// 实际运行期间误显「已停止」（issue #300）。本代派发的锚点 → running。
		const liveTarget = sessionRuntimeCoordinator.getTarget(sessionId);
		const liveTab = liveTarget ? agentManager.list().find((t) => t.id === liveTarget.agentId) : undefined;
		let records = await agentManager.readSessionSubagentRecords(entry.filePath, { liveRuntimeStartedAt: liveTab?.createdAt });
		// acp_delegate 推导条目在会话无活 runtime 时残留的 running 视为已终止：
		// 终态通知没写进文件（进程被杀/崩溃）的委托在历史会话里永远是 running，
		// 会误导为仍在运行；活会话保持 running，由后续通知/桥接覆盖。
		// 与 start 锚点残留合成 stopped 同一语义（见 downgradeStaleRunning）。
		if (!liveTarget) {
			if (!sessionRuntimeCoordinator.isActivating(sessionId)) {
				records = downgradeStaleRunning(records);
			}
		} else {
			// 活 runtime 也要对账：本代 runtime 启动（tab.createdAt）之前派发的
			// running/queued 已随上一代 pi 进程消亡，永远等不到终态写盘。渲染层
			// hook 在绑定出现时会重新拉取本列表，激活完成后即看到降级结果
			//（2026-09-14 用户环境实测：真实活动子代理 0，历史投影仍显示 33 个
			// running；启动之后派发的异步运行不受影响，保持 running）。
			if (liveTab?.createdAt) {
				records = downgradeRunningStartedBefore(records, liveTab.createdAt);
			}
		}
		// 回填 childSessionPath：按 parentSessionPath === 本会话 filePath 收集所有子会话，
		// 再按子会话名 `${type}#${id前8位}` 精确匹配。
		const children = sessionCatalog
			.listEntries()
			.filter((e) => e.parentSessionPath === entry.filePath)
			.map((e) => sessionCatalog.getRecord(e.id))
			.filter((r): r is NonNullable<typeof r> => r != null);
		for (const record of records) {
			const namePrefix = `${record.type}#${record.id.slice(0, 8)}`;
			const child = children.find((s) => (s.title ?? "").startsWith(namePrefix));
			if (child?.filePath) record.childSessionPath = child.filePath;
			if (child) record.childSessionId = child.id;
		}
		return records;
	});
	/**
	 * 会话级文件修改汇总：只读会话文件「最新一轮」的 write/edit/create/patch
	 * （有界读，不展开整条活动分支；历史/活会话通用）。
	 */
	ipcMain.handle(ipcChannels.sessionsListFileChanges, async (_event, sessionId: string) => {
		if (typeof sessionId !== "string" || !sessionId) return [];
		const entry = sessionCatalog.get(sessionId);
		// DSH/生图/生视频会话无 pi 会话文件，文件汇总无意义
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen") return [];
		return agentManager.readSessionFileChanges(entry.filePath);
	});
	/** 会话级 todo 快照：从会话文件 pi-deck-todo custom 条目重建最新计划（历史会话任务 tab）。 */
	ipcMain.handle(ipcChannels.sessionsListSessionTodo, async (_event, sessionId: string) => {
		if (typeof sessionId !== "string" || !sessionId) return undefined;
		const entry = sessionCatalog.get(sessionId);
		// DSH/生图/生视频会话无 pi 会话文件，无 todo 快照
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen") return undefined;
		return agentManager.readSessionTodo(entry.filePath);
	});

	ipcMain.handle(ipcChannels.sessionsCatalogReadMessagePage, async (_event, sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string }) => {
		const entry = sessionCatalog.get(sessionId);
		// DSH 运行能力已移除：历史读取依赖 host，返回带原因的空页让渲染层出专态
		// （不抛裸异常，避免被当成「会话文件已删除」），原文件仍在 $DSH_HOME。
		if (entry?.backend === "dsh") {
			return { messages: [], total: 0, nextBefore: null, unavailable: "dsh-runtime-removed" as const };
		}
		if (entry?.backend === "imagegen" || entry?.backend === "videogen" || !entry?.filePath) {
			// imagegen/videogen 后端会话（可能残留无意义 pi filePath）或纯生图草稿：
			// 走独立存储恢复历史（生图 ImageSession / 生视频 VideoSession），避免落到不存在的 pi 文件
			const independentMessages = entry?.backend === "videogen" ? ((await readVideoSessionMessages?.(sessionId)) ?? []) : ((await readImageSessionMessages?.(sessionId)) ?? []);
			if (independentMessages.length > 0) {
				return {
					messages: independentMessages,
					total: independentMessages.length,
					nextBefore: null,
				};
			}
			return { messages: [], total: 0, nextBefore: null };
		}
		// 读盘失败（文件被删/路径失效/解析异常）不能静默：渲染层靠 reject 显示明确错误态，
		// 否则「正在加载历史」骨架无限滞留（2026-08 生图会话文件缺失反馈）。
		try {
			let page: SessionMessagePage;
			// Pi 历史统一按完整轮次分页：磁盘会话首次打开、继续上翻、
			// 以及运行时窗口补历史都共享同一页边界和游标协议。
			// 缓存优先（2026-11）：运行中会话翻历史先在主进程内存缓存切片，命中免文件 IO；
			// 未命中（缓存未覆盖/非活跃会话）回退 SessionHistoryReader 读文件。
			// 注意：缓存按 transient agentId 键控，必须经 coordinator 把稳定 sessionId
			// 解析成当前运行时 agentId；解析不到（非活跃/终端绑定）直接走文件路径。
			if (options?.beforeEntryId || typeof before === "number") {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const cached = await agentManager
						.tryReadRuntimeTurnPage(entry.filePath, target.agentId, {
							beforeEntryId: options?.beforeEntryId,
							before,
							turnCount: pageSize,
						})
						.catch(() => null);
					if (cached) return cached;
				}
			}
			page = await agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, options?.beforeEntryId, { projectId: entry.projectId });
			await backfillHistoricalSessionMetadata(sessionId, page);
			return page;
		} catch (error) {
			// 文件读取失败（被删/路径失效）先查 ImageSession 兜底，命中则直接恢复历史；
			// 都无记录才按失败处理（渲染层显示明确错误态 + 日志）。
			const imageSessionMessages = (await readImageSessionMessages?.(sessionId)) ?? [];
			if (imageSessionMessages.length > 0) {
				return {
					messages: imageSessionMessages,
					total: imageSessionMessages.length,
					nextBefore: null,
				};
			}
			appLogger.warn("session", "Read message page failed", {
				sessionId,
				filePath: entry.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsCatalogReadProcessEvents, async (_event, sessionId: string): Promise<SessionProcessEvent[]> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) return [];
		const entry = sessionCatalog.get(sessionId);
		// DSH 会话没有 pi 会话文件：过程事件由运行时会话按 mux/重放收集，
		if (!entry?.filePath) return [];
		// 流式扫描（收够 MAX_EVENTS 即停）：历史大会话读全文会撞 V8 单字符串上限 /
		// 主进程 384MB 堆上限（闪退），而账本只需要前若干条记录。
		return parseSessionProcessEventsFromFile(entry.filePath);
	});
	ipcMain.handle(ipcChannels.sessionsCatalogReadReferenceMessages, (_event, sessionId: string) => readCatalogSessionReferenceMessages(sessionId));
	// 按需读取消息完整文本（工具结果截断后的「查看完整输出」）：
	// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串。
	// 运行期路径（agentId 绑定）不可用时（历史会话 _viewer 投影 / agent 已退出）
	// 回退会话文件定位（sessionId → catalog filePath），保证历史浏览同样可展开全文。
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessageFullText, async (_event, sessionId: unknown, agentId: unknown, messageId: unknown, entryId?: unknown) => {
		if (typeof agentId !== "string" || !agentId.trim() || typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid message full-text request");
		}
		if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
			throw new Error("Invalid sessionId");
		}
		if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) {
			throw new Error("Invalid entryId");
		}
		try {
			return await agentManager.readMessageFullText(agentId, messageId, entryId as string | undefined);
		} catch (error) {
			if (typeof sessionId === "string" && sessionId.trim()) {
				const record = sessionCatalog.get(sessionId);
				if (record?.filePath) {
					return agentManager.readMessageFullTextFromFile(record.filePath, messageId, entryId as string | undefined);
				}
			}
			throw error;
		}
	});
	// 旧 DSH 会话文件路径推导（只读兼容）：不启动任何运行时，按 catalog 的
	// dshSessionId + 项目 cwd + DSH_HOME（设置覆盖 > ~/.dsh）推导 host 日志路径，
	// 供「复制会话文件路径 / 打开所在目录」定位原文件。
	ipcMain.handle(ipcChannels.sessionsGetDshSessionPath, async (_event, sessionId: unknown): Promise<string | undefined> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.dshSessionId) return undefined;
		const cwd = projectStore.get(entry.projectId)?.path;
		if (!cwd) return undefined;
		return dshSessionFilePath(resolveDshLegacyHome(settingsStore.get().dshHomeDir), cwd, entry.dshSessionId);
	});
	ipcMain.handle(ipcChannels.sessionsCatalogCopy, async (_event, sessionId: string) => {
		const result = await copyCatalogSession(sessionId);
		void appLogger.info("session", "Session copied", {
			sessionId,
			targetSessionId: result.cancelled ? undefined : result.targetSessionId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogExportHtml, async (_event, sessionId: string) => {
		const result = await exportCatalogSessionHtml(sessionId);
		void appLogger.info("session", "Session exported (catalog HTML)", {
			sessionId,
			path: result.path,
		});
		return result;
	});
	registerSessionImageMutationIpc(ipcMain, sessionRuntimeCoordinator, (error, context) => {
		logSessionCommandFailure(appLogger, error, { operation: "removeCatalogMessageImage", ...context });
	});
	// catalog 级消息改写：按 sessionId 操作 JSONL，不要求 live runtime。
	// 运行中必须先停（coordinator 拒绝 SESSION_RUNTIME_BUSY）；入参在边界校验。
	ipcMain.handle(ipcChannels.sessionsCatalogEditMessage, async (_event, sessionId: unknown, messageId: unknown, newText: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof newText !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		const result = await sessionRuntimeCoordinator.editCatalogMessage(sessionId, messageId, newText, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "editCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteMessage, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog delete-message request");
		}
		const result = await sessionRuntimeCoordinator.deleteCatalogMessage(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "deleteCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogPrepareResend, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog prepare-resend request");
		}
		const result = await sessionRuntimeCoordinator.prepareCatalogResend(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "prepareCatalogResend",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsSendPrompt, async (_event, input: SendSessionPromptInput) => {
		// Validate before logging/dereferencing or passing the untrusted target to the coordinator.
		if (!isRecord(input) || typeof input.sessionId !== "string" || typeof input.requestId !== "string" || typeof input.message !== "string" || !isValidExpectedPromptRuntime(input)) {
			return {
				accepted: false,
				delivery: "rejected",
				error: "Invalid session prompt runtime target",
				i18nKey: "diagnostic.promptRejected",
				debugDetails: "Invalid session prompt runtime target",
				sessionId: typeof input?.sessionId === "string" ? input.sessionId : "",
				requestId: typeof input?.requestId === "string" ? input.requestId : "",
			};
		}
		const startedAt = Date.now();
		void appLogger.info("session", "Session prompt IPC received", {
			sessionId: input.sessionId,
			requestId: input.requestId,
			messageLength: input.message.length,
			imageCount: input.images?.length ?? 0,
		});
		try {
			// 渲染层入参过白名单：伪造的投递选项（例如 internalControl）在这里被丢弃，
			// 渲染层永远不能请求隐藏的时间线消息。
			const result = await sessionRuntimeCoordinator.send(sanitizeRendererPromptInput(input));
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			// 消息被接受才记「最后一次使用」（选而未发不算）：写入 desktop settings.lastUsedModel，
			// 新会话默认解析（launchDefaults）以它优先。fire-and-forget，不阻塞发送响应。
			// 非 pi 后端（旧 DSH/ACP 记录）跳过：模型归属各自运行时，记录会污染 pi 侧解析。
			// 同时维护 recentProviders（最新在前，去重截断 8）：模型选择器按此优先排列供应商分组。
			if (result.accepted) {
				const record = sessionCatalog.get(input.sessionId);
				if (record?.backend !== "dsh" && record?.backend !== "acp" && record?.model?.provider && record?.model?.modelId) {
					const provider = record.model.provider;
					const current = settingsStore.get().recentProviders ?? [];
					// 当前供应商提到首位，其余保持原有相对顺序；SettingsStore 会做去重/截断/无变化早退。
					const recentProviders = [provider, ...current.filter((item) => item !== provider)];
					void settingsStore
						.update({
							lastUsedModel: {
								provider,
								modelId: record.model.modelId,
							},
							recentProviders,
						})
						.catch((error) => {
							void appLogger.warn("settings", "Failed to record lastUsedModel", {
								error: error instanceof Error ? error.message : String(error),
							});
						});
				}
			}
			void appLogger.info("session", "Session prompt IPC completed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: result.agentId,
				accepted: result.accepted,
				delivery: "delivery" in result ? result.delivery : undefined,
				totalMs: Date.now() - startedAt,
			});
			return result;
		} catch (error) {
			void appLogger.warn("session", "Session prompt IPC failed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsUiResponse, (_event, input: SessionUiResponseInput) => sessionRuntimeCoordinator.respondToUi(input));
	/**
	 * GUI 扩展桥：渲染进程回灌交互事件 → 排入该 agent 的桥队列。
	 *
	 * 边界校验（AGENTS.md「输入校验在边界」）：
	 * - 三个身份字段必填（sessionId / agentId / runtimeGeneration）
	 * - runtimeGeneration 必须与该会话当前 runtime 一致，拒绝旧 runtime 的迟到事件
	 * 失败一律返回 false（渲染层据此静默丢弃），**不抛错跨 IPC**。
	 */
	ipcMain.handle(ipcChannels.sessionsBridgeEvent, (_event, input: BridgeEventInput) => {
		if (!input || typeof input !== "object") return false;
		const { sessionId, agentId, runtimeGeneration, event } = input;
		if (typeof sessionId !== "string" || !sessionId) return false;
		if (typeof agentId !== "string" || !agentId) return false;
		if (typeof runtimeGeneration !== "number" || !Number.isFinite(runtimeGeneration)) return false;
		if (!event || typeof event !== "object" || typeof event.type !== "string") return false;
		const current = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!current || current.agentId !== agentId || current.runtimeGeneration !== runtimeGeneration) {
			// 旧 runtime 的迟到事件：丢弃，不报错
			return false;
		}
		return sessionRuntimeCoordinator.pushBridgeEvent(agentId, event);
	});
	/**
	 * GUI 扩展桥：渲染进程要求桥**全量重推一次**（§9.4）。
	 *
	 * 边界校验与 `sessionsBridgeEvent` 完全一致（三个身份字段 + runtime 一致性）——
	 * 不新写一套规则，避免两处漂移。失败一律返回 false，**不抛错跨 IPC**。
	 */
	ipcMain.handle(ipcChannels.sessionsBridgeResync, (_event, input: BridgeResyncInput) => {
		if (!input || typeof input !== "object") return false;
		const { sessionId, agentId, runtimeGeneration } = input;
		if (typeof sessionId !== "string" || !sessionId) return false;
		if (typeof agentId !== "string" || !agentId) return false;
		if (typeof runtimeGeneration !== "number" || !Number.isFinite(runtimeGeneration)) return false;
		const current = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!current || current.agentId !== agentId || current.runtimeGeneration !== runtimeGeneration) {
			// 旧 runtime 的迟到请求：忽略，不报错
			return false;
		}
		return sessionRuntimeCoordinator.requestBridgeResync(agentId);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeList, () => sessionRuntimeCoordinator.listRuntimes());
	ipcMain.handle(ipcChannels.sessionsRuntimeActivate, async (_event, sessionId: string) => {
		const startedAt = Date.now();
		void appLogger.info("session-perf", "Runtime activation IPC started", { sessionId });
		const result = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		void appLogger.info("session-perf", "Runtime activation IPC completed", {
			sessionId,
			ok: result.ok,
			activationMs: Date.now() - startedAt,
			// 失败时带错误详情（此前只记 ok:false，排障要翻渲染层 toast）
			...(result.ok
				? {}
				: {
						error: result.error?.debugDetails ?? JSON.stringify(result.error),
					}),
		});
		return result;
	});
	// 渲染层切换会话时汇报聚焦会话；主进程据此判断 Ask 类请求是否需要桌面通知
	ipcMain.handle(ipcChannels.sessionsSetFocusedSession, (_event, sessionId: unknown) => {
		sessionRuntimeCoordinator.setFocusedSession(typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeStop, (_event, target: SessionRuntimeTarget) => stopSessionRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeAbort, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.abortRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeRestart, async (_event, target: SessionRuntimeTarget) => {
		terminalManager.closeAgent(target.agentId);
		const result = await sessionRuntimeCoordinator.restartRuntime(target);
		if (result.ok) {
			// A --no-session restart is a binding replacement, not a close. Its
			// higher generation state event clears old runtime UI without deleting
			// the transient SessionRecord from the renderer.
			if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
			// 必须重下发消息窗口（含状态）：新 runtime 加载历史后的首次 flush 发生在
			// 绑定提交之前，emitSessionRuntimeEvent 的 getRuntimeBinding 会把它静默丢弃——
			// 若这里只补状态，渲染层会一直保留旧 runtime 的窗口/live 身份，
			// 重启后编辑/删除/重发会定位失败（MESSAGE_NOT_FOUND，2026-09 用户反馈）。
			// id 稳定性由 loadMessages 的会话级身份延续保证（stabilizeProjectedIdsFromIdentities），
			// 重下发不会触发整窗 remount/动画重放。
			emitReplacementState(result.value.runtime, true);
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeCompact, (_event, target: SessionRuntimeTarget, prompt?: string) => sessionRuntimeCoordinator.compactRuntime(target, prompt));
	ipcMain.handle(ipcChannels.sessionsRuntimeState, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.getRuntimeState(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeCommands, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeCommands(target));
	// 草稿命令预览是只读提示增强：入参只有 projectId，非法值在 coordinator 层自然返回 null。
	ipcMain.handle(ipcChannels.sessionsDraftCommands, (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim()) return null;
		return sessionRuntimeCoordinator.draftCommands(projectId);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeListModels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeModels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeThinkingLevels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeThinkingLevels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeExportHtml, async (_event, target: SessionRuntimeTarget) => {
		const result = await sessionRuntimeCoordinator.exportRuntimeHtml(target);
		void appLogger.info("session", "Session exported (runtime HTML)", {
			sessionId: target.sessionId,
			ok: result.ok,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeEditMessage, (_event, target: SessionRuntimeTarget, messageId: string, newText: string) => handleSessionCommandResult(appLogger, "editRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText)));
	ipcMain.handle(ipcChannels.sessionsRuntimeDeleteMessage, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "deleteRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId)));
	// rewind checkpoint：list/diff 是只读命令（同 sessionsRuntimeCommands 风格），
	// restore 是变更操作，走 handleSessionCommandResult 留日志。
	ipcMain.handle(ipcChannels.sessionsRewindList, (_event, target: SessionRuntimeTarget, params?: RewindCheckpointPageParams) => sessionRuntimeCoordinator.listRewindCheckpoints(target, params));
	ipcMain.handle(ipcChannels.sessionsRewindDiff, (_event, target: SessionRuntimeTarget, checkpointId: string) => sessionRuntimeCoordinator.getRewindCheckpointDiff(target, checkpointId));
	ipcMain.handle(ipcChannels.sessionsRewindRestore, (_event, target: SessionRuntimeTarget, checkpointId: string, scope: unknown) => {
		// 渲染层入参不可信：scope 必须在契约枚举内（校验前置到 coordinator 之外再挡一层）。
		if (!isRewindRestoreScope(scope)) {
			return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope: String(scope) }, () =>
				Promise.resolve({
					ok: false,
					error: {
						code: "SESSION_COMMAND_FAILED",
						debugDetails: `Invalid rewind restore scope: ${String(scope)}`,
					},
				}),
			);
		}
		return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope }, async () => {
			const result = await sessionRuntimeCoordinator.restoreRewindCheckpoint(target, checkpointId, scope);
			// conversation/all 会在检查点 fork 出新会话（runtime 已换绑新文件）：
			// 趁运行态拿到新 sessionPath，同步给 catalog 打 fork 标记（列表 (fork) 后缀），
			// 不依赖后续扫描才识别。fork 锚点解析失败时不会走到这一步。
			if (result.ok && scope !== "files") {
				const tab = agentManager.list().find((candidate) => candidate.id === target.agentId);
				if (tab?.sessionPath) {
					const environment = tab.sessionEnvironment ?? "native";
					const entry = sessionCatalog.findByFilePath(tab.sessionPath, environment);
					if (entry) {
						await sessionCatalog.update(entry.id, { forked: true });
						// (fork) 物理写进会话名（与 fork/clone 一致，见 appendSessionForkSuffix）：
						// 走 pi set_session_name RPC。注意 rewind 恢复不重建 runtime 绑定
						// （绑定仍指向原会话），rename 触发的标题回写会落到原条目标题上，
						// 因此记录原条目标题并在完成后恢复，避免「原会话被改名成 xxx (fork)」。
						const forkedTitle = appendSessionForkSuffix(entry.title, mainCopy("session.forkedSuffix"));
						if (forkedTitle !== entry.title) {
							const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(target.agentId);
							const originSessionId = originBinding?.sessionId;
							const originTitle = originSessionId && originSessionId !== entry.id ? sessionCatalog.get(originSessionId)?.title : undefined;
							try {
								await agentManager.rename(target.agentId, forkedTitle);
								await sessionCatalog.update(entry.id, { title: forkedTitle });
								if (originSessionId && originTitle !== undefined) {
									await sessionCatalog.update(originSessionId, { title: originTitle });
								}
							} catch (error) {
								void appLogger.warn("session", "Rewind fork suffix rename failed", {
									sessionId: entry.id,
									agentId: target.agentId,
									title: entry.title,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					}
				}
			}
			return result;
		});
	});
	ipcMain.handle(ipcChannels.sessionsRuntimePrepareResend, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "prepareRuntimeResend", target, { messageId }, () => sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId)));
	ipcMain.handle(ipcChannels.sessionsRuntimeSetModel, (_event, target: SessionRuntimeTarget, provider: unknown, modelId: unknown, modelName?: unknown) => {
		if (typeof provider !== "string" || typeof modelId !== "string" || (modelName !== undefined && typeof modelName !== "string") || !provider.trim() || !modelId.trim() || provider.length > 128 || modelId.length > 256 || (typeof modelName === "string" && modelName.length > 256)) {
			return Promise.resolve({
				ok: false as const,
				error: {
					code: "SESSION_COMMAND_FAILED" as const,
					debugDetails: "Invalid model selection",
				},
			});
		}
		return sessionRuntimeCoordinator.setRuntimeModel(target, provider.trim(), modelId.trim(), modelName);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeSetThinking, (_event, target: SessionRuntimeTarget, level: string) => sessionRuntimeCoordinator.setRuntimeThinking(target, level));
	// fork/clone 命令链已收口到 sessionForkCommands（与 Web HTTP 同源）：重发/编辑
	// fork 化（mutationFork/branchMode）、supersededBy 隐藏、catalog 刷新广播
	// 都在那一层维护，两端行为必须一致（Web 重发后出现两个重复会话的教训）。
	ipcMain.handle(ipcChannels.sessionsRuntimeClone, (_event, target: SessionRuntimeTarget) => deps.sessionForkCommands.cloneRuntimeSession(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeGetForkMessages, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.getRuntimeForkMessages(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeFork, (_event, target: SessionRuntimeTarget, entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) => deps.sessionForkCommands.forkRuntimeSession(target, entryId, options));
	ipcMain.handle(ipcChannels.codexSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await codexSessionImporter.scan(project.path);
		void appLogger.debug("session", "Codex sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.codexSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await codexSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Codex sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await claudeSessionImporter.scan(project.path);
		void appLogger.debug("session", "Claude sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await claudeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Claude sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await qoderSessionImporter.scan(project.path);
		void appLogger.debug("session", "Qoder sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await qoderSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Qoder sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await openCodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "OpenCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await openCodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "OpenCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await zcodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "ZCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await zcodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "ZCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await workbuddySessionImporter.scan(project.path);
		void appLogger.debug("session", "WorkBuddy sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await workbuddySessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "WorkBuddy sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await cursorSessionImporter.scan(project.path);
		void appLogger.debug("session", "Cursor sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await cursorSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Cursor sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await kimiSessionImporter.scan(project.path);
		void appLogger.debug("session", "Kimi sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await kimiSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Kimi sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	// ── Kimi Work（kimi-desktop 桌面版）会话导入 ─────────────────────────────
	// 与 CLI 版（上方）的差异：数据目录不固定——先 describe 探测（settings 手动指定 >
	// daimon-storage.json 记录的自定义位置 > 默认安装位置），弹窗把探测结果展示给用户。
	// scan/import 全部走探测链，用户改 Kimi Work 数据位置后 PiDeck 无需改设置。
	ipcMain.handle(ipcChannels.kimiWorkSessionsDescribe, async () => {
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.describeShareRoot(customRoot);
		void appLogger.debug("session", "Kimi Work share root described", { origin: result.origin });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.scan(project.path, customRoot);
		void appLogger.debug("session", "Kimi Work sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.import(project.path, sourcePaths, customRoot);
		void appLogger.info("session", "Kimi Work sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── MinimaxCode（CLI）会话导入 ─────────────────────────────────────
	// 数据目录固定 ~/.minimax/v2/sessions（无 describe/探测链）；cwd 取自每个会话
	// 目录 llm-call.json 的 systemPrompt（working directory 行），与项目路径匹配才列出。
	ipcMain.handle(ipcChannels.minimaxSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await minimaxSessionImporter.scan(project.path);
		void appLogger.debug("session", "MinimaxCode sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.minimaxSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await minimaxSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "MinimaxCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── 外置目录会话导入（项目目录移动/改名后找回历史）──────────────────────
	// 与其它导入源的区别：源目录由用户现选，且不复制文件——只把 catalog 记录的项目归属
	// 改成当前项目（原文件原地不动），所以导入后要广播 catalog 刷新让侧栏立即出现这批历史。
	// 「现有会话目录」列表（弹窗首屏默认内容）：只列真的有会话的分组目录，选中即必有结果。
	ipcMain.handle(ipcChannels.directorySessionsListSources, async () => {
		const sources = await directorySessionImporter.listSourceDirectories();
		void appLogger.debug("session", "Directory session sources listed", { count: sources.length });
		return sources;
	});
	ipcMain.handle(ipcChannels.directorySessionsScan, async (_event, projectId: string, dir: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const result = await directorySessionImporter.scan(requireImportDirectory(dir));
		void appLogger.debug("session", "Directory sessions scanned", {
			projectId,
			count: result.sessions.length,
			// kind=ancestor 说明用户选到了会话树的祖先目录（~/.pi 等），弹窗会提示改选。
			kind: result.kind,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.directorySessionsImport, async (_event, projectId: string, dir: unknown, sourcePaths: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const report = await directorySessionImporter.import(projectId, requireImportDirectory(dir), requireImportSourcePaths(sourcePaths));
		void appLogger.info("session", "Directory sessions imported", {
			projectId,
			imported: report.imported,
			failed: report.failed,
		});
		if (report.imported > 0) {
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
			}
		}
		return report;
	});
}

/** 目录导入的目录入参校验（渲染层数据不可信）：非空、绝对路径、长度上限。 */
function requireImportDirectory(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("Invalid directory path");
	const dir = raw.trim();
	if (!dir || dir.length > 32_768) throw new Error("Invalid directory path");
	// 兼容 Windows 盘符路径与 WSL/Linux 绝对路径；相对路径一律拒绝。
	if (!isAbsolute(dir) && !/^[A-Za-z]:[\\/]/.test(dir)) throw new Error("Invalid directory path");
	return dir;
}

/** 目录导入的选中路径校验：字符串数组 + 条数上限（单次扫描上限内）。 */
function requireImportSourcePaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) throw new Error("Invalid source paths");
	if (raw.length > DIRECTORY_IMPORT_MAX_SUMMARIES * 2) throw new Error("Too many source paths");
	return raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}
