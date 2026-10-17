/**
 * CUA 动作记录的共享契约（宿主与渲染层共用，纯类型 + 常量，不依赖 Node/Electron）。
 *
 * 记录从哪来：CUA MCP 工具（`cua_capture` / `cua_zoom` / `cua_click` / `cua_scroll` /
 * `cua_type`）的文本结果里带一个 `tpaCua` 字段。pi 会把 MCP 工具的 details 覆盖成
 * `{server, tool}`，只有 content 文本会进会话历史，所以结构化记录必须走文本结果，
 * 由 `src/shared/cuaDecode.ts` 解码成这里的类型，再挂到 ChatMessage 上供轨迹回看。
 *
 * 图像单独落盘：记录里只保存 `screenshotRef`（内容寻址文件名），不保存 base64。
 */

/** 记录版本：不兼容变更时递增，解码层拒绝旧版本（工具原文照常展示）。 */
export const CUA_ACTION_SCHEMA_VERSION = 1;

/** 工具文本结果中的结构化字段名。 */
export const TPA_CUA_RESULT_KEY = "tpaCua";

/** 截图落盘引用名：内容寻址（sha256 + 扩展名）。 */
export const CUA_SCREENSHOT_REF_RE = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif|bmp|avif)$/;

/** CUA 工具名（pi 的 MCP 工具名形如 `mcp__pideck-cua__cua_click`，解码时取最后一段）。 */
export const CUA_TOOL_NAMES = ["cua_capture", "cua_zoom", "cua_click", "cua_scroll", "cua_type", "cua_list_windows", "cua_get_state"] as const;

export type CuaToolName = (typeof CUA_TOOL_NAMES)[number];

/** 会进入轨迹的动作类型（只读窗口列表/状态不产生动作记录）。 */
export const CUA_ACTION_KINDS = ["capture", "zoom", "click", "scroll", "type"] as const;

export type CuaActionKind = (typeof CUA_ACTION_KINDS)[number];

export type CuaRecordPoint = { x: number; y: number };

export type CuaRecordRect = { x: number; y: number; width: number; height: number };

/** 帧几何（图像像素 / 屏幕物理像素的关系），字段与 `CuaGeometry.describeFrameGeometry` 对应。 */
export type CuaActionFrame = {
	frameId: string;
	displayId?: string;
	sourceId?: string;
	/** 屏幕物理像素矩形（裁剪帧即裁剪区域）。 */
	screenRect?: CuaRecordRect;
	imageWidth?: number;
	imageHeight?: number;
	sourceWidth?: number;
	sourceHeight?: number;
	coordinateSpace?: "image";
	rotation?: number;
	capturedAtMs?: number;
	/** 截图的持久引用（轨迹回看用）；无落盘时缺省。 */
	screenshotRef?: string;
	parentFrameId?: string;
	/** 裁剪帧：区域在父帧图像坐标里的位置。 */
	crop?: CuaRecordRect;
};

export type CuaActionInput = {
	coordinateSpace?: "image" | "screen";
	/** 模型给出的图像坐标。 */
	imagePoint?: CuaRecordPoint;
	/** 实际注入的屏幕物理坐标（取整后）。 */
	screenPoint?: CuaRecordPoint;
	button?: string;
	double?: boolean;
	deltaX?: number;
	deltaY?: number;
	key?: string;
	textLength?: number;
};

export type CuaActionTarget = {
	title?: string;
	hwnd?: number;
	rect?: CuaRecordRect;
};

export type CuaActionReceipt = {
	/** 已注入的输入事件数；`> 0` 只代表输入发出，不代表目标操作成功。 */
	sent?: number;
	gate?: string;
	error?: string | null;
};

/**
 * 一条 CUA 动作记录。字段刻意少而稳定：够解释「点哪、怎么换算、发没发出去、花了多久」，
 * 不复制模型对话，也不充当第二套会话账本。
 */
export type CuaActionRecord = {
	schemaVersion: number;
	action: CuaActionKind;
	/** 动作发生时刻（墙钟毫秒）。 */
	at: number;
	durationMs?: number;
	frame?: CuaActionFrame;
	input?: CuaActionInput;
	target?: CuaActionTarget;
	receipt?: CuaActionReceipt;
	/** 效果是否被观察到：输入注入后默认为 `unverified`，后续截图才可能改变。 */
	effect?: "unverified" | "observed";
};

/** 工具结果文本（模型可读）。 */
export type CuaToolResultPayload = {
	sent?: number;
	error?: string | null;
	gate?: string;
	/** 兼容旧字段：交付图像尺寸、display id、耗时。 */
	width?: number;
	height?: number;
	displayId?: string;
	sourceId?: string;
	base64Length?: number;
	timestampMs?: number;
	durationMs?: number;
	/** 局部查看：父帧 id。 */
	parentFrameId?: string;
	/** 坐标空间：image 时 x/y 是图像像素，screen 时是物理像素。 */
	coordinateSpace?: "image" | "screen";
	imagePoint?: CuaRecordPoint;
	screenPoint?: CuaRecordPoint;
	tpaCua?: CuaActionRecord;
};

/** 截图落盘引用的展示 URL（主进程协议见 `main/cua/CuaFrameProtocol.ts`）。 */
export const CUA_FRAME_PROTOCOL = "pideck-cua-img";

export function cuaFrameUrl(ref: string): string {
	return `${CUA_FRAME_PROTOCOL}://frame/${encodeURIComponent(ref)}`;
}
