/**
 * TPA 独立文稿域装配。
 *
 * 把领域模块和现有运行时拼起来，并把依赖收窄成接口——`main/index.ts` 只留几行装配，
 * 领域逻辑不出现在启动文件里（仓库的模块内聚规则）。
 *
 * 边界声明：
 * - Pi 仍唯一负责模型、工具和原生会话；这里只经 `SessionRuntimeCoordinator` 既有的
 *   `send`/`abortRuntime` 与 `AgentManager` 既有的事件订阅工作，不新增第二条通道；
 * - 主进程不写运行中的 Pi JSONL：补登记走 `SessionHistoryReader` 的只读解析；
 * - 目录选择走 Electron 原生对话框，路径只在主进程内使用。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeState, SessionRuntimeTarget, SendSessionPromptResult } from "../../shared/types";
import type { DocumentArtifactCandidateReport, DocumentWorkBindingState, DocumentWorkChangedEvent } from "../../shared/types/documentWork";
import type { AlignmentState } from "../../shared/types/alignment";
import { registerDocumentWorkIpc } from "../ipc/documentWorkIpc";
import { DocumentArchiveService } from "./DocumentArchiveService";
import { DocumentInspectionService } from "./DocumentInspectionService";
import { type DocumentPathFsPort } from "./DocumentPathGuard";
import { DocumentWorkRuntimeAdapter, type DocumentWorkAlignmentSnapshot, type DocumentWorkRuntimePort } from "./DocumentWorkRuntimeAdapter";
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
	/** 读取某一轮用户消息的原文（授权核对）。 */
	readMessageFullText(agentId: string, messageId: string): Promise<{ text: string }>;
	/** 活动分支上的文稿绑定与候选汇报（补登记）。 */
	readDocumentWorkHistory(agentId: string): Promise<{ bindings: DocumentWorkBindingState[]; reports: DocumentArtifactCandidateReport[] }>;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void;
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void;
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
};

export type DocumentWorkAssembly = {
	service: DocumentWorkService;
	store: DocumentWorkStore;
	adapter: DocumentWorkRuntimeAdapter;
	/** 退出/重启时的配对清理：退订事件、等待在途编排收口。 */
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

export function createDocumentWork(deps: DocumentWorkAssemblyDeps): DocumentWorkAssembly {
	const workRoot = join(deps.userDataDir, "document-work");
	const store = new DocumentWorkStore({ dir: workRoot });
	const inspection = new DocumentInspectionService({
		read: (path, maxBytes) => {
			const stat = nodeDocumentPathFs.stat(path);
			if (!stat || !stat.isFile() || stat.size > maxBytes) return undefined;
			return nodeDocumentPathFs.readFile(path);
		},
	});

	const runtime: DocumentWorkRuntimePort = {
		async resolveRuntime(sessionId) {
			const target = deps.coordinator.getTarget(sessionId);
			return target ? { sessionId: target.sessionId, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration } : undefined;
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
		async readUserTurnText(sessionId, turnId) {
			const target = deps.coordinator.getTarget(sessionId);
			if (!target) return undefined;
			try {
				const result = await deps.host.readMessageFullText(target.agentId, turnId);
				return typeof result.text === "string" ? result.text : undefined;
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
	const archive = new DocumentArchiveService({ store, pathFs: nodeDocumentPathFs, workRoot, inspection });
	const service = new DocumentWorkService({ store, runtime, adapter, archive, pathFs: nodeDocumentPathFs, workRoot, emit: deps.broadcast });
	adapter.start();

	registerDocumentWorkIpc({ service, store, chooseDirectory: deps.chooseDirectory, broadcast: deps.broadcast });

	return {
		service,
		store,
		adapter,
		dispose: async () => {
			adapter.dispose();
			await service.shutdown();
		},
	};
}
