/**
 * pi-deck-cloud-memory-persona —— 已确认人格缓存的离线读取、校验与追加文本。
 *
 * 复用云端 domain-store 的实际算法（跨仓不 import，只镜像同一公式，便于两边独立测试）：
 * - normalizeText = (t) => String(t ?? "").replace(/\r\n/g, "\n").trim()
 * - personaRevision = (text, enabled) => sha256hex(JSON.stringify([text, enabled]))
 * - personaRawRevision = (originalText, enabled) => sha256hex(JSON.stringify([originalText, enabled]))
 *
 * 只读、离线：不做云端请求、不写缓存（缓存由桌面 N04 原子替换）。校验不通过一律按「没有人格」，
 * 回默认规则并说明状态，绝不把未验证文本当已确认人格注入。
 */

import { createHash } from "node:crypto";

export const PERSONA_CACHE_VERSION = 1;
export const MAX_PERSONA_TEXT_CHARS = 64 * 1024;
export const MAX_PERSONA_ID_CHARS = 128;
export const MAX_PERSONA_REVISION_CHARS = 128;
export const MAX_PERSONA_APPEND_CHARS = 8000;

export const PERSONA_APPEND_TITLE = "已确认云端人格（只读；不改动系统提示、AGENTS 与项目规则）";

export type PersonaSnapshot = {
	account: string;
	cloudInstanceId: string;
	/** 归一化正文（云端 personaRevision 绑定它）。 */
	text: string;
	/** 原稿正文（云端 raw_revision 绑定它，保留空白差异）。 */
	originalText: string;
	enabled: boolean;
	revision: string;
	rawRevision: string;
	updatedAt: string | null;
	fetchedAt: string;
};

export type PersonaCacheResult =
	| { kind: "ok"; persona: PersonaSnapshot }
	| { kind: "disabled"; persona: PersonaSnapshot; reason: string }
	| { kind: "none"; reason: string };

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 与云端 normalizeText 一致：CRLF→LF 后 trim；不做其它改写。 */
export function normalizePersonaText(value: unknown): string {
	return String(value === undefined || value === null ? "" : value)
		.replace(/\r\n/g, "\n")
		.trim();
}

/** 业务 revision：绑定归一化正文与启用状态。 */
export function personaRevision(text: string, enabled: boolean): string {
	return sha256Hex(JSON.stringify([text, enabled]));
}

/** 原稿 revision：绑定未归一化原稿与启用状态（跟踪空白/换行差异）。 */
export function personaRawRevision(originalText: string, enabled: boolean): string {
	return sha256Hex(JSON.stringify([originalText, enabled]));
}

function readBounded(value: unknown, maxChars: number): string | null {
	return typeof value === "string" && value.length <= maxChars ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验缓存文件：账号/实例必须与当前 profile 一致，两个 revision 必须能由正文回算。
 * 任一条件不满足即视为无缓存（离线回默认规则），不降级使用可疑内容。
 */
export function parsePersonaCache(raw: unknown, expected: { account: string | null; cloudInstanceId: string | null }): PersonaCacheResult {
	if (!isRecord(raw)) return { kind: "none", reason: "cache_not_object" };
	const record = raw;
	if (!expected.account) return { kind: "none", reason: "profile_account_missing" };
	if (!expected.cloudInstanceId) return { kind: "none", reason: "profile_instance_missing" };

	const version = record.version === undefined ? PERSONA_CACHE_VERSION : record.version;
	if (version !== PERSONA_CACHE_VERSION) return { kind: "none", reason: "version_unsupported" };
	const account = readBounded(record.account, MAX_PERSONA_ID_CHARS);
	const cloudInstanceId = readBounded(record.cloudInstanceId, MAX_PERSONA_ID_CHARS);
	if (!account || !cloudInstanceId) return { kind: "none", reason: "identity_missing" };
	if (account !== expected.account) return { kind: "none", reason: "account_mismatch" };
	if (cloudInstanceId !== expected.cloudInstanceId) return { kind: "none", reason: "instance_mismatch" };

	const text = readBounded(record.text, MAX_PERSONA_TEXT_CHARS);
	const originalText = readBounded(record.original_text, MAX_PERSONA_TEXT_CHARS);
	const revision = readBounded(record.revision, MAX_PERSONA_REVISION_CHARS);
	const rawRevision = readBounded(record.raw_revision, MAX_PERSONA_REVISION_CHARS);
	const fetchedAt = readBounded(record.fetched_at, 64);
	if (text === null || originalText === null) return { kind: "none", reason: "text_missing" };
	if (revision === null || rawRevision === null) return { kind: "none", reason: "revision_missing" };
	if (!fetchedAt) return { kind: "none", reason: "fetched_at_missing" };
	if (typeof record.enabled !== "boolean") return { kind: "none", reason: "enabled_missing" };

	const enabled = record.enabled;
	// 两个 revision 都必须能由正文回算：内容与版本不匹配即视为不可信缓存。
	if (revision !== personaRevision(text, enabled)) return { kind: "none", reason: "revision_mismatch" };
	if (rawRevision !== personaRawRevision(originalText, enabled)) return { kind: "none", reason: "raw_revision_mismatch" };

	const updatedAt = readBounded(record.updated_at, 64);
	const persona: PersonaSnapshot = { account, cloudInstanceId, text, originalText, enabled, revision, rawRevision, updatedAt: updatedAt ?? null, fetchedAt };
	if (!enabled) return { kind: "disabled", persona, reason: "persona_disabled" };
	if (text === "") return { kind: "none", reason: "text_empty" };
	return { kind: "ok", persona };
}

/**
 * 注入文本：只追加已确认短稿，不替换系统提示/AGENTS/项目规则；超上界显式标注截断。
 */
export function buildPersonaAppend(persona: PersonaSnapshot): { text: string; truncated: boolean } | null {
	if (!persona.enabled || persona.text === "") return null;
	const truncated = persona.text.length > MAX_PERSONA_APPEND_CHARS;
	const shown = truncated ? persona.text.slice(0, MAX_PERSONA_APPEND_CHARS) : persona.text;
	const tail = truncated ? "\n（人格短稿按本地上界截断；完整稿在云端，需要时由确认流程更新）" : "";
	return {
		text: `${PERSONA_APPEND_TITLE}\n${shown}${tail}\n（revision ${persona.revision}；与系统提示或项目规则冲突时以系统提示与项目规则为准）`,
		truncated,
	};
}
