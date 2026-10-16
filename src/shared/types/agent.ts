import type { ThinkingLevelMap } from "./modelSpecs";
import type { SessionEnvironment, SessionSource } from "./session";
import type { TodoItem } from "./todo";
import type { AlignmentState } from "./alignment";

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

/**
 * 运行时后端：pi（stdio JSON-RPC）、
 * imagegen（生图，无 LLM agent、无 pi 会话文件，历史独立存 ImageSessionStore）
 * 或 videogen（生视频，同为直连供应商 API 的无 agent 后端，历史独立存 VideoSessionStore）。
 * 与 `SessionSource`（历史导入来源）是两个维度：source 描述会话文件从哪来，
 * backend 描述会话由哪个引擎驱动。缺省视为 "pi"，旧数据天然兼容。
 * 生图/生视频是后端维度的独立类型（不等价于 pi 的一种模式），互不影响。
 */
/** Persisted backend tags include retired DSH/ACP records; active choices are validated separately. */
export type AgentBackend = "pi" | "dsh" | "imagegen" | "videogen" | "acp";

/**
 * 后端可选能力（核心接口方法之外的可选扩展）。
 * 能力缺失的后端必须显式声明不持有，UI 按能力禁用入口，禁止硬造等价物。
 */
export type AgentGatewayCapability =
	| "compact" // 手动压缩
	| "fork" // 从消息 fork 新会话
	| "getForkMessages" // fork 前置的消息列表
	| "editMessage" // 编辑历史消息
	| "deleteMessage" // 删除历史消息
	| "getCommands" // 会话内命令列表
	| "exportHtml" // 导出 HTML
	| "rewind"; // checkpoint 文件快照/回退（refs/pi-checkpoints，纯 git）

export type AgentTab = {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	status: AgentStatus;
	sessionId?: string;
	/** PiDeck 会话身份（与 CreateAgentInput.deckSessionId 同源），用于安全门 PIDECK_SESSION_ID 注入。 */
	deckSessionId?: string;
	sessionPath?: string;
	/** Identity used only for session/runtime matching; agentId remains the process handle. */
	sessionEnvironment?: SessionEnvironment;
	sessionSource?: SessionSource;
	/** 运行时后端；缺省 "pi"（旧数据/旧路径兼容）。 */
	backend?: AgentBackend;
	/** DSH agent 预设（会话「模式」）：新建/attach 时从 host 解析，回写 catalog 供头部只读展示。 */
	agentPreset?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
	/** standby 池化进程：已握手完成但尚未绑定任何会话（预热 spawn，UI 不可见）。
	 *  被 claim 后清回 undefined；仅主进程内部使用，渲染层不应看到 standby=true 的 tab。 */
	standby?: boolean;
	/** Monotonic binding generation assigned by SessionRuntimeCoordinator. */
	runtimeGeneration?: number;
	createdAt: number;
	/** 会话累计压缩次数，由主进程解析会话文件得到，用于前端展示“已压缩 N 次”。 */
	compactionCount?: number;
};

export type AgentRuntimeState = {
	/** Native pi alignment snapshot; null explicitly clears an older runtime patch. */
	alignment?: AlignmentState | null;
	modelName?: string;
	provider?: string;
	modelId?: string;
	/** DSH sessions.models().routable；undefined 表示尚未确认，不能据此阻塞输入。 */
	modelRoutable?: boolean;
	thinkingLevel?: string;
	/** DSH 会话当前权限预设（read-only / workspace-write / danger-full-access / custom）；
	 *  pi 后端无此概念。 */
	permissionPreset?: string;
	/** DSH 会话 plan 模式是否生效（/plan 命令，可能延迟到下一条消息的步骤生效）。 */
	planModeActive?: boolean;
	/** DSH 当前目标（goal/change 事件投影；无目标时为 undefined）。 */
	goal?: {
		refId: string;
		revision: number;
		objective: string;
		phase: "active" | "paused" | "blocked" | "complete";
		maxGoalRounds: number;
		roundsStarted: number;
	};
	/**
	 * 待办计划（旧 DSH 投影字段，兼容既有运行时快照）；pi 走 widget 行快照，
	 * 渲染层按数据源分别消费。
	 */
	todos?: TodoItem[] | null;
	isStreaming?: boolean;
	/**
	 * pi 的逻辑模型回合状态（agent_start → true，agent_end → false）。
	 * false 表示本轮回答已结束；runtime 仍可能因为上下文压缩、自动重试收尾或
	 * 队列检查保持 busy。undefined 兼容不提供该边界的旧快照。
	 */
	isTurnActive?: boolean;
	isCompacting?: boolean;
	/** 是否正在执行工具调用（read/write/bash 等） */
	isExecutingTool?: boolean;
	/** 当前正在执行的工具名称，如 read、write、bash */
	executingToolName?: string;
	/** 工具状态事件的单调序号，用于忽略晚到的异步完整状态。 */
	toolStateSequence?: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	/** 最近一次请求因上下文窗口超限而失败；即使当前占用快照缺失也要保留这个恢复入口。 */
	contextOverflow?: boolean;
	/** 对话段 token：优先「总占用 − 系统 − 工具」差值（提供商上报的 prompt 即三段之和），
	 *  差值不可用时为会话文件里的消息文本估算。UI 用它展示「对话 vs 系统/工具」占比。 */
	contextMessageTokens?: number;
	/** 系统提示词 token 估算（pi：会话文件里重放出的提示词 sections。
	 *  缺失 = 无测量值；0 表示确实为 0）。 */
	contextSystemTokens?: number;
	/** 工具定义/schema token 估算（pi：会话文件里重放出的工具声明。
	 *  缺失 = 无测量值；0 表示确实为 0）。 */
	contextToolsTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
	cacheHitPercent?: number | null;
	/** 当前会话平均缓存命中率：会话文件全部 assistant 消息 usage 的算术平均 */
	cacheHitAveragePercent?: number | null;
	/** 参与平均统计的 assistant 消息条数（与 cacheHitAveragePercent 同源） */
	cacheHitSampleCount?: number;
	cost?: number;
	/** 最近一次 assistant 回复的正文首字延迟（ms；请求起点 → 首个 text delta，无正文时用 thinking） */
	ttftMs?: number;
	/** 最近一次 assistant 回复的总耗时（ms；请求起点 → message_end/done/error，不含前序工具执行） */
	totalMs?: number;
	/** 最近一次 assistant 回复的流式速度（tokens/s；output tokens ÷ 首个有效 thinking/text delta 到回复结束的耗时）。 */
	tps?: number;
	/** 最近一次 assistant 回复的端到端速度（tokens/s；同一回复的 output tokens ÷ totalMs）。 */
	endToEndTps?: number;
	/** 性能指标结算时刻（Date.now()），渲染层据此判断是否为近期数据 */
	perfAt?: number;
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	/** 上下文窗口（token 数，来自 pi --list-models context 列） */
	contextWindow?: number;
	/** 单次输出上限（token 数，来自 max-out 列） */
	maxTokens?: number;
	reasoning?: boolean;
	/** Pi 已解析的完整输入模态；缺失表示旧 CLI/后端未报告。 */
	input?: Array<"text" | "image">;
	/** 是否支持图片输入（来自 images 列；undefined = pi 未提供该列） */
	images?: boolean;
	/** Pi capability hydration 已确认的可用思考档位。
	 * undefined 表示旧 Pi / capability probe 未就绪或失败，不能当作精确能力；
	 * 空数组则是 Pi 返回的权威空结果，必须原样保留。 */
	thinkingLevels?: string[];
	/** Pi capability hydration 返回的模型特有思考映射；保留给配置补全，不能由静态级别表推断。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 该模型支持的思考档位（DSH models catalog 的 reasoning.efforts；
	 *  选择器按它过滤档位——DSH deepseek 适配器只接受 off/high/max，
	 *  pi-ai provider 按模型声明，选不支持的档位会在下次请求抛 UNSUPPORTED_REASONING_EFFORT）。 */
	reasoningEfforts?: Array<{ id: string; name?: string; description?: string }>;
	/** DSH 模型自己的默认思考档位（reasoning.defaultEffort）；settings.yaml 未配
	 *  agent-default-model.reasoningEffort 时，底栏/选择器应回退到这个值。 */
	defaultEffort?: string;
};

/** 模型列表加载失败的成因分类：供模型选择器给出差异化引导（版本过低/配置损坏/pi 未安装）。 */
export type ModelListFailReason =
	| "pi-not-found"
	| "version-too-old"
	| "config-invalid"
	| "cli-failed"
	/**
	 * 端点可连通但返回了 WAF / 人机验证页（HTTP 200 但正文是 HTML 挑战页，或非 JSON）。
	 * 与 config-invalid 的区别：配置本身没问题，是网关按 UA / 出口 IP 拦截了请求。
	 * 可操作动作是换代理或配 UA，而不是改配置——混在一起会把用户引向错误方向。
	 */
	| "waf-blocked"
	| "empty";

/** 模型列表加载报告（projects:list-models-report）：模型数组 + 为空时的失败原因与详情。
 *  旧通道 projects:list-models 只返回数组（失败即空），选择器无法解释"为什么没模型"；
 *  本报告让渲染层能针对不同成因给出可操作的引导（升级 pi / 修配置 / 配置 pi 路径）。 */
export type ModelListReport = {
	models: AvailableModel[];
	/** 列表非空（含配置兜底成功）时为 true */
	ok: boolean;
	reason: ModelListFailReason | null;
	/** pi 版本（--version 结果）；未知时为 null */
	version: string | null;
	/** 失败详情（CLI stderr / 配置解析错误），已截断，可直接展示 */
	detail: string;
	/** 数据来源：cache / cli / config-fallback / none */
	source: "cache" | "cli" | "config-fallback" | "none";
	/** 报告生成时刻 */
	at: number;
};

/** 保存 models 后的后台 pi 验证结果（config:models-verify-result）。
 *  保存 handler 为即时反馈（解析刚写入的 models.json，不 fork），fork 真实 pi 的完整
 *  验证在后台完成后经本事件推送；渲染层仅失败时提示，成功静默（避免每次保存都弹）。 */
export type ModelsVerifyResult = {
	/** pi 成功加载出非空模型列表（config-fallback 兜底不算「已加载」） */
	ok: boolean;
	modelCount: number;
	reason: ModelListFailReason | "config-fallback" | null;
	/** 失败详情（CLI stderr / 配置诊断），已截断，可直接展示 */
	detail: string;
	/** 触发验证的保存时刻（主进程时间戳）；渲染层可据此忽略过期结果 */
	savedAt: number;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
	/** 运行时后端；缺省走当前装配的默认后端（pi），旧调用方无需改动。 */
	backend?: AgentBackend;
	/** 旧 DSH 会话身份（兼容读取；DSH 运行能力已移除，不再写入/使用）。 */
	dshSessionId?: string;
	/** 会话「模式」预设（旧 DSH/ACP 兼容读取；均已移除运行能力）。 */
	agentPreset?: string;
	/**
	 * ACP 会话身份（agent 侧 sessionId）：backend=acp 且已持久化时，attach 旧会话
	 * （session/load 恢复，agent 重放历史）而非新建。
	 */
	acpSessionId?: string;
	/**
	 * PiDeck 会话身份（SessionRecord.id，可能为 UUID 或会话文件路径）。
	 * 会话级安全覆盖（SecurityStore.sessionOverrides）与 PIDECK_SESSION_ID 注入都使用这个 key；
	 * 与 pi 进程自身的 sessionId（AgentTab.sessionId / piSessionId）语义不同，不可混用。
	 */
	deckSessionId?: string;
	/** standby 池预热 spawn：不绑定会话、不注入 PIDECK_SESSION_ID，创建后由 StandbyAgentPool 托管（仅 AgentManager 内部使用）。 */
	standby?: boolean;
	environment?: SessionEnvironment;
	source?: SessionSource;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
};

export type AgentUiResponse = {
	/** 普通回答为 string/boolean；multi_select 多选为 string[] */
	value?: string | boolean | string[];
	cancelled?: boolean;
	confirmed?: boolean;
};

export type AgentUiBatchQuestion = {
	id: string;
	type: "select" | "multi_select" | "confirm" | "input" | "editor";
	question: string;
	options?: Array<string | { label: string; value?: string; description?: string }>;
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
};

export type AgentUiRequest = {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	completed?: boolean;
	value?: string | boolean;
	confirmed?: boolean;
	cancelled?: boolean;
	message?: string;
	notifyType?: "info" | "warning" | "error";
	text?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	/** A batched ask_question envelope rendered as tabs in the session timeline footer. */
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};

/** 实时思考内容更新，用于流式展示模型推理过程。
 *  id 与 History 的 thinking-group id 相同（msg-thinking-${assistantMessageId}），
 *  保证 Live→History 不 remount。 */
export type ThinkingUpdate = {
	agentId: string;
	/** 稳定段 id：与 buildTurnDisplay 的 msg-thinking-* 一致 */
	id: string;
	/** 累积的思考文本（全量快照；流式增量推送时缺省，见 delta） */
	text?: string;
	/** 自上次推送以来的增量（2026-08 治理：避免每 50ms 全量重推长思考文本，
	 *  主/渲染两侧分配器被瞬时 IPC 流量抬到 GB 级 RSS）。渲染层按 id 累积。 */
	delta?: string;
	startedAt: number;
	/** 0 表示仍在流式思考中 */
	endedAt: number;
	/** true：本段结束，渲染层可清 live 通道并回退到 History */
	done: boolean;
};

/** 输入框发送模式：普通执行 / 只读计划 / 生图 / 目标自动推进。 */
export type ComposerAgentMode = "normal" | "plan" | "imagegen" | "videogen" | "goal" | "alignment";
