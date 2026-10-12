/**
 * TPA 独立文稿：主进程、preload、渲染层与 Pi 扩展共用的有界契约。
 *
 * 这里只放纯类型与常量，不依赖 Node/Electron/pi。扩展侧的镜像文件是
 * `resources/extensions/pi-deck-document-work-types.ts`，两边由
 * `tests/documentWorkContract.test.mjs` 逐字段对齐检查，防止线格式悄悄漂移。
 *
 * 设计基线（见 docs/tpa-document-work-v1.md）：
 * - 授权只来自用户确认或本轮明确改稿指令，模型文本与布尔字段一律不能授权；
 * - 稿件正文、图片和 base64 永不进入元数据或结构化汇报；
 * - 版本不可覆盖，`revision` 只用于并发写入检查，显示序号与 Pi 的 brief revision 不混用。
 */

export const DOCUMENT_WORK_SCHEMA_VERSION = 1;

/** 扩展经隐藏 custom_message 发布的文稿状态类型（不占可见历史序号）。 */
export const DOCUMENT_WORK_STATE_TYPE = "pi-deck-document-work-state";
/** 主进程绑定本轮工作上下文的控制命令；只绑定，不触发模型回合。 */
export const DOCUMENT_WORK_BIND_COMMAND = "/tpa-work";
/** 扩展侧 `tpa_artifact_report` 的候选上限，主进程按同一组数字再校验一次。 */
export const DOCUMENT_WORK_BIND_PAYLOAD_MAX_BYTES = 64 * 1024;
export const DOCUMENT_WORK_REPORT_MAX_BYTES = 64 * 1024;
export const DOCUMENT_WORK_REPORT_MAX_FILES = 32;
export const DOCUMENT_WORK_MATERIAL_MAX_COUNT = 24;
export const DOCUMENT_WORK_PATH_MAX_LENGTH = 1024;
export const DOCUMENT_WORK_ID_MAX_LENGTH = 96;
/** 单次材料读取与转换的字节上界（超过即 unverified，不虚报通过）。 */
export const DOCUMENT_WORK_MATERIAL_BYTE_BUDGET = 64 * 1024 * 1024;

export type DocumentWorkKind = "create_document" | "revise_document";

/** 与方案第 5 节一致；`OPERATION_NOT_FOUND` / `CANCEL_NOT_APPLICABLE` 为首版补全。 */
export type WorkErrorCode =
	| "INVALID_INPUT"
	| "WORK_NOT_FOUND"
	| "OPERATION_NOT_FOUND"
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
	| "CANCEL_NOT_APPLICABLE"
	| "IO_ERROR";

export type WorkError = {
	code: WorkErrorCode;
	retryable: boolean;
	/** 记录版本被并发修改时回填，调用者用它重试而不是继续用旧版本。 */
	currentRevision?: number;
	/** 结构化细节，只放标识与枚举，不放正文或路径隐私。 */
	detail?: string;
};

export type WorkResult<T> = { ok: true; value: T } | { ok: false; error: WorkError };

export type WorkMutation = {
	requestId: string;
	workId: string;
	expectedRevision: number;
};

export type PreparationReference = {
	preparationId: string;
	digest: string;
};

export type RequirementsReference = { kind: "alignment"; briefId: string; revision: number } | { kind: "user_instruction"; sourceTurnId: string; sourceTurnHash: string };

export type AuthorizationReference =
	| { kind: "alignment_confirmation"; briefId: string; revision: number }
	/** 授权是本轮真实用户指令：主进程用最新用户轮的正文指纹核对，模型无法伪造另一个来源。 */
	| { kind: "revision_instruction"; sourceTurnId: string; sourceTurnHash: string };

/** 一次确认绑定到一份不可变的准备记录：要求、材料、基稿、范围、输出位置。 */
export type DocumentWorkPreparation = {
	schemaVersion: 1;
	preparationId: string;
	digest: string;
	workId: string;
	workRevision: number;
	kind: DocumentWorkKind;
	requirements: RequirementsReference;
	requirementsSummary: string;
	outputRootId: string;
	stagingDirectory: string;
	materials: DocumentWorkMaterial[];
	base?: DocumentWorkBase;
	scope: DocumentWorkScope;
	/** 准备时实际使用的运行时三元组；运行时替换后旧准备立即失效。 */
	runtime?: SessionRuntimeTriple;
	/** 准备时的 pi 原生会话 id；扩展用它校验绑定，运行进程换代后同样失效。 */
	nativeSessionId?: string;
	createdAt: number;
};

export type SessionRuntimeTriple = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

export type DocumentWorkMaterial = {
	materialId: string;
	label: string;
	/** 用户选定材料的宿主绝对路径；只进主进程与绑定载荷，不进日志。 */
	hostPath: string;
	/** 声明时的字节指纹；读取或准备前变化即 PREPARATION_STALE。 */
	digest: string;
	bytes: number;
};

export type DocumentWorkBase = {
	versionId: string;
	ordinal: number;
	digest: string;
	fileName: string;
	/** 冻结副本在 TPA 管理目录内的绝对路径。 */
	frozenPath: string;
	/** 该版本是否来自用户手工修改后的自动接续。 */
	origin: "archived" | "external_manual";
	/** 冻结时抽出的块大纲：下一轮逐块校验「保留内容是否被改」的依据。 */
	sections: DocumentSectionFingerprint[];
};

/** 可定位块：标题 + 该块正文指纹。 */
export type DocumentSectionFingerprint = { heading: string; textDigest: string };

export type DocumentWorkScope = {
	summary: string;
	/** 声明的章节引用（规范化后的标题文本）；不在基稿标题中存在即范围冲突。 */
	sections: string[];
	preserve: string[];
	/**
	 * 本轮显式允许改动的块。基稿里其余块默认视为必须保留：
	 * 不写 allow 又不写 preserve 不等于「随便改」，否则未授权正文变化会被漏判。
	 */
	allow?: string[];
};

export type PreparedWork = {
	workId: string;
	workRevision: number;
	preparation: PreparationReference;
	summary: string;
};

export type StartWorkInput = WorkMutation & {
	preparation: PreparationReference;
	expectedRuntime: SessionRuntimeTriple;
	authorization: AuthorizationReference;
};

/** 渲染层 → 主进程的准备入参（绝对路径与授权事实都不由渲染层提供）。 */
export type DocumentWorkPrepareInput = WorkMutation & {
	kind: DocumentWorkKind;
	requirementsRef: RequirementsReference;
	scope: DocumentWorkScope;
	materialPaths: string[];
	baseVersionId?: string;
};

export type DocumentWorkStartInput = StartWorkInput;

export type CancelWorkInput = WorkMutation & {
	attemptId: string;
	expectedRuntime: SessionRuntimeTriple;
};

export type OperationPhase = "prepared" | "dispatching" | "running" | "inspecting" | "archived" | "failed" | "interrupted" | "unknown";

/** RPC 接受、扩展绑定和运行信号分别记录：接受不等于授权或执行完成。 */
export type DocumentWorkOperation = {
	schemaVersion: 1;
	requestId: string;
	workId: string;
	attemptId: string;
	kind: DocumentWorkKind;
	phase: OperationPhase;
	preparation: PreparationReference;
	preparedWorkRevision: number;
	runtime: SessionRuntimeTriple;
	authorization: AuthorizationReference;
	authorizationState: "pending" | "confirmed" | "rejected";
	/** 绑定命令是否已被扩展确认；RPC 接受不置位。 */
	extensionBound: boolean;
	dispatchAccepted: boolean;
	/** 明确的未知分发：RPC 结果不确定，禁止自动重放。 */
	dispatchUnknown: boolean;
	versionId?: string;
	error?: WorkError;
	createdAt: number;
	updatedAt: number;
};

export type InspectionItemStatus = "passed" | "failed" | "unverified";
export type InspectionStatus = "passed" | "failed" | "unverified";

export type DocumentInspectionItem = {
	id: string;
	status: InspectionItemStatus;
	detail?: string;
};

export type DocumentInspection = {
	schemaVersion: 1;
	inspectionId: string;
	versionId: string;
	status: InspectionStatus;
	items: DocumentInspectionItem[];
	coverage: {
		format: string;
		bytesRead: number;
		bytesTotal: number;
		/** 正文指纹与格式指纹分别记录：正文相同但包不同也算有差异。 */
		textDigest?: string;
		formatDigest?: string;
		textLength?: number;
		/** 本体的块大纲：下一轮改稿逐块校验保留内容。 */
		sections?: DocumentSectionFingerprint[];
		comparedToVersionId?: string;
		truncated: boolean;
	};
	byteBudget: number;
	durationMs: number;
	reason?: string;
	inspectorVersion: string;
	createdAt: number;
};

export type VersionUserAcceptance = "not_collected" | "accepted" | "rejected";

export type DocumentArtifactEntry = {
	/** 相对版本目录的相对路径，禁止绝对路径与 `..`。 */
	relativePath: string;
	role: "primary" | "editable_source" | "supporting";
	digest: string;
	bytes: number;
};

export type DocumentArtifactVersion = {
	schemaVersion: 1;
	versionId: string;
	ordinal: number;
	workId: string;
	parentVersionId?: string;
	kind: DocumentWorkKind;
	title: string;
	/** 版本目录名，例如 v0001；身份仍是 versionId。 */
	directory: string;
	artifacts: DocumentArtifactEntry[];
	/** 原始字节快照目录（TPA 管理）；用户改动公开文件不影响它。 */
	snapshotDirectory: string;
	baseVersionId?: string;
	baseDigest?: string;
	generation?: { role: "model" | "user_manual"; sourceVersionId?: string };
	modelSummary?: string;
	modelRisks: string[];
	inspection?: DocumentInspection;
	userAcceptance: VersionUserAcceptance;
	/** 归档后被观察到的外部手工修改；不改快照。 */
	manualModification?: { digest: string; observedAt: number };
	createdAt: number;
};

export type DocumentOutputRoot = {
	outputRootId: string;
	/** 显示名与绝对路径；路径经用户选择授权，不接受模型指定。 */
	label: string;
	path: string;
	addedAt: number;
};

export type DocumentWorkRecord = {
	schemaVersion: 1;
	workId: string;
	sessionId: string;
	/** 并发写入检查用；与 Pi 的 brief revision 无关。 */
	revision: number;
	title: string;
	outputRootId: string;
	/** 公开成果目录（<outputRoot>/<workFolder>）。 */
	workDirectory: string;
	workFolder: string;
	sourceTurnIds: string[];
	requirementsSummary: string;
	activeRequestId?: string;
	operationRequestIds: string[];
	versionIds: string[];
	/** 已消费过的改稿轮正文指纹（审计与旧数据兼容；重放判定用下面的轮标识）。 */
	consumedRevisionTurns: string[];
	/**
	 * 已消费过的用户轮标识（稳定 ChatMessage.id）。
	 *
	 * 为什么必须按轮而不是按正文：同一轮重挂载后不能再次触发，但用户在新的一轮里
	 * 又说了一遍同样的改稿要求属于新授权——按 hash 会永久挡住那句话。
	 */
	consumedRevisionTurnIds: string[];
	createdAt: number;
	updatedAt: number;
};

/**
 * 运行时排他租约：一个 runtime 同时只允许一轮文稿执行。
 *
 * 为什么必须跨进程持久化：`unknown` 分发与崩溃重启都不能让同一 runtime 上的新请求
 * 悄悄开始第二轮（包括别的 work）。租约在「占用 → bind → 执行 → 权威结算」期间有效，
 * 只有明确取消或 runtime 换代（agentId/generation/nativeId 变化）才解除。
 */
export type DocumentRuntimeLease = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	nativeSessionId?: string;
	workId: string;
	requestId: string;
	attemptId: string;
	acquiredAt: number;
};

export type DocumentWorkChangeKind = "created" | "prepared" | "dispatching" | "running" | "inspecting" | "archived" | "failed" | "interrupted" | "unknown" | "cancelled";

export type DocumentWorkChangedEvent = {
	workId: string;
	sessionId: string;
	revision: number;
	attemptId?: string;
	changeKind: DocumentWorkChangeKind;
};

/** 渲染层可见的有界工作快照：不放正文、不放绝对路径之外的隐私。 */
export type DocumentWorkView = {
	workId: string;
	sessionId: string;
	revision: number;
	title: string;
	outputRootLabel: string;
	requirementsSummary: string;
	active: {
		attemptId: string;
		kind: DocumentWorkKind;
		phase: OperationPhase;
		authorizationState: "pending" | "confirmed" | "rejected";
		error?: WorkError;
	} | null;
	versions: Array<{
		versionId: string;
		ordinal: number;
		title: string;
		fileName: string;
		inspection: InspectionStatus | "pending";
		userAcceptance: VersionUserAcceptance;
		baseVersionId?: string;
		manualModification: boolean;
		createdAt: number;
	}>;
	/** 该工作是否已准备好接受改稿（存在可用基稿）。 */
	revisionReady: boolean;
};

/** Pi 扩展汇报的候选成果；只是候选，不是检查结论。 */
export type DocumentArtifactCandidate = {
	reportId: string;
	artifacts: Array<{ relativePath: string; role: "primary" | "editable_source" | "supporting" }>;
	summary: string;
	risks: string[];
};

/** 扩展确认绑定并回报时发布的快照形态（解析前视为不可信输入）。 */
export type DocumentWorkExtensionState = {
	schemaVersion: 1;
	workId: string;
	attemptId: string;
	preparationId: string;
	digest: string;
	sessionId: string;
	phase: "bound" | "reported" | "rejected";
	materials: Array<{ materialId: string; status: "unknown" | "converted" | "failed"; digest?: string; converterVersion?: string; error?: string }>;
	report?: DocumentArtifactCandidate;
	reason?: "invalid_payload" | "already_bound" | "mismatch" | "no_work";
};

/** 扩展汇报的改稿意图；授权仍是那一轮真实用户指令，不是这段文本。 */
export type DocumentRevisionIntent = {
	intentId: string;
	sourceTurnId: string;
	instruction: string;
	sections: string[];
	preserve: string[];
};
