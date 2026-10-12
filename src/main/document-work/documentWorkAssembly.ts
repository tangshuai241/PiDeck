/**
 * TPA 独立文稿域装配。
 *
 * 把领域模块和现有运行时拼起来，并把依赖收窄成接口——`main/index.ts` 只留几行装配，
 * 领域逻辑不出现在启动文件里（仓库的模块内聚规则）。
 *
 * 边界声明：
 * - Pi 仍唯一负责模型、工具和原生会话；这里只经 `SessionRuntimeCoordinator` 既有的
 *   `send`/`abortRuntime` 与 `AgentManager` 既有的事件订阅工作，不新增第二条通道；
 * - 主进程不写运行中的 Pi JSONL：补登记与授权核对走 `SessionHistoryReader` 的只读解析；
 * - **原生身份**：绑定载荷同时带稳定会话 id 与原生 Pi 会话 id（`tab.sessionId`），
 *   扩展只核对后者，主进程两者都核；
 * - 目录选择走 Electron 原生对话框，路径只在主进程内使用。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeState, AgentTab, SessionRuntimeTarget, SendSessionPromptResult } from "../../shared/types";
import type { DocumentArtifactCandidateReport, DocumentWorkBindingState, DocumentWorkChangedEvent, DocumentWorkRevisionIntent } from "../../shared/types/documentWork";
import type { AlignmentState } from "../../shared/types/alignment";
import { registerDocumentWorkIpc } from "../ipc/documentWorkIpc";
import { DocumentArchiveService } from "./DocumentArchiveService";
import { DocumentInspectionService } from "./DocumentInspectionService";
import { type DocumentPathFsPort } from "./DocumentPathGuard";
import { DocumentWorkRuntimeAdapter, type DocumentWorkAlignmentSnapshot, type DocumentWorkRuntimePort } from "./DocumentWorkRuntimeAdapter";
import { DocumentWorkRuntimeLease } from "./DocumentWorkRuntimeLease";
import { DocumentWorkService } from "./DocumentWorkService";
import { DocumentWorkStore } from "./DocumentWorkStore";

/** 只读文件系统端口：文稿域需要的能力集合，测试用假实现替换。 */
export const nodeDocumentPathFs: DocumentPathFsPort = {
	realpath: (path) => realpathSync.native(path),
	stat: (path) => {
		try {
			const stat = statSync(path);
			return { isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
		} catch {
			return undefined;
		}
	},
	readFile: (path) => {
		try {
			return readFileSync(path);
		} catch {
			return undefined;
		}
	},
	exists: (path) => existsSync(path),
	/** 排他创建：目标已存在返回 false（版本目录不覆盖的 OS 级保证）。 */
	mkdirExclusive: (path) => {
		try {
			mkdirSync(path);
			return true;
		} catch {
			return false;
		}
	},
	mkdirRecursive: (path) => {
		mkdirSync(path, { recursive: true });
	},
	copyFile: (source, destination) => {
		copyFileSync(source, destination);
	},
	remove: (path) => {
		rmSync(path, { force: true, recursive: true });
	},
	writeFile: (path, data) => {
		writeFileSync(path, data);
	},
	listDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
};

export type DocumentWorkAppHost = {
	/** 一轮用户消息的权威快照（角色/当前正文/指纹/是否最后一条用户消息）。 */
	readUserTurnSnapshot(agentId: string, entryId: string): Promise<{ entryId: string; role: string; text: string; textDigest: string; isLatestUserTurn: boolean } | undefined>;
	/** 原生 Pi 会话身份与项目目录。 */
	readAgentRuntimeIdentity(agentId: string): { piSessionId?: string; sessionPath?: string; cwd?: string } | undefined;
	/** 活动分支上的文稿绑定、候选汇报与改稿意向（补登记）。 */
	readDocumentWorkHistory(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[]; intents: DocumentWorkRevisionIntent[] }>;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void;
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void;
	list(): AgentTab[];
};

export type DocumentWorkCoordinatorHost = {
	getTarget(sessionId: string): SessionRuntimeTarget | undefined;
	getRuntimeBinding(agentId: string): { sessionId: string; runtimeGeneration: number } | undefined;
	send(input: { sessionId: string; requestId: string; message: string; expectedRuntime: SessionRuntimeTarget }): Promise<SendSessionPromptResult>;
	abortRuntime(target: SessionRuntimeTarget): Promise<{ ok: boolean; error?: { code: string } }>;
};

export type DocumentWorkAssemblyDeps = {
	userDataDir: string;
	host: DocumentWorkAppHost;
	coordinator: DocumentWorkCoordinatorHost;
	chooseDirectory: (title: string) => Promise<string | undefined>;
	broadcast: (event: DocumentWorkChangedEvent) => void;
	/** 检查 worker 与 core 所在目录的候选（打包态 resources/document-work / 开发态仓库同目录）。 */
	inspectionPaths?: readonly string[];
};

export type DocumentWorkAssembly = {
	service: DocumentWorkService;
	store: DocumentWorkStore;
	adapter: DocumentWorkRuntimeAdapter;
	inspection: DocumentInspectionService;
	/** 退出/重启时的配对清理：退订事件、终止 worker、等待在途编排收口。 */
	dispose: () => Promise<void>;
};

function toAlignmentSnapshot(alignment: AlignmentState | null | undefined): DocumentWorkAlignmentSnapshot | undefined {
	if (!alignment) return undefined;
	return {
		briefId: alignment.briefId,
		revision: alignment.revision,
		phase: alignment.phase,
		hasOpenQuestions: (alignment.brief?.questions.length ?? 0) > 0,
		...(alignment.brief ? { brief: alignment.brief } : {}),
	};
}

/** 依次尝试候选目录：worker 与 core 必须**成对**存在，否则视为不可用（记 unverified）。 */
export function resolveInspectionWorkerPaths(dirs: readonly string[]): { workerPath: string; corePath: string } | undefined {
	for (const dir of dirs) {
		const workerPath = join(dir, "documentInspectionWorker.cjs");
		const corePath = join(dir, "documentInspectionCore.cjs");
		if (existsSync(workerPath) && existsSync(corePath)) return { workerPath, corePath };
	}
	return undefined;
}

export function createDocumentWork(deps: DocumentWorkAssemblyDeps): DocumentWorkAssembly {
	const workRoot = join(deps.userDataDir, "document-work");
	const store = new DocumentWorkStore({ dir: workRoot });
	const inspection = new DocumentInspectionService({
		read: (path, maxBytes) => {
			const stat = nodeDocumentPathFs.stat(path);
			if (!stat || !stat.isFile() || stat.size > maxBytes) return undefined;
			return nodeDocumentPathFs.readFile(path);
		},
		resolveWorkerPaths: () => resolveInspectionWorkerPaths(deps.inspectionPaths ?? []),
	});

	const runtime: DocumentWorkRuntimePort = {
		async resolveRuntime(sessionId) {
			const target = deps.coordinator.getTarget(sessionId);
			if (!target) return undefined;
			const identity = deps.host.readAgentRuntimeIdentity(target.agentId);
			if (!identity) return undefined;
			return {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				...(identity.piSessionId ? { piSessionId: identity.piSessionId } : {}),
				...(identity.cwd ? { projectRoot: identity.cwd } : {}),
			};
		},
		readRuntimeBinding(agentId) {
			return deps.coordinator.getRuntimeBinding(agentId);
		},
		async readAlignment(target) {
			try {
				const state = await deps.host.getRuntimeState(target.agentId);
				return toAlignmentSnapshot(state.alignment);
			} catch {
				return undefined;
			}
		},
		async readUserTurn(input) {
			const target = deps.coordinator.getTarget(input.sessionId);
			if (!target) return undefined;
			try {
				const snapshot = await deps.host.readUserTurnSnapshot(target.agentId, input.turnId);
				if (!snapshot) return undefined;
				const role = snapshot.role === "user" || snapshot.role === "assistant" || snapshot.role === "system" || snapshot.role === "tool" ? snapshot.role : "other";
				return { entryId: snapshot.entryId, role, text: snapshot.text, textDigest: snapshot.textDigest, isLatestUserTurn: snapshot.isLatestUserTurn };
			} catch {
				return undefined;
			}
		},
		async runtimeFlags(target) {
			try {
				const state = await deps.host.getRuntimeState(target.agentId);
				// pi 的客户端排队对主进程不可见：忙碌判据用运行时字段（turn 活动/压缩），
				// 排队只在后端显式上报（DSH queuedMessages）时计入；pi 的排队由扩展侧
				// ctx.hasPendingMessages() 在批准时再挡一道。
				const busy = state.isTurnActive === true || state.isCompacting === true;
				const queued = Array.isArray(state.queuedMessages) && state.queuedMessages.length > 0;
				return { busy, queued };
			} catch {
				// 读不到状态时按忙碌处理：宁可不分发，也不把一个回合叠到另一个回合上。
				return { busy: true, queued: false };
			}
		},
		async sendControl(input) {
			const result = await deps.coordinator.send({ sessionId: input.sessionId, requestId: input.requestId, message: input.message, expectedRuntime: input.expectedRuntime });
			return result.accepted ? { accepted: true } : { accepted: false, ...(result.error ? { error: result.error } : {}) };
		},
		async abort(target) {
			await deps.coordinator.abortRuntime(target);
		},
		async readHistory(agentId) {
			return await deps.host.readDocumentWorkHistory(agentId);
		},
	};

	const adapter = new DocumentWorkRuntimeAdapter({ ports: runtime, events: deps.host });
	// 同一运行时上只允许一件文稿工作：租约覆盖占用 → 绑定 → 运行 → 结算。
	const lease = new DocumentWorkRuntimeLease();
	const archive = new DocumentArchiveService({ store, pathFs: nodeDocumentPathFs, workRoot, inspection });
	const service = new DocumentWorkService({
		store,
		runtime,
		adapter,
		archive,
		pathFs: nodeDocumentPathFs,
		workRoot,
		emit: deps.broadcast,
		readBaseHeadings: (absolutePath) => inspection.listHeadings(absolutePath),
		lease,
	});
	adapter.start();
	// 普通聊天的改稿意向只作**候选**：主进程在这里重新验证、等稳定点、再决定是否派发。
	adapter.subscribe((event) => {
		if (event.kind !== "intent" || event.stale) return;
		void service.handleRevisionIntent({ target: event.target, intent: event.intent }).catch(() => undefined);
	});

	registerDocumentWorkIpc({ service, store, chooseDirectory: deps.chooseDirectory, broadcast: deps.broadcast });

	return {
		service,
		store,
		adapter,
		inspection,
		dispose: async () => {
			adapter.dispose();
			await inspection.shutdown();
			await service.shutdown();
			lease.releaseAll();
		},
	};
}
