/**
 * pi-deck-cloud-memory-sync-outbox —— N06 本地持久待传队列（每身份独立原子文件）。
 *
 * 设计要点：
 * - 每条记录一个文件 `pending/<source_id>.json`；写入走「同目录临时文件 + fsync + 原子创建/替换」，
 *   Windows 与 POSIX 都尽量用硬链接做独占创建（见 outbox-fs）。
 * - 多进程登记不互相覆盖：独占创建 + 复核；同身份异内容写入 `conflicts/` 保留双方证据。
 * - 登记录入即落盘；未收到逐字段核对的回执前不移除待传副本；确认只删待传副本，不删 Pi 原件/云端原话。
 * - 单发送者用 `sender-lease.json` 租约：token ownership + pid 存活校验；只有证实旧 owner 进程
 *   已死才可接管，绝不把未知或仍存活的 owner 当过期锁抢；释放只允许删自己的 token。
 * - 队列目录按账号 + 云端实例隔离，跨账号登记直接拒绝。
 * - 所有读写限制在 stateDir 内；损坏文件保留为 invalid 证据，不静默删除。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SOURCE_ID_PATTERN, parseSyncRecord } from "./pi-deck-cloud-memory-sync-identity";
import { assertInside, assertSourceId, createExclusiveFile, defaultIsPidAlive, ensureDir, errorCode, isRecord, parseEntry, parseLease, parseReceipt, readTextNoFollow, replaceFileAtomic, safeSegment, type EntryRead, type LeaseRead, type ReceiptRead } from "./pi-deck-cloud-memory-sync-outbox-fs";
import { DEFAULT_LEASE_TTL_MS, DEFAULT_MAX_ENTRY_BYTES, MAX_IDENTITY_FIELD_CHARS, OPEN_BATCH_SCHEMA, SYNC_OUTBOX_RECEIPT_SCHEMA, SYNC_OUTBOX_SCHEMA, SYNC_SCHEMA_VERSION, SyncOutboxError, type SyncAuthState, type SyncListOptions, type SyncListPage, type SyncOpenBatch, type SyncOpenBatchItem, type SyncOpenBatchMode, type SyncOutbox, type SyncOutboxEntry, type SyncOutboxOptions, type SyncOutboxState, type SyncPendingCount, type SyncQueue, type SyncReceipt, type SyncReceiptResult, type SyncRecord, type SyncRegisterResult, type SyncSenderClaim, type SyncSenderLease, type SyncScopeInput } from "./pi-deck-cloud-memory-sync-types";

const OUTBOX_CONFLICT_SCHEMA = "pi-deck-cloud-memory-sync-outbox-conflict";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 分页默认页大小；sender 会显式传更小的 limit。 */
const DEFAULT_LIST_LIMIT = 100;
/** 单次扫描文件数默认上界（含 invalid），避免一页扫完整目录。 */
const DEFAULT_LIST_SCAN = 1000;

function clampListLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_LIST_LIMIT;
	if (!Number.isSafeInteger(value) || value < 1) throw new SyncOutboxError("invalid_input", "limit 必须是正整数");
	return value;
}

function clampMaxScan(value: number | undefined): number {
	if (value === undefined) return DEFAULT_LIST_SCAN;
	if (!Number.isSafeInteger(value) || value < 1) throw new SyncOutboxError("invalid_input", "maxScan 必须是正整数");
	return value;
}

function clampMaxBytes(value: number | undefined): number | null {
	if (value === undefined) return null;
	if (!Number.isSafeInteger(value) || value < 1) throw new SyncOutboxError("invalid_input", "maxBytes 必须是正整数");
	return value;
}

function validateScopeField(name: string, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) throw new SyncOutboxError("invalid_input", `${name} 必须是非空字符串`);
	if (value.length > MAX_IDENTITY_FIELD_CHARS) throw new SyncOutboxError("invalid_input", `${name} 超长`);
	if (CONTROL_CHARS.test(value)) throw new SyncOutboxError("invalid_input", `${name} 含控制字符`);
}

export function createSyncOutbox(options: SyncOutboxOptions): SyncOutbox {
	if (!isAbsolute(options.stateDir)) throw new SyncOutboxError("invalid_input", "stateDir 必须是绝对路径");
	const root = resolve(options.stateDir);
	const now = options.now ?? (() => Date.now());
	const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
	const defaultTtl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const processId = options.processId ?? process.pid;
	const processStartedAt = options.processStartedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const makeToken = options.makeToken ?? (() => randomBytes(16).toString("hex"));
	const iso = (ms: number): string => new Date(ms).toISOString();

	async function open(scope: SyncScopeInput): Promise<SyncQueue> {
		validateScopeField("accountId", scope?.accountId);
		validateScopeField("cloudInstanceId", scope?.cloudInstanceId);
		validateScopeField("deviceId", scope?.deviceId);
		const accountSegment = safeSegment(scope.accountId);
		const instanceSegment = safeSegment(scope.cloudInstanceId);
		const scopeDir = join(root, accountSegment, instanceSegment);
		assertInside(root, scopeDir);
		const pendingDir = join(scopeDir, "pending");
		const receiptsDir = join(scopeDir, "receipts");
		const conflictsDir = join(scopeDir, "conflicts");
		const authFlagPath = join(scopeDir, "auth-blocked.json");
		const leasePath = join(scopeDir, "sender-lease.json");
		const openBatchPath = join(scopeDir, "inflight.json");
		await ensureDir(root);
		await ensureDir(join(root, accountSegment));
		await ensureDir(scopeDir);
		for (const dir of [pendingDir, receiptsDir, conflictsDir]) await ensureDir(dir);

		const entryPath = (sourceId: string): string => join(pendingDir, `${assertSourceId(sourceId)}.json`);
		const receiptPath = (sourceId: string): string => join(receiptsDir, `${assertSourceId(sourceId)}.json`);
		const conflictPath = (sourceId: string, contentHash: string): string => join(conflictsDir, `${assertSourceId(sourceId)}.${contentHash}.json`);

		async function readEntry(sourceId: string): Promise<EntryRead> {
			const path = entryPath(sourceId);
			assertInside(root, path);
			const read = await readTextNoFollow(path, maxEntryBytes);
			if (read.kind !== "ok") return read;
			try {
				const parsed: unknown = JSON.parse(read.text);
				const entry = parseEntry(parsed);
				return entry ? { kind: "ok", entry } : { kind: "invalid", reason: "entry_invalid" };
			} catch {
				return { kind: "invalid", reason: "entry_invalid_json" };
			}
		}

		async function readReceiptDetailed(sourceId: string): Promise<ReceiptRead> {
			const path = receiptPath(sourceId);
			assertInside(root, path);
			const read = await readTextNoFollow(path, maxEntryBytes);
			if (read.kind !== "ok") return read;
			try {
				const raw: unknown = JSON.parse(read.text);
				if (!isRecord(raw)) return { kind: "invalid", reason: "receipt_invalid" };
				if (raw.schema !== undefined && raw.schema !== SYNC_OUTBOX_RECEIPT_SCHEMA) return { kind: "invalid", reason: "receipt_invalid" };
				const receipt = parseReceipt(raw.receipt ?? raw);
				if (!receipt) return { kind: "invalid", reason: "receipt_invalid" };
				// 只有绑定本路径、本队列 scope 且 stored=true 的回执才可当作已落盘证据。
				if (receipt.sourceId !== sourceId) return { kind: "invalid", reason: "receipt_source_mismatch" };
				if (receipt.accountId !== scope.accountId || receipt.cloudInstanceId !== scope.cloudInstanceId) return { kind: "invalid", reason: "receipt_scope_mismatch" };
				if (receipt.stored !== true) return { kind: "invalid", reason: "receipt_not_stored" };
				return { kind: "ok", receipt };
			} catch {
				return { kind: "invalid", reason: "receipt_invalid_json" };
			}
		}

		async function readLease(): Promise<LeaseRead> {
			assertInside(root, leasePath);
			const read = await readTextNoFollow(leasePath, maxEntryBytes);
			if (read.kind !== "ok") return read;
			try {
				const parsed: unknown = JSON.parse(read.text);
				const lease = parseLease(parsed);
				return lease ? { kind: "ok", lease } : { kind: "invalid", reason: "lease_invalid" };
			} catch {
				return { kind: "invalid", reason: "lease_invalid_json" };
			}
		}

		async function updateEntry(entry: SyncOutboxEntry, patch: Partial<SyncOutboxEntry>): Promise<SyncOutboxEntry> {
			const updated: SyncOutboxEntry = { ...entry, ...patch, updatedAt: iso(now()) };
			await replaceFileAtomic(pendingDir, entryPath(entry.record.sourceId), JSON.stringify(updated));
			return updated;
		}

		async function preserveConflict(record: SyncRecord, existing: "pending" | "confirmed" | "conflict"): Promise<SyncRegisterResult> {
			const conflictFile = conflictPath(record.sourceId, record.contentHash);
			assertInside(root, conflictFile);
			await createExclusiveFile(conflictsDir, conflictFile, JSON.stringify({ schema: OUTBOX_CONFLICT_SCHEMA, version: SYNC_SCHEMA_VERSION, detectedAt: iso(now()), existing, record }));
			return { status: "conflict", sourceId: record.sourceId, existing, entry: null, conflictFile };
		}

		function classifyExisting(entry: SyncOutboxEntry, record: SyncRecord): SyncRegisterResult | null {
			const sameContent = entry.record.contentHash === record.contentHash && entry.record.textSha256 === record.textSha256;
			if (!sameContent) return null;
			if (entry.state === "conflict") return { status: "conflict", sourceId: record.sourceId, existing: "conflict", entry };
			return { status: "duplicate", sourceId: record.sourceId, existing: "pending", entry };
		}

		async function register(input: SyncRecord): Promise<SyncRegisterResult> {
			const record = parseSyncRecord(input);
			if (!record) throw new SyncOutboxError("invalid_input", "记录结构不合法");
			// 跨账号/实例拒绝：队列目录绑定账号，防串传。
			if (record.identity.accountId !== scope.accountId || record.identity.cloudInstanceId !== scope.cloudInstanceId) throw new SyncOutboxError("scope_mismatch", "记录账号/实例与队列绑定不一致");
			if (record.identity.deviceId !== scope.deviceId) throw new SyncOutboxError("scope_mismatch", "记录 device 与队列绑定不一致");
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const existing = await readEntry(record.sourceId);
				if (existing.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `待传文件损坏，保留证据：${record.sourceId}`);
				if (existing.kind === "ok") {
					const classified = classifyExisting(existing.entry, record);
					if (classified) return classified;
					return preserveConflict(record, existing.entry.state === "conflict" ? "conflict" : "pending");
				}
				const ack = await readReceiptDetailed(record.sourceId);
				if (ack.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `回执文件损坏，保留证据：${record.sourceId}`);
				if (ack.kind === "ok") {
					if (ack.receipt.contentHash === record.contentHash && ack.receipt.textSha256 === record.textSha256) return { status: "duplicate", sourceId: record.sourceId, existing: "confirmed", entry: null };
					return preserveConflict(record, "confirmed");
				}
				const at = iso(now());
				const blocked = await isAuthBlocked();
				const entry: SyncOutboxEntry = {
					schema: SYNC_OUTBOX_SCHEMA,
					version: SYNC_SCHEMA_VERSION,
					state: blocked ? "auth_blocked" : "pending",
					previousState: blocked ? "pending" : null,
					record,
					attempts: 0,
					createdAt: at,
					updatedAt: at,
					lastAttemptAt: null,
					lastError: null,
					conflictReason: null,
					receipt: null,
				};
				const entryJson = JSON.stringify(entry);
				// 队列 envelope 与 chunk record 的 16MiB 上限不同：超限如实拒绝，不写半条也不丢原件。
				if (Buffer.byteLength(entryJson, "utf8") > maxEntryBytes) throw new SyncOutboxError("entry_too_large", `单条超过队列 ${maxEntryBytes} 字节上限，拒绝登记`);
				const created = await createExclusiveFile(pendingDir, entryPath(record.sourceId), entryJson);
				if (created === "created") return { status: "queued", sourceId: record.sourceId, existing: "none", entry };
			}
			const finalRead = await readEntry(record.sourceId);
			if (finalRead.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `待传文件损坏，保留证据：${record.sourceId}`);
			if (finalRead.kind === "ok") {
				const classified = classifyExisting(finalRead.entry, record);
				if (classified) return classified;
				return preserveConflict(record, "pending");
			}
			throw new SyncOutboxError("fs_error", "登记竞争未能落盘");
		}

		/** 分页读取：按文件名（sourceId）字典序稳定翻页；maxBytes 只截断“还读多少正文”，不加载全队列。 */
		async function listPending(options?: SyncListOptions): Promise<SyncListPage> {
			const limit = clampListLimit(options?.limit);
			const maxBytes = clampMaxBytes(options?.maxBytes);
			const maxScan = clampMaxScan(options?.maxScan);
			const cursor = options?.cursor ?? null;
			if (cursor !== null) assertSourceId(cursor);
			const names: string[] = await fs.readdir(pendingDir).catch((error) => {
				if (errorCode(error) === "ENOENT") return [];
				throw error;
			});
			const files = names.filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
			const entries: SyncOutboxEntry[] = [];
			const invalid: { file: string; reason: string }[] = [];
			let scanned = 0;
			let bytes = 0;
			// nextCursor 以“已扫描文件身份”为准，损坏/超大文件不会让翻页原地打转。
			let lastProcessed: string | null = null;
			let hasMore = false;
			for (let index = 0; index < files.length; index += 1) {
				const name = files[index];
				const sourceId = name.slice(0, -5);
				if (cursor !== null && sourceId <= cursor) continue;
				if (scanned >= maxScan || entries.length >= limit || (maxBytes !== null && bytes >= maxBytes)) {
					hasMore = true;
					break;
				}
				scanned += 1;
				const path = join(pendingDir, name);
				assertInside(root, path);
				let info;
				try {
					info = await fs.lstat(path);
				} catch {
					invalid.push({ file: name, reason: "unreadable" });
					lastProcessed = sourceId;
					continue;
				}
				if (info.isSymbolicLink()) {
					invalid.push({ file: name, reason: "symlink" });
					lastProcessed = sourceId;
					continue;
				}
				if (!info.isFile()) {
					invalid.push({ file: name, reason: "not_regular_file" });
					lastProcessed = sourceId;
					continue;
				}
				if (info.size > maxEntryBytes) {
					invalid.push({ file: name, reason: "too_large" });
					lastProcessed = sourceId;
					continue;
				}
				if (maxBytes !== null && entries.length > 0 && bytes + info.size > maxBytes) {
					hasMore = true;
					break; // 当前文件未处理，nextCursor 停在上一个已处理文件
				}
				const read = await readTextNoFollow(path, maxEntryBytes);
				if (read.kind !== "ok") {
					invalid.push({ file: name, reason: read.kind === "missing" ? "missing" : read.reason });
					lastProcessed = sourceId;
					continue;
				}
				try {
					const parsed: unknown = JSON.parse(read.text);
					const entry = parseEntry(parsed);
					if (entry) {
						entries.push(entry);
						bytes += info.size;
					} else invalid.push({ file: name, reason: "entry_invalid" });
				} catch {
					invalid.push({ file: name, reason: "entry_invalid_json" });
				}
				lastProcessed = sourceId;
			}
			return { entries, invalid, nextCursor: hasMore ? lastProcessed : null, hasMore, scanned };
		}

		/** 全队列计数：只读目录项与 lstat 元信息，不读取任何正文；readdir 非 ENOENT 错误如实上抛。 */
		async function countPending(): Promise<SyncPendingCount> {
			const names: string[] = await fs.readdir(pendingDir).catch((error) => {
				if (errorCode(error) === "ENOENT") return [];
				throw error;
			});
			let count = 0;
			let bytes = 0;
			for (const name of names) {
				if (!name.endsWith(".json") || name.startsWith(".")) continue;
				try {
					const info = await fs.lstat(join(pendingDir, name));
					if (info.isSymbolicLink() || !info.isFile()) continue;
					count += 1;
					bytes += info.size;
				} catch {
					// 元信息读不到就不计入，避免虚报积压。
				}
			}
			return { count, bytes };
		}

		async function markUnknown(sourceId: string, info?: { reason?: string | null }): Promise<SyncOutboxEntry | null> {
			const read = await readEntry(sourceId);
			if (read.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `待传文件损坏，保留证据：${sourceId}`);
			if (read.kind === "missing") return null;
			if (read.entry.state === "conflict") return read.entry;
			return await updateEntry(read.entry, { state: "unknown", previousState: null, attempts: read.entry.attempts + 1, lastAttemptAt: iso(now()), lastError: info?.reason ?? null });
		}

		async function markConflict(sourceId: string, reason: string): Promise<SyncOutboxEntry | null> {
			const read = await readEntry(sourceId);
			if (read.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `待传文件损坏，保留证据：${sourceId}`);
			if (read.kind === "missing") return null;
			return await updateEntry(read.entry, { state: "conflict", conflictReason: reason });
		}

		type ReceiptBinding = { accountId: string; cloudInstanceId: string; sourceId: string; revision: number; contentHash: string; textSha256: string };

		function recordBinding(record: SyncRecord): ReceiptBinding {
			return { accountId: record.identity.accountId, cloudInstanceId: record.identity.cloudInstanceId, sourceId: record.sourceId, revision: record.identity.revision, contentHash: record.contentHash, textSha256: record.textSha256 };
		}

		function compareReceipt(receipt: SyncReceipt, target: ReceiptBinding): string[] {
			const mismatches: string[] = [];
			if (receipt.accountId !== target.accountId) mismatches.push("accountId");
			if (receipt.cloudInstanceId !== target.cloudInstanceId) mismatches.push("cloudInstanceId");
			if (receipt.sourceId !== target.sourceId) mismatches.push("sourceId");
			if (receipt.revision !== target.revision) mismatches.push("revision");
			if (receipt.contentHash !== target.contentHash) mismatches.push("contentHash");
			if (receipt.textSha256 !== target.textSha256) mismatches.push("textSha256");
			return mismatches;
		}

		/** 写回执墓碑前先核对已有回执：损坏/冲突一律不动待传副本；并发写入后复核同一规则。 */
		async function ensureReceiptTombstone(receipt: SyncReceipt): Promise<{ status: "ok" } | { status: "invalid" } | { status: "mismatch"; mismatches: string[] }> {
			const existing = await readReceiptDetailed(receipt.sourceId);
			if (existing.kind === "invalid") return { status: "invalid" };
			if (existing.kind === "ok") {
				const mismatches = compareReceipt(receipt, existing.receipt);
				return mismatches.length > 0 ? { status: "mismatch", mismatches } : { status: "ok" };
			}
			const tombstone = JSON.stringify({ schema: SYNC_OUTBOX_RECEIPT_SCHEMA, version: SYNC_SCHEMA_VERSION, sourceId: receipt.sourceId, confirmedAt: iso(now()), receipt });
			const created = await createExclusiveFile(receiptsDir, receiptPath(receipt.sourceId), tombstone);
			if (created === "created") return { status: "ok" };
			const raced = await readReceiptDetailed(receipt.sourceId);
			if (raced.kind === "invalid") return { status: "invalid" };
			if (raced.kind === "ok") {
				const mismatches = compareReceipt(receipt, raced.receipt);
				return mismatches.length > 0 ? { status: "mismatch", mismatches } : { status: "ok" };
			}
			return { status: "invalid" };
		}

		async function applyReceipt(sourceId: string, rawReceipt: unknown): Promise<SyncReceiptResult> {
			const read = await readEntry(sourceId);
			if (read.kind === "invalid") return { status: "invalid", sourceId, mismatches: [], entry: null };
			const receipt = parseReceipt(rawReceipt);
			if (!receipt || receipt.sourceId !== sourceId) return { status: "invalid", sourceId, mismatches: ["receipt_shape"], entry: read.kind === "ok" ? read.entry : null };
			if (read.kind === "missing") {
				// 待传副本已不存在：只承认与本地已验证回执（绑定本 scope 且 stored=true）逐字段一致的输入。
				const ack = await readReceiptDetailed(sourceId);
				if (ack.kind === "invalid") return { status: "invalid", sourceId, mismatches: [], entry: null };
				if (ack.kind === "missing") return { status: "missing", sourceId, mismatches: [], entry: null };
				const mismatches = compareReceipt(receipt, ack.receipt);
				if (mismatches.length > 0) return { status: "mismatch", sourceId, mismatches, entry: null };
				if (receipt.stored !== true) return { status: "not_stored", sourceId, mismatches: [], entry: null };
				return { status: "confirmed", sourceId, mismatches: [], entry: null };
			}
			const entry = read.entry;
			const mismatches = compareReceipt(receipt, recordBinding(entry.record));
			if (mismatches.length > 0) {
				const conflicted = await updateEntry(entry, { state: "conflict", conflictReason: `receipt_mismatch:${mismatches.join(",")}` });
				return { status: "mismatch", sourceId, mismatches, entry: conflicted };
			}
			if (!receipt.stored) return { status: "not_stored", sourceId, mismatches: [], entry };
			const tombstone = await ensureReceiptTombstone(receipt);
			if (tombstone.status !== "ok") return { status: tombstone.status === "invalid" ? "invalid" : "mismatch", sourceId, mismatches: tombstone.status === "mismatch" ? tombstone.mismatches : [], entry };
			await fs.unlink(entryPath(sourceId)).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			return { status: "confirmed", sourceId, mismatches: [], entry };
		}

		async function isAuthBlocked(): Promise<boolean> {
			return (await getAuthState()).blocked;
		}

		async function getAuthState(): Promise<SyncAuthState> {
			const read = await readTextNoFollow(authFlagPath, maxEntryBytes);
			if (read.kind === "missing") return { blocked: false, reason: null, tokenHash: null };
			if (read.kind === "invalid") return { blocked: true, reason: "auth_flag_unreadable", tokenHash: null };
			try {
				const parsed: unknown = JSON.parse(read.text);
				if (!isRecord(parsed) || parsed.blocked !== true) return { blocked: false, reason: null, tokenHash: null };
				const reason = typeof parsed.reason === "string" ? parsed.reason : null;
				const tokenHash = typeof parsed.tokenHash === "string" ? parsed.tokenHash : null;
				return { blocked: true, reason, tokenHash };
			} catch {
				return { blocked: true, reason: "auth_flag_invalid_json", tokenHash: null };
			}
		}

		async function setAuthBlocked(blocked: boolean, reason?: string | null, tokenHash?: string | null): Promise<number> {
			// auth flag 是整体暂停的权威：blocked 只写标志（O(1)），不逐条读写正文。
			if (blocked) {
				await replaceFileAtomic(scopeDir, authFlagPath, JSON.stringify({ blocked: true, reason: reason ?? null, tokenHash: tokenHash ?? null, updatedAt: iso(now()) }));
				return 0;
			}
			await fs.unlink(authFlagPath).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			// 兼容旧 per-entry auth_blocked：分页恢复，不要求一次全量完成。
			let affected = 0;
			let cursor: string | null = null;
			for (;;) {
				const page = await listPending({ limit: 200, cursor, maxScan: 1000 });
				for (const entry of page.entries) {
					if (entry.state !== "auth_blocked") continue;
					const restored: SyncOutboxState = entry.previousState === "unknown" ? "unknown" : "pending";
					await updateEntry(entry, { state: restored, previousState: null });
					affected += 1;
				}
				if (!page.hasMore || !page.nextCursor) break;
				cursor = page.nextCursor;
			}
			return affected;
		}

		function parseOpenBatch(value: unknown): SyncOpenBatch | null {
			if (!isRecord(value)) return null;
			if (value.schema !== OPEN_BATCH_SCHEMA || value.version !== SYNC_SCHEMA_VERSION) return null;
			const requestId = value.requestId;
			if (typeof requestId !== "string" || !requestId.startsWith("req_")) return null;
			const mode = value.mode;
			if (mode !== "inline" && mode !== "chunk") return null;
			const items = value.items;
			if (!Array.isArray(items) || items.length === 0) return null;
			const parsedItems: SyncOpenBatchItem[] = [];
			for (const item of items) {
				if (!isRecord(item)) return null;
				const sourceId = item.sourceId;
				const contentHash = item.contentHash;
				const revision = item.revision;
				if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) return null;
				if (typeof contentHash !== "string" || contentHash.length === 0) return null;
				if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
				parsedItems.push({ sourceId, contentHash, revision });
			}
			return { schema: OPEN_BATCH_SCHEMA, version: SYNC_SCHEMA_VERSION, requestId, mode, createdAt: typeof value.createdAt === "string" ? value.createdAt : "", items: parsedItems };
		}

		async function beginBatch(envelope: { requestId: string; mode: SyncOpenBatchMode; items: readonly SyncOpenBatchItem[] }): Promise<void> {
			if (typeof envelope.requestId !== "string" || !envelope.requestId.startsWith("req_")) throw new SyncOutboxError("invalid_input", "requestId 形态不合法");
			if (envelope.mode !== "inline" && envelope.mode !== "chunk") throw new SyncOutboxError("invalid_input", "batch mode 不合法");
			if (!Array.isArray(envelope.items) || envelope.items.length === 0) throw new SyncOutboxError("invalid_input", "batch items 不能为空");
			const items: SyncOpenBatchItem[] = [];
			for (const item of envelope.items) {
				const sourceId = assertSourceId(item.sourceId);
				if (typeof item.contentHash !== "string" || item.contentHash.length === 0) throw new SyncOutboxError("invalid_input", "contentHash 不合法");
				if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new SyncOutboxError("invalid_input", "revision 不合法");
				items.push({ sourceId, contentHash: item.contentHash, revision: item.revision });
			}
			const batch: SyncOpenBatch = { schema: OPEN_BATCH_SCHEMA, version: SYNC_SCHEMA_VERSION, requestId: envelope.requestId, mode: envelope.mode, createdAt: iso(now()), items };
			await replaceFileAtomic(scopeDir, openBatchPath, JSON.stringify(batch));
		}

		async function readOpenBatch(): Promise<SyncOpenBatch | null> {
			assertInside(root, openBatchPath);
			const read = await readTextNoFollow(openBatchPath, maxEntryBytes);
			if (read.kind !== "ok") return null;
			try {
				const parsed: unknown = JSON.parse(read.text);
				return parseOpenBatch(parsed);
			} catch {
				return null;
			}
		}

		async function clearOpenBatch(requestId?: string): Promise<boolean> {
			assertInside(root, openBatchPath);
			if (requestId !== undefined) {
				const open = await readOpenBatch();
				if (!open || open.requestId !== requestId) return false;
			}
			await fs.unlink(openBatchPath).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			return true;
		}

		function makeLease(token: string, ttlMs: number): SyncSenderLease {
			const at = now();
			return { token, accountId: scope.accountId, cloudInstanceId: scope.cloudInstanceId, deviceId: scope.deviceId, pid: processId, processStartedAt, createdAt: iso(at), heartbeatAt: iso(at), expiresAt: iso(at + ttlMs) };
		}

		async function claimSender(leaseTtlMs?: number): Promise<SyncSenderClaim> {
			const ttl = leaseTtlMs ?? defaultTtl;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const read = await readLease();
				if (read.kind === "invalid") return { status: "blocked", reason: "unreadable_lease", owner: null };
				if (read.kind === "ok") {
					const owner = read.lease;
					// pid 信息缺失或进程仍存活（含本进程自己的旧 claim）一律不抢。
					if (owner.pid === processId || isPidAlive(owner.pid)) return { status: "blocked", reason: "active_owner", owner };
					const candidate = makeLease(makeToken(), ttl);
					await replaceFileAtomic(scopeDir, leasePath, JSON.stringify(candidate));
					const after = await readLease();
					if (after.kind === "ok" && after.lease.token === candidate.token) return { status: "claimed", lease: candidate };
					return { status: "blocked", reason: "active_owner", owner: after.kind === "ok" ? after.lease : null };
				}
				const candidate = makeLease(makeToken(), ttl);
				const created = await createExclusiveFile(scopeDir, leasePath, JSON.stringify(candidate));
				if (created === "created") return { status: "claimed", lease: candidate };
			}
			const finalRead = await readLease();
			return { status: "blocked", reason: finalRead.kind === "invalid" ? "unreadable_lease" : "active_owner", owner: finalRead.kind === "ok" ? finalRead.lease : null };
		}

		async function renewSender(token: string, leaseTtlMs?: number): Promise<boolean> {
			const read = await readLease();
			if (read.kind !== "ok" || read.lease.token !== token) return false;
			const at = now();
			const renewed: SyncSenderLease = { ...read.lease, heartbeatAt: iso(at), expiresAt: iso(at + (leaseTtlMs ?? defaultTtl)) };
			await replaceFileAtomic(scopeDir, leasePath, JSON.stringify(renewed));
			const after = await readLease();
			return after.kind === "ok" && after.lease.token === token;
		}

		async function releaseSender(token: string): Promise<boolean> {
			const read = await readLease();
			if (read.kind !== "ok" || read.lease.token !== token) return false;
			await fs.unlink(leasePath).catch((error) => {
				if (errorCode(error) !== "ENOENT") throw error;
			});
			return true;
		}

		return {
			accountId: scope.accountId,
			cloudInstanceId: scope.cloudInstanceId,
			deviceId: scope.deviceId,
			dir: scopeDir,
			register,
			listPending,
			countPending,
			beginBatch,
			readOpenBatch,
			clearOpenBatch,
			markUnknown,
			applyReceipt,
			setAuthBlocked,
			isAuthBlocked,
			getAuthState,
			markConflict,
			async readEntry(sourceId: string): Promise<SyncOutboxEntry | null> {
				const read = await readEntry(sourceId);
				if (read.kind === "invalid") throw new SyncOutboxError("existing_corrupt", `待传文件损坏，保留证据：${sourceId}`);
				return read.kind === "ok" ? read.entry : null;
			},
			async readReceipt(sourceId: string): Promise<SyncReceipt | null> {
				const read = await readReceiptDetailed(sourceId);
				return read.kind === "ok" ? read.receipt : null;
			},
			claimSender,
			renewSender,
			releaseSender,
		};
	}

	return { open };
}
