/**
 * P03 阅读共享契约（TPA 主/渲染共享，纯类型 + 常量，不 import 运行时）。
 *
 * 边界：
 * - 所有字段 camelCase；DeepRead 的 snake_case wire 只在主进程
 *   `src/main/personal-workbench/reading/readingWire.ts` 转换（唯一转换点），渲染层永远看本文件。
 * - 本文件不含任何凭据字段：连接密码只在主进程安全存储里，状态/错误/事件一律不回传密码或 cookie。
 * - 书库/正文/引用/笔记/历史都来自 DeepRead（现有 API + P03 契约新增的 noteId 注册读写与
 *   source-labelled 历史）；TPA 只保存阅读位置与会话绑定（绑定按 workId+editionId 持久，
 *   内容版本变化不改写绑定归属）。
 * - P04 只做「用户选中的一次性材料带入指定会话」：材料块本身在 shared/workbenchMaterialBlocks，
 *   本文件只管绑定关系的读写契约；不提供 Pi 工具、不自动记忆注入、不每轮读工作台。
 */

/** 服务可用性：unknown=还没探测；ready=最近一次调用成功；unavailable=连不上；needsConnection=服务要求密码而本地未连接。 */
export type ReadingServiceAvailability = "unknown" | "ready" | "unavailable" | "needsConnection";

export type ReadingErrorCode = "unavailable" | "needsConnection" | "invalidInput" | "notFound" | "unsupported" | "staleVersion" | "conflict" | "unknownOutcome" | "writeFailed" | "secureStorageUnavailable" | "internalError";

export type ReadingErrorDetail = Record<string, string | number | boolean | null>;

/** 结构化错误：code 供渲染层映射 i18n；message 只作兜底，不含服务端原文与凭据。 */
export type ReadingErrorInfo = { code: ReadingErrorCode; message: string; detail?: ReadingErrorDetail };

export const READING_DEFAULT_BASE_URL = "http://127.0.0.1:18965";
export const READING_POSITION_FRACTION_MIN = 0;
export const READING_POSITION_FRACTION_MAX = 1;

// ── 服务与连接 ────────────────────────────────────────────────────────────────

export type ReadingConnectionView = {
	/** 规范化后的回环 origin（http(s)://127.0.0.1|localhost|[::1]:port）。 */
	baseUrl: string;
	/** 最近一次调用是否通过（服务未启用密码时也视为通过）。 */
	connected: boolean;
	/** 服务是否要求密码；null = 尚未探测到。 */
	authRequired: boolean | null;
	/** 主进程是否保存了受保护密码（永远不返回密码本身）。 */
	credentialStored: boolean;
	rememberPassword: boolean;
	lastError: ReadingErrorInfo | null;
	lastConnectedAt: string | null;
};

export type ReadingServiceStatus = {
	availability: ReadingServiceAvailability;
	connection: ReadingConnectionView;
	/** 契约 §6 的 noteId 注册读写接口是否可用；null = 未知（尚未调用）。 */
	notesApi: boolean | null;
	/** 契约 §7 的 source-labelled 历史接口是否可用；null = 未知。 */
	historyApi: boolean | null;
	/** 本地数据目录（诊断用，不含凭据）。 */
	dataDir: string;
};

export type ReadingConnectInput = {
	/** 缺省用 READING_DEFAULT_BASE_URL；只允许回环地址。 */
	baseUrl?: string;
	password: string;
	rememberPassword: boolean;
};

export type ReadingStatusResult = { ok: true; status: ReadingServiceStatus } | { ok: false; error: ReadingErrorInfo };

// ── 书库、身份、目录、正文 ───────────────────────────────────────────────────

export type ReadingEdition = {
	editionId: string;
	/** 服务端返回的相对路径或绝对路径；`book` 参数只允许用它（不得传书名/stem）。 */
	rel: string;
	size: number;
	mtime: number;
	title: string | null;
};

export type ReadingWork = {
	workId: string;
	title: string;
	author: string | null;
	editionCount: number;
	editions: ReadingEdition[];
};

export type ReadingLibraryResult = { ok: true; works: ReadingWork[]; fetchedAt: string } | { ok: false; error: ReadingErrorInfo };

/** 版本身份（work/edition/contentVersion 三者成对持久化，互不可推导）。 */
export type ReadingIdentity = {
	workId: string;
	editionId: string;
	/** 内容版本 = sha256(fileBytes)[:16]（服务端口径），原样携带。 */
	contentVersion: string;
	filename: string | null;
	size: number | null;
};

export type ReadingTocItem = {
	pos: number;
	href: string;
	title: string;
	isChapter: boolean;
	chapterNum: number | null;
	/** chapter=能映射章节；frontmatter=前置页。 */
	mapStatus: "chapter" | "frontmatter";
};

export type ReadingSpineItem = { index: number; href: string };

export type ReadingAnalysisSummary = {
	found: boolean;
	matchQuality: string | null;
	fileCount: number | null;
	matchBasis: string | null;
};

export type ReadingEditionView = {
	identity: ReadingIdentity;
	toc: ReadingTocItem[];
	spine: ReadingSpineItem[];
	analysis: ReadingAnalysisSummary | null;
};

export type ReadingEditionResult = { ok: true; edition: ReadingEditionView } | { ok: false; error: ReadingErrorInfo };

export type ReadingChapter = {
	chapterNum: number | null;
	title: string;
	href: string;
	text: string;
	wordCount: number;
	textDigest: string | null;
	/** 偏移单位由服务端声明；渲染层不换算、不猜。 */
	offsetUnit: "unicode_code_point";
};

export type ReadingChapterResult = { ok: true; identity: ReadingIdentity; chapter: ReadingChapter } | { ok: false; error: ReadingErrorInfo };

/** 引文核验入参（desktopApi.reading.resolveQuote）：expectedVersion 必填。 */
export type ReadingResolveQuoteInput = { workId: string; editionId: string; text: string; chapterHref?: string | null; expectedVersion: string };

// ── 引文核验 ─────────────────────────────────────────────────────────────────

export type ReadingQuoteCandidate = {
	chapterNum: number | null;
	href: string;
	title: string;
	matchStatus: string;
	matchLevel: string;
	start: number | null;
	end: number | null;
	chapterWordCount: number | null;
};

export type ReadingQuoteResult = { ok: true; identity: ReadingIdentity; status: string; candidates: ReadingQuoteCandidate[]; candidatesTruncated: boolean; note: string | null } | { ok: false; error: ReadingErrorInfo };

// ── 笔记（主账仍在 DeepRead；TPA 只按 noteId 引用） ─────────────────────────────

export type ReadingNoteSource = "deepread";

export type ReadingNoteSummary = {
	/** 服务端签发的稳定身份；渲染层与主进程只传它，绝不传文件路径。 */
	noteId: string;
	source: ReadingNoteSource;
	name: string;
	/** 旧笔记的人类可读章节标签（如 "5.标题"）；原样保留，不做 toc 映射。 */
	chapterLabel: string | null;
	/** 内容 hash（不透明 revision，wire `sha256:<64hex>`）；写 CAS 用它。 */
	revision: string | null;
	updatedAt: string | null;
	/** 服务端判定：无法定位到章节/作品时为 true，不伪造 anchor。 */
	unlocated: boolean;
	/** 归属状态（wire link_status）：linked=能对上当前 work；pending=等待确认。 */
	linkStatus: "linked" | "pending" | null;
};

export type ReadingNoteListResult = { ok: true; notes: ReadingNoteSummary[]; unattributed: ReadingNoteSummary[] } | { ok: false; error: ReadingErrorInfo };

export type ReadingNoteReadResult = { ok: true; note: ReadingNoteSummary; content: string; truncated: boolean } | { ok: false; error: ReadingErrorInfo };

/** 未确认草稿：主进程在服务端确认前持久保留原 operation 与 requestId，重开/重试复用同一载荷。 */
export type ReadingNoteDraft = {
	/** 草稿身份（= 服务端 request_id）；恢复/丢弃都按它定位。 */
	requestId: string;
	/** 归属服务 origin（按服务隔离；旧记录可能为空字符串，视为任意 origin 可见）。 */
	origin: string;
	/** wire user（P03 固定 "default"，与 request 台账同源隔离）。 */
	user: string;
	workId: string;
	editionId: string;
	noteId: string | null;
	op: "create" | "update" | "append";
	section: string | null;
	content: string;
	/** create 时的章节标签（原文），重试时原样重发。 */
	chapterLabel: string | null;
	updatedAt: string;
	/** 原样保留的提交载荷：恢复/重试必须复用同一 requestId + 同一 payload。 */
	operation: ReadingNoteWriteOperation;
};

export type ReadingNoteWriteOperation =
	| { op: "create"; workId: string; editionId: string; concept: string; chapter?: string | null; quote?: string | null; understanding?: string | null }
	| { op: "update" | "append"; workId: string; editionId: string; noteId: string; section: string; content: string; expectedRevision: string };

export type ReadingNoteWriteInput = { operation: ReadingNoteWriteOperation; clientRequestId?: string };

export type ReadingNoteWriteResult = { ok: true; note: ReadingNoteSummary; requestId: string } | { ok: false; error: ReadingErrorInfo; draft?: ReadingNoteDraft };

/** 本地未确认笔记草稿：重开应用后可列出（list），按 draft 身份恢复/丢弃；不自动重发。 */
export type ReadingNoteDraftRef = { requestId: string };

export type ReadingNoteDraftListResult = { ok: true; drafts: ReadingNoteDraft[]; issue: ReadingErrorInfo | null } | { ok: false; error: ReadingErrorInfo };

export type ReadingNoteDraftActionResult = { ok: true; discarded: true } | { ok: false; error: ReadingErrorInfo };

/** 恢复草稿：先查服务端 request 台账；已生效则清稿，未生效则保留（不自动重发）。 */
export type ReadingNoteDraftResumeResult = ReadingNoteWriteResult;

// ── 阅读位置（TPA 本地主账） ──────────────────────────────────────────────────

export type ReadingPositionScope = { workId: string; editionId: string; contentVersion: string };

export type ReadingPosition = {
	workId: string;
	editionId: string;
	contentVersion: string;
	/** 0..1（服务端/阅读器给出的 fraction，原样保存）。 */
	fraction: number;
	spineHref: string | null;
	chapterNum: number | null;
	/** 恢复时用于校验正文未变的章节摘要（可选）。 */
	chapterTextDigest: string | null;
	source: "reader" | "fallback";
	savedAt: string;
};

export type ReadingPositionStaleReason = "none" | "missing" | "versionMismatch";

export type ReadingPositionGetResult = { ok: true; position: ReadingPosition | null; stale: boolean; reason: ReadingPositionStaleReason } | { ok: false; error: ReadingErrorInfo };

export type ReadingPositionSaveInput = {
	workId: string;
	editionId: string;
	/** 发起时阅读器正在显示的内容版本；与当前不匹配的写入会被丢弃。 */
	contentVersion: string;
	fraction: number;
	spineHref?: string | null;
	chapterNum?: number | null;
	chapterTextDigest?: string | null;
};

export type ReadingPositionSaveResult = { ok: true; position: ReadingPosition; idempotent: boolean; scope: ReadingPositionScope } | { ok: false; error: ReadingErrorInfo };

// ── 旧阅读历史（source-labelled，只读） ───────────────────────────────────────

export type ReadingHistorySourceName = "deepread-current" | "deepread-legacy";

export type ReadingHistorySource = { source: ReadingHistorySourceName; label: string; root: string; count: number; readable: boolean };

export type ReadingHistorySourcesResult = { ok: true; sources: ReadingHistorySource[] } | { ok: false; error: ReadingErrorInfo };

/** 旧会话列表查询（desktopApi.reading.listHistory）：source 必填，两源分页各自独立。 */
export type ReadingHistoryQuery = { source: ReadingHistorySourceName; cursor?: string | null; limit?: number };

export type ReadingHistorySession = {
	source: ReadingHistorySourceName;
	id: string;
	title: string | null;
	bookLabel: string | null;
	chapterLabel: string | null;
	/** bound=能对上当前书库；unattributed=归属未知（原样展示，不猜、不合并）。 */
	attribution: "bound" | "unattributed";
	provider: string | null;
	model: string | null;
	updatedAt: string | null;
	counts: Record<string, number> | null;
	/** 该文件是否可读；不可读时 error 给原因（仍出现在列表里）。 */
	readable: boolean;
	error: string | null;
};

export type ReadingHistoryListResult = { ok: true; source: ReadingHistorySourceName | null; sessions: ReadingHistorySession[]; nextCursor: string | null } | { ok: false; error: ReadingErrorInfo };

export type ReadingHistorySessionResult = { ok: true; source: ReadingHistorySourceName; id: string; session: ReadingHistorySession; raw: string; truncated: boolean } | { ok: false; error: ReadingErrorInfo };

// ── P04：选区快照与会话绑定（绑定由主进程按 workId+editionId 持久；本节点不提供 Pi 工具） ──

export type ReadingSelectionSnapshot = {
	workId: string;
	editionId: string;
	contentVersion: string;
	chapterHref: string;
	chapterNum: number | null;
	text: string;
	start: number | null;
	end: number | null;
	capturedAt: string;
};

export type ReadingSessionBinding = {
	workId: string;
	editionId: string;
	sessionId: string;
	projectId: string;
	createdAt: string;
	lastUsedAt: string;
};

/** 绑定列表：staleSessionIds=指向已消失会话的绑定；issue=本地绑定文件最近一次损坏隔离诊断。 */
export type ReadingBindingListResult = { ok: true; bindings: ReadingSessionBinding[]; staleSessionIds?: string[]; issue?: ReadingErrorInfo | null } | { ok: false; error: ReadingErrorInfo };

/** 绑定解析/解绑的定位键：书目与版本成对，不允许只按 work 猜版本。 */
export type ReadingBindingRef = { workId: string; editionId: string };

/** none=有绑定且会话存在；missing=该版本还没有绑定；sessionMissing=绑定还在但会话已不在。 */
export type ReadingBindingResolveReason = "none" | "missing" | "sessionMissing";

/** 绑定解析结果：stale=true 时不静默新建/替换，保留选区和草稿等用户明确处理。 */
export type ReadingBindingResolveResult = { ok: true; binding: ReadingSessionBinding | null; sessionExists: boolean; stale: boolean; reason: ReadingBindingResolveReason } | { ok: false; error: ReadingErrorInfo };

/** 显式绑定：会话必须已存在（复用 SessionCatalog 存在检查），不写 Pi session 文件。 */
export type ReadingBindSessionInput = { workId: string; editionId: string; sessionId: string; projectId: string };

export type ReadingBindingMutationResult = { ok: true; binding: ReadingSessionBinding } | { ok: false; error: ReadingErrorInfo };

export type ReadingUnbindResult = { ok: true; removed: boolean } | { ok: false; error: ReadingErrorInfo };

// ── 事件（当前无推送；保留通道类型位，P04 再启用会话/选区推送） ─────────────────

export type ReadingChangedReason = "status" | "position" | "notes" | "identity";

export type ReadingChangedEvent = { reason: ReadingChangedReason; scope: ReadingPositionScope | null };
