/**
 * 云端记忆（N04）共享契约：连接状态、人格缓存视图与 IPC 载荷。
 *
 * 边界（三process共享层，不得 import 运行时）：
 * - 这里只描述渲染层可见形态；加密凭据字段（protectedPassword / protectedToken）只活在
 *   主进程 Store 的持久化外形里，绝不进入本文件导出的渲染层接口。
 * - `account` 与 `cloudInstanceId` 是缓存与队列的隔离键；工具侧不接受账号字段，
 *   账号一律来自已认证的用户会话。
 * - 队列与同步状态的真相在后续节点（N05-N08）的 Pi 扩展侧；本节点只提供状态占位，
 *   收不到原生 RPC 状态时不得把「未收到」显示成「队列已清空」。
 */

/** 召回模式：与 Pi 扩展配置文件的 mode 字段一一对应（personal 个人向 / project 项目向）。 */
export type CloudMemorySyncMode = "personal" | "project";

/**
 * 连接状态机：
 * - disabled：用户开关关闭（不读云端、不写扩展配置）；
 * - notConfigured：开启但还没有可用的 baseUrl/账号；
 * - connected：最近一次会话校验通过；
 * - needsReconnect：认证失效且按记住的凭据重登失败（或未记住登录）；
 * - error：最近一次操作失败（网络/服务端错误）。
 */
export type CloudMemoryConnectionState = "disabled" | "notConfigured" | "connected" | "needsReconnect" | "error";

export type CloudMemoryErrorCode = "invalidInput" | "invalidBaseUrl" | "secureStorageUnavailable" | "unauthorized" | "scopeMissing" | "principalMismatch" | "offline" | "notConfigured" | "featureDisabled" | "personaUnverified" | "internalError";

export type CloudMemoryErrorDetail = Record<string, string | number | boolean | null>;

export type CloudMemoryErrorInfo = {
	code: CloudMemoryErrorCode;
	/** 面向用户的一句话原因；不含凭据、不含服务端原始响应体。 */
	message: string;
	detail?: CloudMemoryErrorDetail;
};

/** 已确认人格缓存的最小内容（写盘字段与扩展侧读取字段一致）。 */
export type CloudMemoryPersonaSnapshot = {
	account: string;
	cloudInstanceId: string;
	text: string;
	/** 云端原稿（保留原始空白/换行；GET 缺省时等于 text）。 */
	originalText: string;
	enabled: boolean;
	/** 业务 revision（云端对 text+enabled 的哈希）。 */
	revision: string;
	/** 原稿 raw_revision（云端对 original_text+enabled 的哈希）。 */
	rawRevision: string;
	updatedAt: string | null;
	/** 本地取回时间（离线时用它表达「最近已确认稿」的新鲜度）。 */
	fetchedAt: string;
};

/** 渲染层看到的人格视图：stale = 本次展示来自缓存而非刚取回。 */
export type CloudMemoryPersonaView = CloudMemoryPersonaSnapshot & { stale: boolean };

export type CloudMemoryPathsView = {
	dataDir: string;
	configFile: string;
	authFile: string;
	logFile: string;
	personaCacheFile: string;
};

/** 原生 RPC 状态聚合摘要（按当前账号 + 云实例作用域）。未知字段一律 null，界面不显示成 0。 */
export type CloudMemoryNativeSummary = {
	/** 参与聚合的会话数（诊断用，不是计数求和口径）。 */
	sessions: number;
	lastReceiptAt: string | null;
	personaRevision: string | null;
	registered: number | null;
	failed: number | null;
	lineagePartial: boolean;
	needsNewSession: boolean;
	/** 同设备共享队列：按设备去重后的待传数；未知为 null。 */
	pendingCount: number | null;
	/** 去重后的 kind:status 集合（界面按 code 映射 i18n，不直接显示原始串）。 */
	statuses: readonly string[];
	/** 去重后的 sender 相位集合（暂停/受阻由界面按固定枚举映射 i18n）。 */
	syncStates: readonly string[];
};

export type CloudMemoryStatus = {
	/** 用户明确开关（同时决定是否把 pi-deck-cloud-memory 加入 enabledBuiltInExtensions）。 */
	enabled: boolean;
	state: CloudMemoryConnectionState;
	baseUrl: string;
	account: string | null;
	cloudInstanceId: string | null;
	syncMode: CloudMemorySyncMode;
	/** 归档范围开关（个人与项目可见消息）；不改变模式语义。 */
	syncEnabled: boolean;
	/** 是否记住登录（保留加密密码以便过期重登）。 */
	rememberSignIn: boolean;
	/** 磁盘上是否存有加密凭据；永远不返回凭据本身。 */
	credentialStored: boolean;
	secureStorageAvailable: boolean;
	lastError: CloudMemoryErrorInfo | null;
	lastConnectedAt: string | null;
	lastPersonaFetchAt: string | null;
	/** enabledBuiltInExtensions 中是否已登记 Pi 扩展。 */
	extensionEnabled: boolean;
	/** 本进程内改过开关键：新会话或重启运行时后才生效。 */
	restartRequired: boolean;
	/** 离线时可能是缓存；没有缓存时为 null（回默认规则，界面明确标注）。 */
	persona: CloudMemoryPersonaView | null;
	/** 原生 RPC 状态摘要；没有新鲜状态时为 null（未知，不得显示为 0 或空队列）。 */
	native: CloudMemoryNativeSummary | null;
	paths: CloudMemoryPathsView;
};

export type CloudMemoryConnectInput = {
	baseUrl: string;
	account: string;
	password: string;
	syncMode: CloudMemorySyncMode;
	rememberSignIn: boolean;
};

export type CloudMemoryConnectResult = { ok: true; status: CloudMemoryStatus } | { ok: false; error: CloudMemoryErrorInfo };
export type CloudMemoryStatusResult = { ok: true; status: CloudMemoryStatus } | { ok: false; error: CloudMemoryErrorInfo };

/** 后续节点（N08）经原生 RPC 汇报的同步状态占位：当前只有「未收到」一种事实。 */
export type CloudMemorySyncPlaceholder = {
	/** native = 收到过 Pi 运行时状态；unavailable = 尚未收到（不得显示为队列已清空）。 */
	source: "native" | "unavailable";
	/** 未收到原生状态时的说明文案键由渲染层决定，这里只给事实字段。 */
	pendingCount: number | null;
	lastReceiptAt: string | null;
};
