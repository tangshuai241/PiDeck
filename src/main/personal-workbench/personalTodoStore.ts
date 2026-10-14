/**
 * 待办本地持久化（P02）：缓存、待传队列（outbox）与已确认台账，按账号分目录、原子写。
 *
 * 为什么独立：这三份文件是「断网/重启后仍保留输入、确认后才清队列」的耐久事实，
 * 读写与损坏兜底必须能脱离 Electron 单测；HTTP、账号切换与调度都不在本模块。
 *
 * 损坏处理（2026-10-14 评审后的硬规则）：
 * - 只有「文件不存在」才能当空；不可读、超字节上界、JSON 损坏、结构或单条非法一律算损坏；
 * - 损坏时不静默丢稿：先把原文件改名隔离（bytes 原样保留），再以空状态继续，并返回结构化 issue
 *   由服务层如实展示；隔离失败（rename 不成功）则**禁止**再写该文件，绝不覆盖原文件；
 * - 枚举（phase/error code/op kind）一律显式校验，不用 `as` 把任意字符串转成合法值；
 * - 写入走 `写 tmp → renameWithRetry 原子替换`（0600/0700），失败返回结构化结果。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersonalTodo, PersonalTodoErrorCode, PersonalTodoErrorInfo, PersonalTodoOperation } from "../../shared/types/personalTodo";
import { renameWithRetry } from "../utils/fsRetry";
import type { PersonalTodoIdentity, PersonalTodoPaths } from "./personalTodoAccount";
import { parsePersonalTodoRequestId, parsePersonalTodoSubmitInput } from "./personalTodoValidation";
import { parseWireTodo } from "./personalTodoWire";

export type PersonalTodoOutboxPhase = "pending" | "sending" | "confirmed" | "conflict" | "unknown" | "error";

const OUTBOX_PHASES: readonly PersonalTodoOutboxPhase[] = ["pending", "sending", "confirmed", "conflict", "unknown", "error"];
const OPERATION_KINDS: readonly PersonalTodoOperation["kind"][] = ["create", "patch", "status", "subtodoAdd", "subtodoPatch", "subtodoStatus"];
const ERROR_CODES: readonly PersonalTodoErrorCode[] = ["notConnected", "invalidInput", "offline", "writeFailed", "cloudRejected", "conflict", "unknownOutcome", "writeUnavailable", "unsupported", "staleAccount", "internalError"];

export type PersonalTodoQueuedOperation = {
	opId: string;
	/** 稳定请求 id：重试复用同一个，不新生成（防盲重复创建）。 */
	requestId: string;
	/** 根项 id；未确认的 create 用本地 id（todo_local_*）。 */
	itemId: string;
	operation: PersonalTodoOperation;
	/** create 专用：稳定业务键，重发时复用（wire client_ref）。 */
	clientRef: string | null;
	/** CAS 基准（整族 revision）；create 为 null。 */
	baseRevision: string | null;
	phase: PersonalTodoOutboxPhase;
	attempts: number;
	lastError: PersonalTodoErrorInfo | null;
	/** conflict 时云端当前 revision（保留草稿供 UI 比对）。 */
	conflictRevision: string | null;
	/** subtodoAdd 本地草稿子项 id：确认后用服务端 sub_id 重映射后续操作。 */
	localSubtodoId: string | null;
	createdAt: string;
	updatedAt: string;
	lastAttemptAt: string | null;
};

export type PersonalTodoLedgerEntry = {
	requestId: string;
	/** 确认后的云端条目 id（create 由服务端生成）。 */
	itemId: string;
	kind: PersonalTodoOperation["kind"];
	revision: string | null;
	confirmedAt: string;
};

export type PersonalTodoCacheFile = { fetchedAt: string | null; cursor: string | null; items: PersonalTodo[] };
export type PersonalTodoOutboxFile = { operations: PersonalTodoQueuedOperation[] };
export type PersonalTodoLedgerFile = { entries: PersonalTodoLedgerEntry[] };

/** 台账上限：只用于「本机上一条写操作确认过」的查询与诊断，不是永久去重键（服务端账才是）。 */
export const PERSONAL_TODO_LEDGER_MAX_ENTRIES = 500;
/** 单文件字节上界：正常队列/缓存远小于此；超限视为损坏，不把整个大文件读进内存。 */
export const PERSONAL_TODO_STORE_MAX_BYTES = 16 * 1024 * 1024;

export type AtomicWriteResult = { ok: true } | { ok: false; reason: "writeFailed" };

/** 损坏/不可读的结构化事实：服务层据此展示并决定是否继续写盘。 */
export type PersonalTodoStoreIssue = {
	code: "missing" | "unreadable" | "tooLarge" | "invalidJson" | "invalidStructure" | "quarantineFailed";
	file: "cache" | "outbox" | "ledger";
	path: string;
	message: string;
	/** 隔离后的原文件路径；隔离失败为 null（此时 blocked=true）。 */
	quarantinePath: string | null;
	/** true = 原文件未被隔离，禁止再写该文件（否则会覆盖未同步输入）。 */
	blocked: boolean;
};

export type PersonalTodoStoreLoad<T> = { value: T; issue: PersonalTodoStoreIssue | null };

/** 原子写 JSON：临时文件与目标同目录（同盘 rename 才是原子的）。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<AtomicWriteResult> {
	try {
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		const tmp = `${filePath}.${randomUUID()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await renameWithRetry(tmp, filePath);
		return { ok: true };
	} catch {
		return { ok: false, reason: "writeFailed" };
	}
}

export type BoundedReadOutcome = { status: "missing" } | { status: "ok"; value: unknown } | { status: "issue"; code: "unreadable" | "tooLarge" | "invalidJson" };

/** 有界读取：先 stat 判大小（不读超限文件），再解析 JSON；三类失败分别如实归类。 */
export async function readJsonBounded(filePath: string, maxBytes: number): Promise<BoundedReadOutcome> {
	let size: number;
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return { status: "issue", code: "unreadable" };
		size = info.size;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? Reflect.get(error, "code") : null;
		if (code === "ENOENT") return { status: "missing" };
		return { status: "issue", code: "unreadable" };
	}
	if (size > maxBytes) return { status: "issue", code: "tooLarge" };
	try {
		const text = await readFile(filePath, "utf8");
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > maxBytes) return { status: "issue", code: "tooLarge" };
		return { status: "ok", value: JSON.parse(text) as unknown };
	} catch {
		return { status: "issue", code: "invalidJson" };
	}
}

/** 隔离损坏文件：原 bytes 原样改名；失败返回 null（调用方必须禁止继续写该文件）。 */
export async function quarantineCorruptFile(filePath: string, suffix: string): Promise<string | null> {
	const target = `${filePath}.corrupt-${suffix}`;
	try {
		await rename(filePath, target);
		return target;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function readCount(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseErrorCode(value: unknown): PersonalTodoErrorCode | null {
	return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value) ? (value as PersonalTodoErrorCode) : null;
}

function parseOperationKind(value: unknown): PersonalTodoOperation["kind"] | null {
	return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value) ? (value as PersonalTodoOperation["kind"]) : null;
}

/** 错误信息持久化形状：只保留 code/message/detail（不含凭据）；非法条目返回 null。 */
function parseStoredError(raw: unknown): PersonalTodoErrorInfo | null {
	if (!isRecord(raw)) return null;
	const code = parseErrorCode(Reflect.get(raw, "code"));
	const message = readText(Reflect.get(raw, "message"), 512);
	if (!code || !message) return null;
	return { code, message };
}

/** 单条队列操作：字段逐个校验，任何一处不合法整条作废（由调用方升级为「文件损坏」）。 */
export function parseQueuedOperation(raw: unknown): PersonalTodoQueuedOperation | null {
	if (!isRecord(raw)) return null;
	const opId = readText(Reflect.get(raw, "opId"), 128);
	const requestId = parsePersonalTodoRequestId(Reflect.get(raw, "requestId"));
	const itemId = readText(Reflect.get(raw, "itemId"), 256);
	if (!opId || !requestId || !itemId) return null;
	const operation = parsePersonalTodoSubmitInput({ operation: Reflect.get(raw, "operation") });
	if (!operation.ok) return null;
	const phaseRaw = Reflect.get(raw, "phase");
	const phase = typeof phaseRaw === "string" && (OUTBOX_PHASES as readonly string[]).includes(phaseRaw) ? (phaseRaw as PersonalTodoOutboxPhase) : null;
	if (!phase) return null;
	const createdAt = readText(Reflect.get(raw, "createdAt"), 64);
	if (!createdAt) return null;
	const lastErrorRaw = Reflect.get(raw, "lastError");
	const lastError = lastErrorRaw === null || lastErrorRaw === undefined ? null : parseStoredError(lastErrorRaw);
	if (lastErrorRaw !== null && lastErrorRaw !== undefined && !lastError) return null;
	return {
		opId,
		requestId,
		itemId,
		operation: operation.input.operation,
		clientRef: readText(Reflect.get(raw, "clientRef"), 128),
		baseRevision: readText(Reflect.get(raw, "baseRevision"), 256),
		phase,
		attempts: readCount(Reflect.get(raw, "attempts")),
		lastError,
		conflictRevision: readText(Reflect.get(raw, "conflictRevision"), 256),
		localSubtodoId: readText(Reflect.get(raw, "localSubtodoId"), 256),
		createdAt,
		updatedAt: readText(Reflect.get(raw, "updatedAt"), 64) ?? createdAt,
		lastAttemptAt: readText(Reflect.get(raw, "lastAttemptAt"), 64),
	};
}

export function parseCacheFile(raw: unknown): PersonalTodoCacheFile | null {
	if (!isRecord(raw)) return null;
	const itemsRaw = Reflect.get(raw, "items");
	if (!Array.isArray(itemsRaw)) return null;
	const items: PersonalTodo[] = [];
	for (const entry of itemsRaw) {
		const parsed = parseWireTodo(entry);
		if (!parsed) return null;
		items.push(parsed);
	}
	return { fetchedAt: readText(Reflect.get(raw, "fetchedAt"), 64), cursor: readText(Reflect.get(raw, "cursor"), 512), items };
}

export function parseLedgerEntry(raw: unknown): PersonalTodoLedgerEntry | null {
	if (!isRecord(raw)) return null;
	const requestId = parsePersonalTodoRequestId(Reflect.get(raw, "requestId"));
	const itemId = readText(Reflect.get(raw, "itemId"), 256);
	const kind = parseOperationKind(Reflect.get(raw, "kind"));
	const confirmedAt = readText(Reflect.get(raw, "confirmedAt"), 64);
	if (!requestId || !itemId || !kind || !confirmedAt) return null;
	return { requestId, itemId, kind, revision: readText(Reflect.get(raw, "revision"), 256), confirmedAt };
}

export function parseOutboxFile(raw: unknown): PersonalTodoOutboxFile | null {
	if (!isRecord(raw)) return null;
	const rawOperations = Reflect.get(raw, "operations");
	if (!Array.isArray(rawOperations)) return null;
	const operations: PersonalTodoQueuedOperation[] = [];
	const seen = new Set<string>();
	for (const entry of rawOperations) {
		const parsed = parseQueuedOperation(entry);
		if (!parsed) return null;
		if (seen.has(parsed.requestId)) return null;
		seen.add(parsed.requestId);
		operations.push(parsed);
	}
	return { operations };
}

export function parseLedgerFile(raw: unknown): PersonalTodoLedgerFile | null {
	if (!isRecord(raw)) return null;
	const rawEntries = Reflect.get(raw, "entries");
	if (!Array.isArray(rawEntries)) return null;
	const entries: PersonalTodoLedgerEntry[] = [];
	const seen = new Set<string>();
	for (const entry of rawEntries) {
		const parsed = parseLedgerEntry(entry);
		if (!parsed) return null;
		if (seen.has(parsed.requestId)) continue;
		seen.add(parsed.requestId);
		entries.push(parsed);
	}
	return { entries: entries.slice(-PERSONAL_TODO_LEDGER_MAX_ENTRIES) };
}

/** 台账追加（去重 + FIFO 上限）；返回新数组，不原地改。 */
export function appendLedgerEntry(entries: PersonalTodoLedgerEntry[], entry: PersonalTodoLedgerEntry): PersonalTodoLedgerEntry[] {
	const next = entries.filter((item) => item.requestId !== entry.requestId);
	next.push(entry);
	return next.slice(-PERSONAL_TODO_LEDGER_MAX_ENTRIES);
}

export type PersonalTodoAccountStoreDeps = {
	paths: PersonalTodoPaths;
	maxBytes?: number;
	/** 隔离文件名后缀（默认时间戳）；测试注入固定值以便断言。 */
	now?: () => Date;
};

/** 每个账号一套文件的读写入口；所有方法都不抛（结构性失败返回默认值/issue）。 */
export class PersonalTodoAccountStore {
	private readonly paths: PersonalTodoPaths;
	private readonly maxBytes: number;
	private readonly now: () => Date;
	/** 隔离失败的文件：禁止再写（宁可拒绝写入，也不覆盖未同步输入）。 */
	private readonly blockedFiles = new Set<string>();

	constructor(deps: PersonalTodoAccountStoreDeps) {
		this.paths = deps.paths;
		this.maxBytes = deps.maxBytes && deps.maxBytes > 0 ? deps.maxBytes : PERSONAL_TODO_STORE_MAX_BYTES;
		this.now = deps.now ?? (() => new Date());
	}

	private quarantineSuffix(): string {
		return this.now().toISOString().replace(/[:.]/g, "-");
	}

	/** 损坏处理：隔离原文件；隔离不成则标记禁止写该文件。 */
	private async handleCorrupt(file: "cache" | "outbox" | "ledger", path: string, code: PersonalTodoStoreIssue["code"]): Promise<PersonalTodoStoreIssue> {
		const quarantinePath = await quarantineCorruptFile(path, this.quarantineSuffix());
		if (!quarantinePath) this.blockedFiles.add(path);
		const message = quarantinePath ? "本地待办文件损坏，原文件已隔离保留，未同步输入需人工核对" : "本地待办文件损坏且无法隔离，已暂停写入以保留原文件";
		return { code, file, path, message, quarantinePath, blocked: quarantinePath === null };
	}

	private async readValidated(file: "cache" | "outbox" | "ledger", path: string): Promise<{ kind: "missing" } | { kind: "ok"; value: unknown } | { kind: "issue"; issue: PersonalTodoStoreIssue }> {
		const outcome = await readJsonBounded(path, this.maxBytes);
		if (outcome.status === "missing") return { kind: "missing" };
		if (outcome.status === "issue") return { kind: "issue", issue: await this.handleCorrupt(file, path, outcome.code) };
		return { kind: "ok", value: outcome.value };
	}

	async loadCache(): Promise<PersonalTodoStoreLoad<PersonalTodoCacheFile>> {
		const empty: PersonalTodoCacheFile = { fetchedAt: null, cursor: null, items: [] };
		const read = await this.readValidated("cache", this.paths.cacheFile);
		if (read.kind === "missing") return { value: empty, issue: null };
		if (read.kind === "issue") return { value: empty, issue: read.issue };
		const parsed = parseCacheFile(read.value);
		if (!parsed) return { value: empty, issue: await this.handleCorrupt("cache", this.paths.cacheFile, "invalidStructure") };
		return { value: parsed, issue: null };
	}

	async saveCache(data: PersonalTodoCacheFile): Promise<AtomicWriteResult> {
		return this.save(this.paths.cacheFile, { version: 1, ...data });
	}

	async loadOutbox(): Promise<PersonalTodoStoreLoad<PersonalTodoOutboxFile>> {
		const empty: PersonalTodoOutboxFile = { operations: [] };
		const read = await this.readValidated("outbox", this.paths.outboxFile);
		if (read.kind === "missing") return { value: empty, issue: null };
		if (read.kind === "issue") return { value: empty, issue: read.issue };
		const parsed = parseOutboxFile(read.value);
		if (!parsed) return { value: empty, issue: await this.handleCorrupt("outbox", this.paths.outboxFile, "invalidStructure") };
		return { value: parsed, issue: null };
	}

	async saveOutbox(data: PersonalTodoOutboxFile): Promise<AtomicWriteResult> {
		return this.save(this.paths.outboxFile, { version: 1, operations: data.operations });
	}

	async loadLedger(): Promise<PersonalTodoStoreLoad<PersonalTodoLedgerFile>> {
		const empty: PersonalTodoLedgerFile = { entries: [] };
		const read = await this.readValidated("ledger", this.paths.ledgerFile);
		if (read.kind === "missing") return { value: empty, issue: null };
		if (read.kind === "issue") return { value: empty, issue: read.issue };
		const parsed = parseLedgerFile(read.value);
		if (!parsed) return { value: empty, issue: await this.handleCorrupt("ledger", this.paths.ledgerFile, "invalidStructure") };
		return { value: parsed, issue: null };
	}

	async saveLedger(data: PersonalTodoLedgerFile): Promise<AtomicWriteResult> {
		return this.save(this.paths.ledgerFile, { version: 1, entries: data.entries });
	}

	/** 非密钥身份快照（调试与目录自解释用；凭据仍只在 cloudMemory 的加密连接文件里）。 */
	async saveIdentity(identity: PersonalTodoIdentity, accountKey: string): Promise<AtomicWriteResult> {
		return writeJsonAtomic(this.paths.identityFile, { version: 1, ...identity, accountKey, updatedAt: this.now().toISOString() });
	}

	private async save(path: string, value: unknown): Promise<AtomicWriteResult> {
		if (this.blockedFiles.has(path)) return { ok: false, reason: "writeFailed" };
		return writeJsonAtomic(path, value);
	}
}
