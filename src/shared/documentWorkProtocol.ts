/**
 * TPA 独立文稿：协议常量、有界编码与结构化错误（纯函数，不依赖任何运行时）。
 *
 * 主进程、Renderer 和 Pi 扩展共用同一套形状判定。扩展在 `resources/extensions/`
 * 下无法 import 本文件，故 `pi-deck-document-work-protocol.ts` 复制同一组常量，
 * 由 `tests/documentWorkContract.test.mjs` 逐字段比对，防止两侧漂移。
 *
 * 本文件只放字节与常量：编号形态、路径形态、规范 JSON、base64url 绑定载荷、
 * 结构化错误；记录解析在 `documentWorkParse.ts`。
 */
import {
	DOCUMENT_WORK_BUDGETS,
	DOCUMENT_WORK_SCHEMA_VERSION,
	DOCUMENT_WORK_STATE_TYPE,
	DOCUMENT_WORK_SNAPSHOT_TYPE,
	DOCUMENT_WORK_COMMAND,
	DOCUMENT_WORK_MATERIAL_TOOL,
	DOCUMENT_WORK_REPORT_TOOL,
	DOCUMENT_WORK_CONVERTER_VERSION,
	DOCUMENT_WORK_INTENT_TYPE,
	type WorkError,
	type WorkErrorCode,
	type WorkResult,
} from "./types/documentWork";

// 主进程模块直接从本文件引常量与结果类型，避免每处再写一遍 types 路径。
export { DOCUMENT_WORK_BUDGETS, DOCUMENT_WORK_SCHEMA_VERSION, DOCUMENT_WORK_STATE_TYPE, DOCUMENT_WORK_SNAPSHOT_TYPE, DOCUMENT_WORK_COMMAND, DOCUMENT_WORK_MATERIAL_TOOL, DOCUMENT_WORK_REPORT_TOOL, DOCUMENT_WORK_CONVERTER_VERSION, DOCUMENT_WORK_INTENT_TYPE };
export type { WorkResult, WorkError, WorkErrorCode };

/** 扩展侧需要逐字段比对的协议标识集合（契约测试的唯一比对源）。 */
export const DOCUMENT_WORK_PROTOCOL = {
	schemaVersion: DOCUMENT_WORK_SCHEMA_VERSION,
	stateType: DOCUMENT_WORK_STATE_TYPE,
	snapshotType: DOCUMENT_WORK_SNAPSHOT_TYPE,
	command: DOCUMENT_WORK_COMMAND,
	materialTool: DOCUMENT_WORK_MATERIAL_TOOL,
	reportTool: DOCUMENT_WORK_REPORT_TOOL,
	intentType: DOCUMENT_WORK_INTENT_TYPE,
	converterVersion: DOCUMENT_WORK_CONVERTER_VERSION,
	budgets: DOCUMENT_WORK_BUDGETS,
} as const;

const WORK_ERROR_CODES: ReadonlySet<string> = new Set<WorkErrorCode>([
	"INVALID_INPUT",
	"WORK_NOT_FOUND",
	"REVISION_CONFLICT",
	"IDEMPOTENCY_CONFLICT",
	"RUNTIME_CHANGED",
	"RUNTIME_BUSY",
	"PREPARATION_STALE",
	"APPROVAL_REQUIRED",
	"BASE_AMBIGUOUS",
	"BASE_CHANGED",
	"PATH_DENIED",
	"EXTENSION_UNAVAILABLE",
	"DISPATCH_UNKNOWN",
	"INSPECTION_UNVERIFIED",
	"IO_ERROR",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ID 形态：程序生成的有界非空字符串。 */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function isHexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isBoundedText(value: unknown, maxLength = 4000): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

export function isWorkErrorCode(value: unknown): value is WorkErrorCode {
	return typeof value === "string" && WORK_ERROR_CODES.has(value);
}

export function workOk<T>(value: T): WorkResult<T> {
	return { ok: true, value };
}

/** 结构化错误：跨越 IPC 边界只传代码与可判定字段，不抛裸异常。 */
export function workFail<T = never>(code: WorkErrorCode, retryable = false, extra: { currentRevision?: number; detail?: string } = {}): Extract<WorkResult<T>, { ok: false }> {
	return { ok: false, error: { code, retryable, ...(extra.currentRevision === undefined ? {} : { currentRevision: extra.currentRevision }), ...(extra.detail ? { detail: extra.detail } : {}) } };
}

export function parseWorkError(value: unknown): WorkError | undefined {
	if (!isRecord(value) || !isWorkErrorCode(value.code) || typeof value.retryable !== "boolean") return undefined;
	const currentRevision = value.currentRevision === undefined ? undefined : isNonNegativeInteger(value.currentRevision) ? value.currentRevision : undefined;
	if (value.currentRevision !== undefined && currentRevision === undefined) return undefined;
	return { code: value.code, retryable: value.retryable, ...(currentRevision === undefined ? {} : { currentRevision }), ...(isBoundedText(value.detail, 500) && value.detail ? { detail: value.detail } : {}) };
}

/**
 * 确定性 JSON 序列化：对象键按码位排序，数组保持顺序。
 * 同一逻辑载荷必须得到同一字符串，绑定摘要才可跨进程比对。
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value) ?? "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return "null";
}

/** 绑定载荷的规范字符串；两侧各自对其做 SHA-256，得到同一个 digest。 */
export function canonicalWorkBinding(payload: unknown): string {
	return canonicalJson(payload);
}

/** UTF-8 字节长度：shared 层不依赖 Buffer（Renderer 没有），但预算判定必须按字节。 */
export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			// 代理对合成一个码点（4 字节）；单独的代理项按 3 字节计，不猜测修复。
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url（无填充）：命令载荷用，避免空格/引号/换行进 RPC 消息。 */
export function encodeWorkBinding(payload: unknown): string {
	return base64UrlEncode(canonicalWorkBinding(payload));
}

/** 纯函数 base64url：两端（Node 主进程 / pi 扩展）得到同一字符串。 */
export function base64UrlEncode(value: string): string {
	const bytes: number[] = [];
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += BASE64URL_ALPHABET[first >> 2];
		output += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second === undefined ? 0 : second >> 4)];
		if (second !== undefined) output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third === undefined ? 0 : third >> 6)];
		if (third !== undefined) output += BASE64URL_ALPHABET[third & 0x3f];
	}
	return output;
}

/** base64url 解码；任何非法字符/长度返回 undefined（调用方按 INVALID_INPUT 处理）。 */
export function base64UrlDecode(value: string): string | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
	if (value.length % 4 === 1) return undefined;
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of value) {
		const digit = BASE64URL_ALPHABET.indexOf(character);
		if (digit < 0) return undefined;
		buffer = (buffer << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	let decoded = "";
	for (let index = 0; index < bytes.length; ) {
		const first = bytes[index];
		if (first < 0x80) {
			decoded += String.fromCharCode(first);
			index += 1;
			continue;
		}
		const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 0;
		if (length === 0 || index + length > bytes.length) return undefined;
		let code = first & (0x7f >> length);
		for (let offset = 1; offset < length; offset++) {
			const next = bytes[index + offset];
			if ((next & 0xc0) !== 0x80) return undefined;
			code = (code << 6) | (next & 0x3f);
		}
		// 过长编码 / 代理区码点视为损坏输入。
		if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
		decoded += String.fromCodePoint(code);
		index += length;
	}
	return decoded;
}

/**
 * 解码 `/tpa-work bind` 载荷。超过字节上限、非 JSON、非对象或形态不符一律拒绝。
 * 只在内存中解码一次；调用方随后用同一规范字符串核对 digest。
 */
export function decodeWorkBinding(text: string, maxBytes = DOCUMENT_WORK_BUDGETS.bindPayloadBytes): Record<string, unknown> | undefined {
	if (typeof text !== "string" || !text || text.length > maxBytes * 2) return undefined;
	const trimmed = text.trim();
	// 只接受 base64url 字母表；其他编码形态在边界就拒绝，不尝试容错。
	if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
	const decoded = base64UrlDecode(trimmed);
	if (decoded === undefined) return undefined;
	if (utf8ByteLength(decoded) > maxBytes) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoded);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	// 重新编码必须与输入一致：拒绝重复键/非规范 JSON 等歧义载荷。
	return canonicalWorkBinding(parsed) === decoded ? parsed : undefined;
}

/** 相对路径判定的唯一实现：绝对路径、`..`、反斜杠、NUL、盘符一律拒绝。 */
export function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > DOCUMENT_WORK_BUDGETS.reportPathLength) return false;
	if (value.includes("\0") || value.includes("\\")) return false;
	if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
	return true;
}

/** 规范化成相对路径（posix 分隔符）；不规范时返回 undefined，不做"尽量修好"。 */
export function normalizeRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "");
	return isSafeRelativePath(normalized) ? normalized : undefined;
}
