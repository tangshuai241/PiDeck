/**
 * 个人待办（P02）共享契约：规范化 camelCase DTO、视图投影与 desktopApi.personalTodo 载荷。
 *
 * 边界（三进程共享层，不得 import 运行时）：
 * - 云端 wire 形状（snake_case、`/api/cloud/personal-todos/v1`）只在主进程
 *   `src/main/personal-workbench/personalTodoWire.ts` 转换；渲染层只看本文件。
 * - 凭据字段永不进入本文件：desktopApi.personalTodo 不接收也不返回密码/令牌；云端账号沿用
 *   云端记忆已连接的账号，隔离键固定为 `origin + cloudInstanceId + account`（不能只用 username）。
 * - `revision` 是 wire `root_revision`（整族 = 根项 + 一层子项）的不透明 CAS 键：写操作原样携带，
 *   不解析、不本地重算、不与 item 级 `revision` 混用。
 * - `deadline` / `createdAt` / `updatedAt` 保留云端原文（不猜时区、不补午夜、不转 Date）。
 * - Root 与子项身份沿用云端；`linkedTaskIds` 只读展示，悬挂（解析不到任务）id 保留不删。
 */

/** 事项状态：cancelled 在云端存在而旧本地数据没有，迁移时原样保留。 */
export const PERSONAL_TODO_STATUSES = ["open", "done", "cancelled"] as const;
export type PersonalTodoStatus = (typeof PERSONAL_TODO_STATUSES)[number];

/** 紧急度上界（云端旧数据为 0–3，新建记录可能为空）。 */
export const PERSONAL_TODO_URGENCY_MAX = 3;

/** 列表排序（wire `order`）。 */
export const PERSONAL_TODO_ORDERS = ["created_desc", "created_asc", "updated_desc"] as const;
export type PersonalTodoOrder = (typeof PERSONAL_TODO_ORDERS)[number];

/** 来源分类：legacy=旧导入（保留 namespace/sourceId），canonical=新接口记录（不猜成用户已确认），unknown=无法判定。 */
export type PersonalTodoSourceKind = "legacy" | "canonical" | "unknown";

/** 受限来源元数据：只描述出处，不携带云端 raw 正文。 */
export type PersonalTodoSource = {
	kind: PersonalTodoSourceKind;
	/** 旧导入 namespace（例如 workbench）；canonical 记录为 null。 */
	namespace: string | null;
	/** 旧记录 id 或旧子项源 id（sN）；canonical 记录为 null；与 namespace 成对解释。 */
	sourceId: string | null;
	/** 旧导入指纹（诊断用；不是内容原文）。 */
	fingerprint: string | null;
	/** 旧 raw 是否仍存在（只读事实，不读取内容）。 */
	rawAvailable: boolean | null;
};

export type PersonalTodoLinkedTask = {
	id: string;
	/** 云端能否解析到对应任务；null = 未核验（首版只读展示，不猜、不删）。 */
	available: boolean | null;
};

export type PersonalTodoSubtask = {
	/** 云端身份（旧导入为合成 id，客户端不得自行改写）。 */
	id: string;
	/** 展示文本（wire 字段名为 title，转换层映射到 text）。 */
	text: string;
	note: string;
	status: PersonalTodoStatus;
	assignee: string | null;
	linkedTaskIds: string[];
	/** 旧数据源 sN（wire parent_subtodo_id 或 source.source_id）；非旧数据为 null。子项 sN 只在父项内唯一，不能当全局 id。 */
	sourceId: string | null;
};

export type PersonalTodoSubtaskProgress = {
	total: number;
	done: number;
	open: number;
	cancelled: number;
};

/** 云端规范化事项记录（根项与一层子项聚合在同一 revision 下）。 */
export type PersonalTodo = {
	id: string;
	title: string;
	note: string;
	category: string | null;
	/** 日期原文（例如 YYYY-MM-DD）；null = 未设置。 */
	deadline: string | null;
	urgency: number | null;
	status: PersonalTodoStatus;
	/** 整族 CAS 键（wire root_revision，不透明）；纯本地草稿为 ""（尚未获得云端确认）。 */
	revision: string;
	createdAt: string | null;
	updatedAt: string | null;
	linkedTaskIds: string[];
	subtodos: PersonalTodoSubtask[];
	subtodoProgress: PersonalTodoSubtaskProgress;
	source: PersonalTodoSource;
	/** 默认列表 view=roots，因此通常为 true；子项视图下为 false 并带 parentId。 */
	isRoot: boolean;
	parentId: string | null;
	/** 子项在旧数据里的源 sN（wire parent_subtodo_id）；无则 null。 */
	parentSubtaskId: string | null;
	/** 只读历史计数；正文不入列表。 */
	historyCount: number | null;
};

/** 同步阶段：只有 synced 才能显示「已保存」，其余一律显示未确认。 */
export type PersonalTodoSyncPhase = "synced" | "pending" | "sending" | "conflict" | "unknown" | "error";

export type PersonalTodoErrorCode = "notConnected" | "invalidInput" | "offline" | "writeFailed" | "cloudRejected" | "conflict" | "unknownOutcome" | "writeUnavailable" | "unsupported" | "staleAccount" | "internalError";

export type PersonalTodoErrorDetail = Record<string, string | number | boolean | null>;

/** 结构化错误：`code` 是渲染层映射 i18n 的稳定键；message 只作兜底，不含凭据与服务端原文。 */
export type PersonalTodoErrorInfo = {
	code: PersonalTodoErrorCode;
	message: string;
	detail?: PersonalTodoErrorDetail;
};

export type PersonalTodoSyncState = {
	phase: PersonalTodoSyncPhase;
	/** 该事项本地未确认操作数（含发送中与失败待重试）；synced 时为 0。 */
	pendingCount: number;
	lastError: PersonalTodoErrorInfo | null;
	/** conflict 时的云端最新整族 revision（本地草稿保留，不静默覆盖）；其余情况为 null。 */
	cloudRevision: string | null;
	lastAttemptAt: string | null;
};

/**
 * 渲染层看到的单条视图：
 * - `item` 是应渲染记录（有未确认草稿时为草稿，否则为云端确认版本）；
 * - `confirmed` / `draft` 同时给出，冲突界面可并列比较，不丢用户输入。
 */
export type PersonalTodoView = {
	item: PersonalTodo;
	confirmed: PersonalTodo | null;
	draft: PersonalTodo | null;
	sync: PersonalTodoSyncState;
	/** 关联任务可用性（悬挂 id 保留并标注 available=false / 未核验为 null）。 */
	linkedTasks: PersonalTodoLinkedTask[];
};

export type PersonalTodoQuery = {
	category?: string | null;
	/** 可多选（wire status 支持重复或逗号分隔）；null/缺省 = 全部。 */
	status?: PersonalTodoStatus[] | null;
	/** 日期原文的含界比较（词法序，不解析时区）；null/缺省 = 不限。 */
	deadlineFrom?: string | null;
	deadlineTo?: string | null;
	search?: string | null;
	/** wire updated_since：ISO 原串，字典序比较。 */
	updatedSince?: string | null;
	order?: PersonalTodoOrder | null;
	cursor?: string | null;
	/** 每页条数，1..200，默认 50（wire 默认值）。 */
	limit?: number;
};

/** 账号隔离作用域：缓存与待传队列按 `accountKey` 分目录，切账号不串数据。 */
export type PersonalTodoAccountScope = {
	origin: string;
	account: string;
	cloudInstanceId: string;
	/** sha256(origin|cloudInstanceId|account) 派生的稳定隔离键。 */
	accountKey: string;
};

export type PersonalTodoSyncSummary = {
	pending: number;
	sending: number;
	conflict: number;
	unknown: number;
	error: number;
	/** 已云端确认并进入本地台账的最近条数（诊断用）。 */
	confirmedRecent: number;
};

/**
 * 云端写入可用性：新云端写开关默认 false（501 NOT_ENABLED），typed barrier 期间 503。
 * 未知时按 available=true 尝试，首次失败降级为不可用并保留草稿（不谎称已保存）。
 */
export type PersonalTodoWriteStatus = {
	available: boolean;
	/** false 时的原因文案（不含服务端原文细节）；未知/可用为 null。 */
	reason: string | null;
	/** true = 已由云端响应确认；false = 预测值。 */
	verified: boolean;
};

export type PersonalTodoStatusView = {
	/** 云端服务是否支持新接口；false 时界面显示「服务版本不支持」，不伪造数据。 */
	supported: boolean;
	scope: PersonalTodoAccountScope | null;
	summary: PersonalTodoSyncSummary;
	write: PersonalTodoWriteStatus;
	/** 最近一次成功取回云端列表的时间（缓存来源的时间戳）。 */
	lastFetchedAt: string | null;
	lastError: PersonalTodoErrorInfo | null;
};

export type PersonalTodoListSource = "cloud" | "cache";

export type PersonalTodoStatusResult = { ok: true; status: PersonalTodoStatusView } | { ok: false; error: PersonalTodoErrorInfo };

export type PersonalTodoListResult = { ok: true; scope: PersonalTodoAccountScope | null; items: PersonalTodoView[]; nextCursor: string | null; source: PersonalTodoListSource; fetchedAt: string | null; summary: PersonalTodoSyncSummary; write: PersonalTodoWriteStatus } | { ok: false; error: PersonalTodoErrorInfo };

export type PersonalTodoGetResult = { ok: true; scope: PersonalTodoAccountScope | null; item: PersonalTodoView; summary: PersonalTodoSyncSummary; write: PersonalTodoWriteStatus } | { ok: false; error: PersonalTodoErrorInfo };

/** 写操作：create/patch/status/subtodo 三件套；linkedTaskIds 等隐藏字段首版只读。 */
export type PersonalTodoOperation =
	| { kind: "create"; title: string; note?: string; category?: string | null; deadline?: string | null; urgency?: number | null }
	| { kind: "patch"; id: string; expectedRevision: string; patch: { title?: string; note?: string; category?: string | null; deadline?: string | null; urgency?: number | null } }
	| { kind: "status"; id: string; expectedRevision: string; status: PersonalTodoStatus }
	| { kind: "subtodoAdd"; id: string; expectedRevision: string; text: string; note?: string; assignee?: string | null }
	| { kind: "subtodoPatch"; id: string; expectedRevision: string; subtodoId: string; text?: string; note?: string }
	| { kind: "subtodoStatus"; id: string; expectedRevision: string; subtodoId: string; status: PersonalTodoStatus };

export type PersonalTodoSubmitInput = {
	operation: PersonalTodoOperation;
	/**
	 * 调用方自带的稳定请求 id；只允许 [A-Za-z0-9_-]{8,80}。缺省由主进程生成。
	 * 重试必须复用同一个 requestId（不得为「盲重发」新生成）。
	 */
	clientRequestId?: string;
};

/** 提交受理结果：accepted 表示已耐久入队（不等于云端已确认，确认走 onChanged）。 */
export type PersonalTodoSubmitResult = { ok: true; item: PersonalTodoView; summary: PersonalTodoSyncSummary; write: PersonalTodoWriteStatus; accepted: true; requestId: string } | { ok: false; error: PersonalTodoErrorInfo; item?: PersonalTodoView };

export type PersonalTodoRetryInput = {
	/** 只重试该事项；缺省重试全部可重试操作。 */
	id?: string;
};

/**
 * 重试语义（无人工盲放行）：
 * - 先查 `GET /requests/:requestId`：applied → 直接确认；pending → 保持等待；404 → 用同一 requestId
 *   与同一 client_ref 安全重发（服务端命中 client_ref 会返回既有 item_id，不产生第二条记录）。
 * - 结果无法证明时保持 unknown，不新生成 requestId 重新 create。
 */
export type PersonalTodoRetryResult = { ok: true; summary: PersonalTodoSyncSummary; write: PersonalTodoWriteStatus; retried: number } | { ok: false; error: PersonalTodoErrorInfo };

/** 冲突处理：keepMine = 以云端最新 revision 为基准重放本地草稿；takeCloud = 丢弃草稿采用云端版本。 */
export type PersonalTodoResolveConflictInput = { id: string; choice: "keepMine" | "takeCloud" };

export type PersonalTodoResolveConflictResult = { ok: true; item: PersonalTodoView | null; summary: PersonalTodoSyncSummary } | { ok: false; error: PersonalTodoErrorInfo };

export type PersonalTodoChangedReason = "cloud" | "queue" | "identity" | "conflict" | "error";

export type PersonalTodoChangedEvent = {
	scope: PersonalTodoAccountScope | null;
	reason: PersonalTodoChangedReason;
	/** 本次有变化的条目视图（有上界）；超出表达范围时 `reload=true`，渲染层重拉列表。 */
	items: PersonalTodoView[];
	summary: PersonalTodoSyncSummary;
	write: PersonalTodoWriteStatus;
	reload: boolean;
	/**
	 * 本地身份被云端身份替换的映射（未确认 create 确认后 local → server id）。
	 *
	 * 渲染层据此把占位行、选中项与未提交草稿迁到新身份：这是主进程已证实的 old→new，
	 * 不是按标题猜测；未携带时表示本次没有身份替换（旧主进程兼容）。
	 */
	identityRemap?: { from: string; to: string }[];
};
