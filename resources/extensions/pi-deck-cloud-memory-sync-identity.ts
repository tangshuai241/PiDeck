/**
 * pi-deck-cloud-memory-sync-identity —— 原话身份与哈希纯函数（N05/N06）。
 *
 * 冻结口径（frozen-contract.md）：
 * - source_id = "src_" + sha256(JSON.stringify([accountId, cloudInstanceId, deviceId, sessionId, entryId, revision]))
 *   固定 JSON 数组，字段顺序与契约列举一致；账号/实例/设备/会话/条目/修订任一变化即新身份。
 * - text_sha256 = sha256(UTF-8(可见文本))，原文逐字不改：不 trim、不合并空白、不换行转换。
 * - content_hash = sha256(canonicalJson(固定业务字段))。冻结字段表（云端必须逐字段镜像，键按字典序）：
 *   kind(message|visibility)、role、text_blocks([{text,type:"text"}])、occurred_at、project、parent_source_id、
 *   target_source_id、branch、completion、visibility；不含 revision、source_id、待传状态、重试时间、云端序号。
 * - 可见文本 = 各 text 块以 LF 连接（与现有 extractMessageText 口径一致），文本块本身逐字保留。
 *
 * 原始 Pi entry 只读、不可覆写：revision 由本模块表达——编辑/隐藏/分支变化用
 * advanceSyncRevision() 产生 revision+1 的新记录，targetSourceId 指向上一个 sourceId。
 */

import { createHash } from "node:crypto";
import { MAX_IDENTITY_FIELD_CHARS, MAX_OCCURRED_AT_CHARS, MAX_PROJECT_CHARS, SOURCE_ID_PREFIX, SYNC_RECORD_SCHEMA, SYNC_SCHEMA_VERSION, type SyncCompletion, type SyncEventKind, type SyncIdentity, type SyncRecord, type SyncRecordInput, type SyncRole, type SyncTextBlock, type SyncVisibility } from "./pi-deck-cloud-memory-sync-types";

export const SOURCE_ID_PATTERN = /^src_[0-9a-f]{64}$/;

const COMPLETIONS: readonly SyncCompletion[] = ["completed", "incomplete"];
const VISIBILITIES: readonly SyncVisibility[] = ["visible", "hidden"];
const EVENT_KINDS: readonly SyncEventKind[] = ["message", "visibility"];
const ROLES: readonly SyncRole[] = ["user", "assistant"];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 确定性 canonical JSON：对象键按字典序、无空白；数组保序；非 JSON 值直接报错。 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("canonicalJson 不接受非有限数字");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (isPlainRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = canonicalize(value[key]);
		}
		return out;
	}
	throw new TypeError(`canonicalJson 不支持的取值类型：${typeof value}`);
}

/** 只接受普通对象（含 null 原型）；Date/Map 等其它实例一律拒绝，避免出现空 canonical 值。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const ctor = value.constructor;
	return typeof ctor === "function" && ctor.name === "Object";
}

/** 只保留 text 块；工具结果、思考过程等其它块一律不进原话，空文本块丢弃。 */
export function normalizeSyncTextBlocks(content: unknown): SyncTextBlock[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const blocks: SyncTextBlock[] = [];
	for (const part of content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
		if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
	}
	return blocks;
}

export function visibleTextFromBlocks(blocks: readonly SyncTextBlock[]): string {
	return blocks.map((block) => block.text).join("\n");
}

/** 原始可见文本的完整 SHA-256；不改写文本本身。 */
export function syncTextSha256(visibleText: string): string {
	return sha256Hex(Buffer.from(visibleText, "utf8"));
}

function fieldProblem(name: string, value: unknown, maxChars: number): string | null {
	if (typeof value !== "string" || value.length === 0) return `${name}:missing`;
	if (value.length > maxChars) return `${name}:too_long`;
	if (CONTROL_CHARS.test(value)) return `${name}:control_chars`;
	return null;
}

/** 身份校验；返回问题列表，空数组即合法。outbox 也用它校验 scope。 */
export function validateSyncIdentity(value: unknown): string[] {
	if (!isRecord(value)) return ["identity:not_object"];
	const problems: string[] = [];
	for (const name of ["accountId", "cloudInstanceId", "deviceId", "sessionId", "entryId"] as const) {
		const problem = fieldProblem(name, value[name], MAX_IDENTITY_FIELD_CHARS);
		if (problem) problems.push(problem);
	}
	const revision = value.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) problems.push("revision:invalid");
	return problems;
}

/** source_id：固定 JSON 数组字段顺序为账号、云端实例、device、session、entry、revision。 */
export function buildSourceId(identity: SyncIdentity): string {
	const problems = validateSyncIdentity(identity);
	if (problems.length > 0) throw new TypeError(`非法来源身份：${problems.join(",")}`);
	return SOURCE_ID_PREFIX + sha256Hex(Buffer.from(JSON.stringify([identity.accountId, identity.cloudInstanceId, identity.deviceId, identity.sessionId, identity.entryId, identity.revision]), "utf8"));
}

function contentFields(record: {
	kind: SyncEventKind;
	role: SyncRole;
	textBlocks: readonly SyncTextBlock[];
	project: string | null;
	parentSourceId: string | null;
	targetSourceId: string | null;
	branch: string | null;
	occurredAt: string;
	completion: SyncCompletion;
	visibility: SyncVisibility;
}): Record<string, unknown> {
	return {
		branch: record.branch,
		completion: record.completion,
		kind: record.kind,
		occurred_at: record.occurredAt,
		parent_source_id: record.parentSourceId,
		project: record.project,
		role: record.role,
		target_source_id: record.targetSourceId,
		text_blocks: record.textBlocks.map((block) => ({ text: block.text, type: block.type })),
		visibility: record.visibility,
	};
}

/** 内容身份哈希：固定业务字段的 canonical JSON；不含 revision/待传状态/重试时间/云端序号。 */
export function syncContentHash(fields: Parameters<typeof contentFields>[0]): string {
	return sha256Hex(Buffer.from(canonicalJson(contentFields(fields)), "utf8"));
}

function optionalSourceProblem(name: string, value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !SOURCE_ID_PATTERN.test(value)) return `${name}:invalid_source_id`;
	return null;
}

function normalizedProject(project: string | null | undefined): string | null {
	if (project === null || project === undefined) return null;
	if (typeof project !== "string" || project.length === 0) throw new TypeError("project 必须是非空字符串或 null");
	if (project.length > MAX_PROJECT_CHARS) throw new TypeError(`project 超过 ${MAX_PROJECT_CHARS} 字符`);
	return project;
}

/** 由采集输入生成待传记录：文本块逐字保留，source_id 与两个哈希在此一次性派生。 */
export function createSyncRecord(input: SyncRecordInput): SyncRecord {
	const problems = validateSyncIdentity(input?.identity);
	if (problems.length > 0) throw new TypeError(`非法来源身份：${problems.join(",")}`);
	if (!ROLES.includes(input.role)) throw new TypeError(`非法角色：${String(input.role)}`);
	if (typeof input.occurredAt !== "string" || input.occurredAt.length === 0 || input.occurredAt.length > MAX_OCCURRED_AT_CHARS || CONTROL_CHARS.test(input.occurredAt)) {
		throw new TypeError("occurredAt 必须是合法的非空短字符串");
	}
	const completion = input.completion ?? "completed";
	if (!COMPLETIONS.includes(completion)) throw new TypeError(`非法完成状态：${String(completion)}`);
	const visibility = input.visibility ?? "visible";
	if (!VISIBILITIES.includes(visibility)) throw new TypeError(`非法可见性：${String(visibility)}`);
	const kind = input.kind ?? "message";
	if (!EVENT_KINDS.includes(kind)) throw new TypeError(`非法事件类型：${String(kind)}`);
	const parentProblem = optionalSourceProblem("parentSourceId", input.parentSourceId);
	if (parentProblem) throw new TypeError(parentProblem);
	const targetProblem = optionalSourceProblem("targetSourceId", input.targetSourceId);
	if (targetProblem) throw new TypeError(targetProblem);
	if (typeof input.branch !== "string" && input.branch !== null && input.branch !== undefined) throw new TypeError("branch 必须是字符串或 null");
	if (typeof input.branch === "string" && input.branch.length > MAX_IDENTITY_FIELD_CHARS) throw new TypeError("branch 超长");

	const textBlocks = normalizeSyncTextBlocks(input.content);
	const visibleText = visibleTextFromBlocks(textBlocks);
	const project = normalizedProject(input.project);
	const contentHash = syncContentHash({
		kind,
		role: input.role,
		textBlocks,
		project,
		parentSourceId: input.parentSourceId ?? null,
		targetSourceId: input.targetSourceId ?? null,
		branch: input.branch ?? null,
		occurredAt: input.occurredAt,
		completion,
		visibility,
	});
	return {
		schema: SYNC_RECORD_SCHEMA,
		version: SYNC_SCHEMA_VERSION,
		kind,
		identity: { ...input.identity },
		sourceId: buildSourceId(input.identity),
		role: input.role,
		textBlocks,
		visibleText,
		textSha256: syncTextSha256(visibleText),
		contentHash,
		project,
		parentSourceId: input.parentSourceId ?? null,
		targetSourceId: input.targetSourceId ?? null,
		branch: input.branch ?? null,
		occurredAt: input.occurredAt,
		completion,
		visibility,
	};
}

/** 修订变化（编辑内容、隐藏/恢复、分支切换）：revision+1，原记录保持不可变。 */
export type SyncRevisionChange = {
	readonly kind?: SyncEventKind;
	readonly occurredAt: string;
	readonly content?: unknown;
	readonly visibility?: SyncVisibility;
	readonly role?: SyncRole;
	readonly completion?: SyncCompletion;
	readonly project?: string | null;
	readonly parentSourceId?: string | null;
	readonly branch?: string | null;
};

export function advanceSyncRevision(record: SyncRecord, change: SyncRevisionChange): SyncRecord {
	const identity: SyncIdentity = { ...record.identity, revision: record.identity.revision + 1 };
	return createSyncRecord({
		kind: change.kind ?? (change.content === undefined ? "visibility" : "message"),
		identity,
		role: change.role ?? record.role,
		content: change.content === undefined ? record.textBlocks : change.content,
		project: change.project === undefined ? record.project : change.project,
		parentSourceId: change.parentSourceId === undefined ? record.parentSourceId : change.parentSourceId,
		targetSourceId: record.sourceId,
		branch: change.branch === undefined ? record.branch : change.branch,
		occurredAt: change.occurredAt,
		completion: change.completion ?? record.completion,
		visibility: change.visibility ?? record.visibility,
	});
}

function isRole(value: unknown): value is SyncRole {
	return value === "user" || value === "assistant";
}

function isCompletion(value: unknown): value is SyncCompletion {
	return value === "completed" || value === "incomplete";
}

function isVisibility(value: unknown): value is SyncVisibility {
	return value === "visible" || value === "hidden";
}

function isEventKind(value: unknown): value is SyncEventKind {
	return value === "message" || value === "visibility";
}

/** 身份类型守卫：validateSyncIdentity 为空即 SyncIdentity。 */
export function isSyncIdentity(value: unknown): value is SyncIdentity {
	return validateSyncIdentity(value).length === 0;
}

/** 可空字符串读取：undefined/null → null；字符串 → 原值；其它类型 → ok:false。 */
function readNullableString(value: unknown): { ok: true; value: string | null } | { ok: false } {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (typeof value === "string") return { ok: true, value };
	return { ok: false };
}

/**
 * 读取队列文件时的严格解析：schema/version 匹配，且派生字段能按身份重新算出。
 * 任一不满足返回 null（调用方按损坏处理并保留文件证据，不静默删除）。
 */
export function parseSyncRecord(value: unknown): SyncRecord | null {
	if (!isRecord(value)) return null;
	if (value.schema !== SYNC_RECORD_SCHEMA || value.version !== SYNC_SCHEMA_VERSION) return null;
	const identity = value.identity;
	if (!isSyncIdentity(identity)) return null;
	const role = value.role;
	if (!isRole(role)) return null;
	const occurredAt = value.occurredAt;
	if (typeof occurredAt !== "string") return null;
	// 缺省字段按默认值读取：旧记录可以没有 kind/visibility/completion/项目/父分支字段。
	const kind = value.kind === undefined ? "message" : value.kind;
	if (!isEventKind(kind)) return null;
	const completion = value.completion === undefined ? "completed" : value.completion;
	if (!isCompletion(completion)) return null;
	const visibility = value.visibility === undefined ? "visible" : value.visibility;
	if (!isVisibility(visibility)) return null;
	const project = readNullableString(value.project);
	const parentSourceId = readNullableString(value.parentSourceId);
	const targetSourceId = readNullableString(value.targetSourceId);
	const branch = readNullableString(value.branch);
	if (!project.ok || !parentSourceId.ok || !targetSourceId.ok || !branch.ok) return null;
	if (!Array.isArray(value.textBlocks)) return null;
	const textBlocks: SyncTextBlock[] = [];
	for (const block of value.textBlocks) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
		textBlocks.push({ type: "text", text: block.text });
	}
	const textSha256 = value.textSha256;
	const contentHash = value.contentHash;
	const sourceId = value.sourceId;
	if (typeof textSha256 !== "string" || typeof contentHash !== "string" || typeof sourceId !== "string") return null;
	try {
		const rebuilt = createSyncRecord({
			kind,
			identity,
			role,
			content: textBlocks,
			project: project.value,
			parentSourceId: parentSourceId.value,
			targetSourceId: targetSourceId.value,
			branch: branch.value,
			occurredAt,
			completion,
			visibility,
		});
		if (rebuilt.sourceId !== sourceId || rebuilt.textSha256 !== textSha256 || rebuilt.contentHash !== contentHash) return null;
		if (value.visibleText !== undefined && rebuilt.visibleText !== value.visibleText) return null;
		return rebuilt;
	} catch {
		return null;
	}
}
