/**
 * CUA 工具结果解码（纯函数，主进程实时通道与历史投影共用）。
 *
 * 为什么从文本里解：CUA 是 MCP 工具，pi 的 MCP 适配层会把 toolResult.details 覆盖成
 * `{server, tool}`（`convertMcpResult`），结构化数据只有 content 文本能持久化到会话历史。
 * 所以工具把记录放在文本 JSON 的 `tpaCua` 字段里，这里做严格校验。
 *
 * 失败返回 undefined：工具原文照常展示，不额外造错误状态。
 */

import { CUA_ACTION_KINDS, CUA_ACTION_SCHEMA_VERSION, CUA_SCREENSHOT_REF_RE, CUA_TOOL_NAMES, TPA_CUA_RESULT_KEY, type CuaActionFrame, type CuaActionInput, type CuaActionKind, type CuaActionReceipt, type CuaActionRecord, type CuaActionTarget, type CuaRecordPoint, type CuaRecordRect } from "./types/cua";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositive(value: unknown): number | undefined {
	const number = readFinite(value);
	return number !== undefined && number > 0 ? number : undefined;
}

function readPoint(value: unknown): CuaRecordPoint | undefined {
	if (!isRecord(value)) return undefined;
	const x = readFinite(value.x);
	const y = readFinite(value.y);
	return x === undefined || y === undefined ? undefined : { x, y };
}

function readRect(value: unknown): CuaRecordRect | undefined {
	if (!isRecord(value)) return undefined;
	const x = readFinite(value.x);
	const y = readFinite(value.y);
	const width = readPositive(value.width);
	const height = readPositive(value.height);
	return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

/** 工具名最后一段：`mcp__pideck-cua__cua_click` → `cua_click`（不同 pi 版本的命名差异都归一）。 */
export function normalizeCuaToolName(toolName: string): string {
	const separator = toolName.lastIndexOf("__");
	return separator >= 0 ? toolName.slice(separator + 2) : toolName;
}

export function isCuaToolName(toolName: string): boolean {
	return (CUA_TOOL_NAMES as readonly string[]).includes(normalizeCuaToolName(toolName));
}

/** 从 pi 风格结果里取文本（content[].text 拼接；字符串结果原样返回）。 */
function extractText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function decodeFrame(value: unknown): CuaActionFrame | undefined {
	if (!isRecord(value)) return undefined;
	const frameId = typeof value.frameId === "string" && value.frameId.trim() ? value.frameId : undefined;
	if (!frameId) return undefined;
	const screenshotRef = typeof value.screenshotRef === "string" && CUA_SCREENSHOT_REF_RE.test(value.screenshotRef) ? value.screenshotRef : undefined;
	const frame: CuaActionFrame = { frameId };
	if (typeof value.displayId === "string" && value.displayId) frame.displayId = value.displayId;
	if (typeof value.sourceId === "string" && value.sourceId) frame.sourceId = value.sourceId;
	const screenRect = readRect(value.screenRect);
	if (screenRect) frame.screenRect = screenRect;
	const imageWidth = readPositive(value.imageWidth);
	const imageHeight = readPositive(value.imageHeight);
	if (imageWidth) frame.imageWidth = imageWidth;
	if (imageHeight) frame.imageHeight = imageHeight;
	const sourceWidth = readPositive(value.sourceWidth);
	const sourceHeight = readPositive(value.sourceHeight);
	if (sourceWidth) frame.sourceWidth = sourceWidth;
	if (sourceHeight) frame.sourceHeight = sourceHeight;
	if (value.coordinateSpace === "image") frame.coordinateSpace = "image";
	const rotation = readFinite(value.rotation);
	if (rotation !== undefined) frame.rotation = rotation;
	const capturedAtMs = readFinite(value.capturedAtMs);
	if (capturedAtMs !== undefined) frame.capturedAtMs = capturedAtMs;
	if (screenshotRef) frame.screenshotRef = screenshotRef;
	if (typeof value.parentFrameId === "string" && value.parentFrameId) frame.parentFrameId = value.parentFrameId;
	const crop = readRect(value.crop);
	if (crop) frame.crop = crop;
	return frame;
}

function decodeInput(value: unknown): CuaActionInput | undefined {
	if (!isRecord(value)) return undefined;
	const input: CuaActionInput = {};
	if (value.coordinateSpace === "image" || value.coordinateSpace === "screen") input.coordinateSpace = value.coordinateSpace;
	const imagePoint = readPoint(value.imagePoint);
	if (imagePoint) input.imagePoint = imagePoint;
	const screenPoint = readPoint(value.screenPoint);
	if (screenPoint) input.screenPoint = screenPoint;
	if (typeof value.button === "string") input.button = value.button;
	if (typeof value.double === "boolean") input.double = value.double;
	const deltaX = readFinite(value.deltaX);
	const deltaY = readFinite(value.deltaY);
	if (deltaX !== undefined) input.deltaX = deltaX;
	if (deltaY !== undefined) input.deltaY = deltaY;
	if (typeof value.key === "string") input.key = value.key;
	const textLength = readFinite(value.textLength);
	if (textLength !== undefined) input.textLength = textLength;
	return Object.keys(input).length > 0 ? input : undefined;
}

function decodeTarget(value: unknown): CuaActionTarget | undefined {
	if (!isRecord(value)) return undefined;
	const target: CuaActionTarget = {};
	if (typeof value.title === "string" && value.title) target.title = value.title;
	const hwnd = readFinite(value.hwnd);
	if (hwnd !== undefined) target.hwnd = hwnd;
	const rect = readRect(value.rect);
	if (rect) target.rect = rect;
	return Object.keys(target).length > 0 ? target : undefined;
}

function decodeReceipt(value: unknown): CuaActionReceipt | undefined {
	if (!isRecord(value)) return undefined;
	const receipt: CuaActionReceipt = {};
	const sent = readFinite(value.sent);
	if (sent !== undefined) receipt.sent = sent;
	if (typeof value.gate === "string" && value.gate) receipt.gate = value.gate;
	if (typeof value.error === "string") receipt.error = value.error;
	else if (value.error === null) receipt.error = null;
	return Object.keys(receipt).length > 0 ? receipt : undefined;
}

/**
 * 从 CUA 工具结果里解出动作记录。
 *
 * `toolName` 不是 CUA 工具、文本不是 JSON、缺 `tpaCua`、版本不符、action 非法时返回 undefined。
 * 单个可选字段非法只丢该字段，不因为多余字段拒绝整条记录（工具结果可能带 base64 长度等附加信息）。
 */
export function decodeCuaToolResult(toolName: string, result: unknown): CuaActionRecord | undefined {
	if (!isCuaToolName(toolName)) return undefined;
	const text = extractText(result);
	if (!text) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const raw = parsed[TPA_CUA_RESULT_KEY];
	if (!isRecord(raw)) return undefined;
	if (raw.schemaVersion !== CUA_ACTION_SCHEMA_VERSION) return undefined;
	if (typeof raw.action !== "string" || !(CUA_ACTION_KINDS as readonly string[]).includes(raw.action)) return undefined;
	const at = readFinite(raw.at);
	if (at === undefined) return undefined;

	const record: CuaActionRecord = { schemaVersion: CUA_ACTION_SCHEMA_VERSION, action: raw.action as CuaActionKind, at };
	const durationMs = readFinite(raw.durationMs);
	if (durationMs !== undefined) record.durationMs = Math.max(0, durationMs);
	const frame = decodeFrame(raw.frame);
	if (frame) record.frame = frame;
	const input = decodeInput(raw.input);
	if (input) record.input = input;
	const target = decodeTarget(raw.target);
	if (target) record.target = target;
	const receipt = decodeReceipt(raw.receipt);
	if (receipt) record.receipt = receipt;
	if (raw.effect === "unverified" || raw.effect === "observed") record.effect = raw.effect;
	return record;
}
