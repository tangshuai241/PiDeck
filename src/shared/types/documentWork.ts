/**
 * TPA 独立文稿：共享契约。
 *
 * 三个进程（main / preload / renderer）和 Pi 扩展都从本文件取类型与预算，
 * 禁止各自复制一份。这里只放类型、常量与预算数字；解析、校验和规范化在
 * `src/shared/documentWork.ts` 与扩展侧的 `pi-deck-document-work-*.ts`。
 *
 * 归属边界：本文件描述的记录由主进程持久化（`userData/document-work/`），
 * Pi 原生会话仍是对话事实源。文稿正文、图片和 base64 一律不进记录。
 */

/** 记录 schema 版本；跨版本必须迁移或有默认值兜底，不得伪造缺失字段。 */
export const DOCUMENT_WORK_SCHEMA_VERSION = 1;

/** Pi 扩展发布隐藏状态的 customType（与对齐状态同级，不占可见历史序号）。 */
export const DOCUMENT_WORK_STATE_TYPE = "tpa-document-work-state";
/**
 * 改稿意向的隐藏 customType：普通聊天里扩展只能报「候选」，授权与派发由主进程决定。
 * 与状态分开是为了让「候选」永远不可能被当成「已授权」。
 */
export const DOCUMENT_WORK_INTENT_TYPE = "tpa-document-work-intent";
/** Pi 扩展写入活动分支的私有快照 entry 类型（历史恢复补登记用）。 */
export const DOCUMENT_WORK_SNAPSHOT_TYPE = "tpa-document-work-snapshot";
/** 主进程经既有发送接口调用的注册命令名；只绑定上下文，不触发模型回合。 */
export const DOCUMENT_WORK_COMMAND = "tpa-work";
/** 材料读取工具名（对齐扩展的只读白名单必须与之一致）。 */
export const DOCUMENT_WORK_MATERIAL_TOOL = "tpa_read_material";
/** 成果候选汇报工具名。汇报只是候选，不批准、不结算。 */
export const DOCUMENT_WORK_REPORT_TOOL = "tpa_artifact_report";
/** 转换器版本进缓存键：任何 anydoc 参数/协议变化都必须 bump，否则复用旧缓存。 */
export const DOCUMENT_WORK_CONVERTER_VERSION = "anydoc-v1";

/** 首版预算（不是已测结果，见方案 §7）。超预算只降低检查覆盖，不放宽正确性结论。 */
export const DOCUMENT_WORK_BUDGETS = {
	/** `/tpa-work bind` 载荷解码后上限（字节）。 */
	bindPayloadBytes: 64 * 1024,
	/** `tpa_artifact_report` 汇报上限（字节）。 */
	reportBytes: 64 * 1024,
	/** 单轮汇报文件数上限。 */
	reportFiles: 32,
	/** 单个相对路径长度上限。 */
	reportPathLength: 1024,
	/** 单件成果文件上限；超预算只保存存在证据并记未验证。 */
	artifactBytes: 32 * 1024 * 1024,
	/** OOXML 解包总量上限。 */
	ooxmlTotalBytes: 64 * 1024 * 1024,
	/** 单个 XML 部件上限。 */
	ooxmlPartBytes: 8 * 1024 * 1024,
	/** 部件数上限。 */
	ooxmlParts: 10000,
	/** 结构检查时限（毫秒）；超时终止检查并记未验证。 */
	inspectionMs: 2_000,
	/** 材料转换时限（毫秒）；扫描 OCR 不计入快速检查目标。 */
	conversionMs: 120_000,
	/** 单个材料源文件大小上限（超过则拒绝转换而不是截断）。 */
	materialBytes: 64 * 1024 * 1024,
	/** 后台检查与转换并发上限（各 2）。 */
	concurrentInspections: 2,
	concurrentConversions: 2,
	/** 等待 Pi 绑定确认的时限（毫秒）。 */
	bindAckMs: 20_000,
	/** 等待运行时稳定的时限（毫秒）。 */
	settleMs: 15 * 60_000,
	/** 冻结进准备记录的用户指令正文上限（字符）；超出即要求澄清。 */
	instructionChars: 4000,
	/** 检查 worker 超时后的强杀等待（毫秒）。 */
	workerTerminateMs: 1_000,
} as const;

/** 工作记录版本冲突时的当前版本；调用者必须用该版本重试。 */
export type WorkMutation = {
	requestId: string;
	workId: string;
	expectedRevision: number;
};

/** 准备记录引用：`preparationId` 标识不可变内容，`digest` 是内容指纹。 */
export type PreparationReference = {
	preparationId: string;
	digest: string;
};

/** 要求来源：对齐确认单，或本轮明确用户指令。 */
export type RequirementsReference = { kind: "alignment"; briefId: string; revision: number } | { kind: "user_instruction"; sourceTurnId: string };

/** 授权来源：只认对齐确认与本次明确改稿指令；模型文本和布尔字段不授予授权。 */
export type AuthorizationReference = { kind: "alignment_confirmation"; briefId: string; revision: number } | { kind: "revision_instruction"; sourceTurnId: string };

/** 准备完成后的返回值；`workRevision` 是保存后的版本，调用者必须用它提交下一次修改。 */
export type PreparedWork = {
	workId: string;
	workRevision: number;
	preparation: PreparationReference;
	summary: string;
};

export type WorkErrorCode =
	| "INVALID_INPUT"
	| "WORK_NOT_FOUND"
	| "REVISION_CONFLICT"
	| "IDEMPOTENCY_CONFLICT"
	| "RUNTIME_CHANGED"
	| "RUNTIME_BUSY"
	| "PREPARATION_STALE"
	| "APPROVAL_REQUIRED"
	| "BASE_AMBIGUOUS"
	| "BASE_CHANGED"
	| "PATH_DENIED"
	| "EXTENSION_UNAVAILABLE"
	| "DISPATCH_UNKNOWN"
	| "INSPECTION_UNVERIFIED"
	| "IO_ERROR";

export type WorkError = {
	code: WorkErrorCode;
	retryable: boolean;
	currentRevision?: number;
	/** 面向开发者的短说明；文案由 Renderer 经 i18n 映射，不回传隐私正文。 */
	detail?: string;
};

export type WorkResult<T> = { ok: true; value: T } | { ok: false; error: WorkError };

export type DocumentWorkKind = "create_document" | "revise_document";

/** 修改范围：显式允许修改块与保留块，用于正文比较的授权判定。 */
export type DocumentChangeScope = {
	/** 允许修改的章节/段落定位（空数组表示整篇允许，仅当指令明确要求整篇修改）。 */
	allow: string[];
	/** 必须逐字保留的定位。 */
	preserve: string[];
	/** 指令明确要求整篇重写时为真；false 时未在 allow 内的正文变化算未授权。 */
	wholeDocument: boolean;
};

/** 基稿选择结果：冻结副本身份，不是"目录里最新的文件"。 */
export type DocumentBaseSelection = {
	versionId: string;
	artifactId: string;
	relativePath: string;
	sha256: string;
	bytes: number;
	/** 用户显式指定历史版本。 */
	explicit: boolean;
	/** 归档后原文件被外部改动，本轮以新的手工修改版接续。 */
	handEdited: boolean;
};

export type DocumentPreparationInput = {
	kind: DocumentWorkKind;
	requirementsRef: RequirementsReference;
	/** 改稿指令来源轮次（`revise_document` 必填）。 */
	feedbackSourceTurnId?: string;
	baseVersionId?: string;
};

/** 准备记录：内容不可变；要求、材料、基稿、范围、输出位置任一变化即产生新准备。 */
export type DocumentWorkPreparation = {
	schemaVersion: 1;
	preparationId: string;
	kind: DocumentWorkKind;
	workRevision: number;
	requirementsRef: RequirementsReference;
	authorization: AuthorizationReference;
	materials: DocumentMaterialReference[];
	/** 本轮允许读取材料的根；扩展只能在这些根内按 relativePath 解析。 */
	materialRoots: DocumentMaterialRoot[];
	base?: DocumentBaseSelection;
	scope: DocumentChangeScope;
	/**
	 * 改稿轮冻结的用户指令：主进程从会话里那一轮真实用户消息读回并锁定正文，
	 * 派发时只使用这份冻结文本；不进入 Pi 汇报，也不重复进模型上下文。
	 */
	instruction?: { sourceTurnId: string; text: string; textDigest: string };
	/** 本轮 staging 相对路径（相对工作目录）；扩展只在该目录内制作。 */
	stagingRelativeDir: string;
	outputRelativeDir: string;
	digest: string;
	createdAt: number;
};

export type DocumentMaterialReference = {
	materialId: string;
	/**
	 * 材料所在的已授权根（成果根或会话项目目录）。
	 * 材料不限于成果目录：用户不必把文件搬进输出目录。
	 */
	rootId: string;
	/** 相对该根的路径（只读）。 */
	relativePath: string;
	sha256: string;
	bytes: number;
	/** 默认 anydoc；非文档材料直接按文本读取。 */
	converter: string;
};

/** 可被材料读取的根：全部来自用户已有的授权入口（成果目录选择 / 项目目录）。 */
export type DocumentMaterialRoot = {
	rootId: string;
	/** 相对标识（项目根固定为 "project"）。 */
	kind: "output_root" | "project_root";
	path: string;
	label: string;
};

export type DocumentInspectionStatus = "passed" | "failed" | "unverified";
export type DocumentInspectionChannel = "fingerprint" | "text" | "format";
export type DocumentInspectionChannelResult = {
	channel: DocumentInspectionChannel;
	status: DocumentInspectionStatus;
	/** 覆盖范围说明（例如 `docx:document.xml` 或 `text:paragraphs=42`）。 */
	coverage: string;
	/** 未授权变化的具体位置（`failed` 时给出），有界且不含正文全文。 */
	changes?: string[];
	reason?: string;
};

/** 三类结果分别记录，不相互替代；`passed` 只说明实际覆盖的内容。 */
export type DocumentInspection = {
	schemaVersion: 1;
	status: DocumentInspectionStatus;
	channels: DocumentInspectionChannelResult[];
	/** 检查器版本；实现变化必须 bump，否则旧结论不能复用。 */
	inspectorVersion: string;
	bytes: number;
	budgetBytes: number;
	elapsedMs: number;
	reason?: string;
};

export type DocumentUserAcceptance = "not_collected" | "accepted" | "rejected";

/** 成果版本：稳定 versionId + 递增显示序号；版本目录创建使用排他语义。 */
export type DocumentArtifactVersion = {
	schemaVersion: 1;
	workId: string;
	versionId: string;
	/** 递增显示序号（v0001 起），与 Pi 要求 revision 不混用。 */
	ordinal: number;
	attemptId: string;
	preparationId: string;
	parentVersionId?: string;
	kind: DocumentWorkKind;
	/** 归档时长这样：`versions/v0001/deliverable.docx`。 */
	relativeDir: string;
	artifacts: DocumentArtifactFile[];
	editableSources: DocumentArtifactFile[];
	/** 归档时的原始字节快照（TPA 管理，正常流程不改）。 */
	snapshots: DocumentArtifactFile[];
	/** 生成方式登记（源稿 → 成果，或从基稿局部修改）。 */
	provenance: DocumentVersionProvenance;
	base?: DocumentBaseSelection;
	inspection: DocumentInspection;
	/** 模型自报摘要，只作说明，不作为检查结论。 */
	modelSummary?: string;
	modelRisks?: string[];
	userAcceptance: DocumentUserAcceptance;
	archivedAt: number;
};

export type DocumentVersionProvenance = { kind: "generated_from_source"; sourceRelativePath: string; generator: string } | { kind: "revised_from_base"; baseVersionId: string; method: "word_local_edit" | "markdown_source" } | { kind: "created"; method: "word_local_edit" | "markdown_source" };

export type DocumentArtifactFile = {
	relativePath: string;
	sha256: string;
	bytes: number;
	/**
	 * 超过单件字节预算（32 MiB）的文件只保存存在证据：不复制字节、不参与正文/格式检查。
	 * 这样的版本检查恒为 `unverified`，不得被自动当作合格基稿。
	 */
	existenceOnly?: boolean;
};

export type DocumentWorkOperationState = "prepared" | "dispatching" | "running" | "inspecting" | "archived" | "failed" | "interrupted" | "unknown";

export type DocumentWorkOperation = {
	schemaVersion: 1;
	requestId: string;
	workId: string;
	attemptId: string;
	kind: DocumentWorkKind;
	preparationId: string;
	preparationDigest: string;
	state: DocumentWorkOperationState;
	/** 分发目标的运行时三元组；异步之间必须复查。 */
	runtime: { agentId: string; runtimeGeneration: number };
	/** 请求摘要的指纹（不含正文）：同 requestId 不同指纹才是幂等冲突。 */
	requestDigest: string;
	error?: WorkError;
	createdAt: number;
	updatedAt: number;
	versionId?: string;
};

/** 工作记录：`revision` 只用于并发写入检查。 */
export type DocumentWorkRecord = {
	schemaVersion: 1;
	workId: string;
	sessionId: string;
	revision: number;
	title: string;
	/** 首次实际提交的来源轮次（空模式不建记录）。 */
	sourceTurnId: string;
	outputRootId: string;
	/** 确认要求（对齐 briefId + revision，或用户指令轮次）。 */
	requirementsRef?: RequirementsReference;
	activeOperationId?: string;
	/** 已经分发过的 requestId → attemptId 台账（去重与冲突判定）。 */
	requests: Record<string, { attemptId: string; requestDigest: string; state: DocumentWorkOperationState }>;
	versions: string[];
	createdAt: number;
	updatedAt: number;
	/** 归档失败后保留的输入/staging 说明，供用户判断。 */
	lastFailure?: { attemptId: string; code: WorkErrorCode; at: number };
};

/** Renderer 投影：有界快照，不读取全部文稿正文。 */
export type DocumentWorkSnapshot = {
	work: DocumentWorkRecord;
	operation?: DocumentWorkOperation;
	versions: DocumentArtifactVersion[];
	outputRootPath?: string;
	/** 扩展当前绑定状态（来自 Pi 隐藏状态投影）。 */
	binding?: DocumentWorkBindingState;
	/**
	 * 记录损坏（主档不可解析）。此时快照只作只读展示，任何新执行都被拒；
	 * 损坏文件留在磁盘上，不自动修复也不当作缺失重建。
	 */
	corrupt?: { reason: string; repairedFromBackup?: boolean };
};

export type DocumentWorkBindingState = {
	schemaVersion: 1;
	/** 稳定会话 id（catalog SessionRecord.id）。 */
	sessionId: string;
	/** 原生 Pi 会话 id（pi session header 的 sessionId）；与稳定 id 不同是常态。 */
	nativeSessionId: string;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	phase: "bound" | "running" | "reported" | "failed";
	reportId?: string;
	/** 已确认绑定的准备摘要（扩展侧回显，便于主进程核对）。 */
	kind?: DocumentWorkKind;
	stagingRelativeDir?: string;
	updatedAt?: number;
};

/** 扩展汇报的成果候选（工具参数，主进程独立验证身份和文件）。 */
export type DocumentArtifactCandidateReport = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	reportId: string;
	artifacts: string[];
	editableSources: string[];
	summary: string;
	risks: string[];
};

/**
 * 普通聊天里的改稿意向（扩展 → 主进程的**候选**）。
 *
 * 扩展只能报「这一轮用户似乎要求改稿」，并且必须带上原生 entry 身份；
 * 是否构成授权、要冻结什么范围、要不要派发，全部由主进程重新验证后决定。
 */
export type DocumentWorkRevisionIntent = {
	schemaVersion: 1;
	/** 稳定会话 id（扩展从绑定恢复而来，仅作路由提示）。 */
	sessionId: string;
	nativeSessionId: string;
	workId: string;
	/** 用户轮次的稳定原生 entry id。 */
	sourceTurnId: string;
	/** 该轮正文指纹（与主进程读回的不一致即作废）。 */
	instructionDigest: string;
	/** 供界面展示的有界摘要，不是授权依据。 */
	summary: string;
};

/** `document-work:changed` 推送载荷。 */
export type DocumentWorkChangedEvent = {
	workId: string;
	sessionId: string;
	revision: number;
	attemptId?: string;
	changeKind: "created" | "prepared" | "dispatching" | "running" | "inspecting" | "archived" | "failed" | "interrupted" | "unknown" | "cancelled";
};

export type DocumentWorkCreateInput = {
	requestId: string;
	sessionId: string;
	sourceTurnId: string;
	title: string;
	outputRootId: string;
};

export type DocumentWorkPrepareInput = WorkMutation & DocumentPreparationInput & { sessionId: string };

export type DocumentWorkStartInput = WorkMutation & {
	sessionId: string;
	kind: DocumentWorkKind;
	preparation: PreparationReference;
	expectedRuntime: { sessionId: string; agentId: string; runtimeGeneration: number };
	authorization: AuthorizationReference;
};

export type DocumentWorkOperationQuery = {
	requestId: string;
	sessionId: string;
};

export type DocumentWorkCancelInput = WorkMutation & {
	attemptId: string;
	expectedRuntime: { sessionId: string; agentId: string; runtimeGeneration: number };
};

export type DocumentWorkOutputRoot = {
	outputRootId: string;
	path: string;
	label: string;
	registeredAt: number;
};

export type DocumentWorkRegisterRootInput = {
	requestId: string;
	sessionId: string;
	/** 已由用户经系统目录选择器授权的绝对路径。 */
	path: string;
	label?: string;
};

export type DocumentWorkRegisterRootResult = {
	outputRootId: string;
	label: string;
};

/** 目录选择的三种结局：取消、登记成功、登记失败（结构化错误在 WorkResult 外层）。 */
export type DocumentWorkChooseRootOutcome = { cancelled: true } | { cancelled?: false; outputRootId: string; path: string; label: string };
