/**
 * 交互图表契约（宿主侧唯一来源）。
 *
 * 链路：Pi 扩展工具 `render_chart` 返回原生 toolResult 的 `details.tpaChart`
 * → 主进程纯解码（`src/shared/chartDecode.ts`）→ `ChatMessage.chart`
 * → 回合展示层常显图表成果卡。
 *
 * 与扩展侧 `resources/extensions/pi-deck-chart-contract.ts` 的对应关系：
 * 扩展跑在 pi 进程里，不能 import 仓库 TS，因此那边是「契约的扩展侧镜像」；
 * 两侧的字段名、枚举与上限必须一致，由 `tests/chartContractParity.test.mjs` 兜底。
 */

/** 契约版本：不兼容变更时递增，旧版本结果会被解码层拒绝并保留工具原文。 */
export const CHART_SCHEMA_VERSION = 1;

/** 工具名：模型调用入口，也是解码层识别专用图表结果的唯一依据。 */
export const TPA_CHART_TOOL_NAME = "render_chart";

/** 结构化结果在 toolResult.details 下的键名。 */
export const TPA_CHART_DETAILS_KEY = "tpaChart";

/**
 * 规模预算（产品预算，不是性能承诺）：
 * 每图最多 2000 行、8 个系列、序列化载荷 256 KiB。超限时工具要求模型先聚合，
 * 不静默截断成另一张图。
 */
export const CHART_MAX_ROWS = 2000;
export const CHART_MAX_SERIES = 8;
export const CHART_MAX_PAYLOAD_BYTES = 256 * 1024;

export const CHART_KINDS = ["bar", "line", "pie", "area"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** 单元格：类目值为字符串，系列值只允许有限数值或显式缺失（null）。 */
export type ChartCell = string | number | null;

export type ChartAxisKind = "category" | "date" | "number";

/** 图形方向：类目很长或很多时用水平柱状图（layout=horizontal）。 */
export type ChartLayout = "vertical" | "horizontal";

export type ChartAxis = {
	key: string;
	label: string;
	kind: ChartAxisKind;
};

export type ChartSeries = {
	key: string;
	label: string;
	unit?: string;
};

export type ChartSource = {
	label: string;
	locator?: string;
};

export type ChartSpec = {
	schemaVersion: number;
	title: string;
	description?: string;
	kind: ChartKind;
	layout?: ChartLayout;
	stacked?: boolean;
	x: ChartAxis;
	series: ChartSeries[];
	rows: Array<Record<string, ChartCell>>;
	sources?: ChartSource[];
};

/**
 * 图表成果：`chartId` 由工具执行端按真实 `toolCallId` 生成，
 * 模型只能通过 `parentChartId` 引用此前工具回执里的身份，不自行编造。
 */
export type ChartArtifact = {
	chartId: string;
	parentChartId?: string;
	spec: ChartSpec;
};

/** 解码结果：失败时带简短原因，供工具详情显示，不覆盖已有工具文本。 */
export type ChartDecodeResult = { ok: true; artifact: ChartArtifact } | { ok: false; reason: string };

/** 图表交互状态（筛选/图例/图形切换）按 `sessionId + chartId` 隔离，见渲染层 chart-atoms。 */
export type ChartInteractionState = {
	hiddenSeries: string[];
	layout: ChartLayout;
	stacked: boolean;
	/** 当前视图使用的图形；与源图形不同即表示用户做了相容切换。 */
	kind: ChartKind;
	/** 可见行范围（闭区间下标）；null 表示全部。 */
	range: { start: number; end: number } | null;
	zoomed: boolean;
};

/** 导出格式：文本走 CSV，图形走 PNG（浏览器原生栅格化，不新增截图依赖）。 */
export type ChartExportFormat = "csv" | "png";

export type ChartExportRequest = {
	format: ChartExportFormat;
	/** 建议文件名（不含目录）；主进程会再做一次路径字符清洗。 */
	suggestedName: string;
	/** CSV 文本内容（format=csv 时必填）。 */
	text?: string;
	/** PNG data URL（format=png 时必填）。 */
	dataUrl?: string;
};

export type ChartExportResult = { ok: true; filePath: string } | { ok: false; canceled?: true; error?: string };

/** 导出体积上限：CSV 16 MiB、PNG 32 MiB（防止渲染层误传巨大负载写盘）。 */
export const CHART_EXPORT_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const CHART_EXPORT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
