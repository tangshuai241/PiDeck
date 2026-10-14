/**
 * 投影给 Pi 扩展的三个文件（N04）：配置快照、运行时令牌、已确认人格缓存。
 *
 * 为什么由宿主写而不是扩展写：
 * - 连接配置与认证属于启动/设置数据，宿主是唯一 writer；扩展只读（N03 契约已冻结）；
 * - 文件是「一次性投影」，不是运行时通道：宿主与 Pi 之间仍只有 stdio JSON-RPC。
 *
 * 边界：
 * - 配置快照是只读的整份快照（不改路径、不做增量合并）；令牌与缓存独立刷新，路径固定；
 * - 令牌文件只含 token（与扩展侧 parseAuthToken 兼容），登出/禁用时删除而不是写空值；
 * - 缓存写盘前必须通过 revision/raw_revision 哈希校验（调用方先调 verifyPersonaSnapshot），
 *   写盘用 tmp + rename 原子替换，并按账号与实例隔离读取。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudMemoryPersonaSnapshot, CloudMemorySyncMode } from "../../shared/types/cloudMemory";
import { renameWithRetry } from "../utils/fsRetry";
import type { CloudMemoryPaths } from "./cloudMemoryPaths";
import { verifyPersonaSnapshot } from "./cloudMemoryValidation";

export type CloudMemoryExtensionConfigSnapshot = {
	baseUrl: string;
	account: string;
	cloudInstanceId: string;
	syncMode: CloudMemorySyncMode;
	/** 个人与项目可见消息都归档的范围开关（由用户在设置页明确打开）。 */
	syncEnabled: boolean;
};

/**
 * 配置快照正文。字段分两类：
 * - 既有字段（enabled/baseUrl/authFile/logFile/mode）保持与 N03 校验器兼容；
 * - 新增字段（account/cloudInstanceId/stateDir/personaCacheFile/syncEnabled）需要 N03/N05
 *   工具侧确认后才被消费，这里先写入以免将来再改一次落盘形状（见 N04 报告的契约变更请求）。
 */
export function buildCloudMemoryExtensionConfigBody(paths: CloudMemoryPaths, snapshot: CloudMemoryExtensionConfigSnapshot, enabled: boolean): Record<string, unknown> {
	return {
		enabled,
		mode: snapshot.syncMode,
		baseUrl: snapshot.baseUrl,
		account: snapshot.account,
		cloudInstanceId: snapshot.cloudInstanceId,
		authFile: paths.authFile,
		logFile: paths.logFile,
		stateDir: paths.dataDir,
		personaCacheFile: paths.personaCacheFile,
		syncEnabled: snapshot.syncEnabled,
	};
}

async function writePrivateFile(filePath: string, content: string): Promise<{ ok: true } | { ok: false; reason: "writeFailed" }> {
	try {
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		const tmp = `${filePath}.${randomUUID()}.tmp`;
		await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
		await renameWithRetry(tmp, filePath);
		return { ok: true };
	} catch {
		return { ok: false, reason: "writeFailed" };
	}
}

export async function writeCloudMemoryExtensionConfig(paths: CloudMemoryPaths, snapshot: CloudMemoryExtensionConfigSnapshot, enabled: boolean): Promise<{ ok: true } | { ok: false; reason: "writeFailed" }> {
	return writePrivateFile(paths.configFile, `${JSON.stringify(buildCloudMemoryExtensionConfigBody(paths, snapshot, enabled), null, 2)}\n`);
}

/**
 * 令牌文件现在带 account/cloudInstanceId 绑定：工具侧会核对它与 config 的同名字段一致，
 * 避免「旧 config A 配新 token B」这种跳账号查询。字段名与 config 快照保持一致，
 * 旧版只读 token 的解析器（pi-deck-cloud-memory-config.parseAuthToken）兼容未知字段。
 */
export async function writeCloudMemoryAuthToken(paths: CloudMemoryPaths, token: string, binding: { account: string; cloudInstanceId: string }): Promise<{ ok: true } | { ok: false; reason: "writeFailed" }> {
	return writePrivateFile(paths.authFile, `${JSON.stringify({ token, account: binding.account, cloudInstanceId: binding.cloudInstanceId }, null, 2)}\n`);
}

/**
 * 一次投影提交：先写令牌（带绑定），再写配置（启用开关），两者任一失败都不得声称成功。
 *
 * 为什么这个顺序且要回滚：config.enabled=true 是「扩展开始工作」的开关，必须等绑定
 * 已就位才翻；config 写失败时删掉刚写的令牌，不把半套绑定留在磁盘上让下一次启动误读。
 */
export async function writeCloudMemoryProjection(paths: CloudMemoryPaths, snapshot: CloudMemoryExtensionConfigSnapshot, token: string | null): Promise<{ ok: true } | { ok: false; reason: "auth" | "config" }> {
	if (token) {
		const auth = await writeCloudMemoryAuthToken(paths, token, { account: snapshot.account, cloudInstanceId: snapshot.cloudInstanceId });
		if (!auth.ok) return { ok: false, reason: "auth" };
	}
	const config = await writeCloudMemoryExtensionConfig(paths, snapshot, true);
	if (!config.ok) {
		if (token) await clearCloudMemoryAuthToken(paths);
		return { ok: false, reason: "config" };
	}
	return { ok: true };
}
/**
 * 停用投影：先写 enabled:false（让扩展立即停止工作），再删令牌（凭证清理）。
 *
 * 为什么这个顺序：删令牌失败时配置已停用，扩展不会继续读；反过来则会出现
 * 「界面显示已关闭、扩展仍在查云端」的最危险状态。两步任一失败都如实回传。
 */
export async function disableCloudMemoryProjection(paths: CloudMemoryPaths, snapshot: CloudMemoryExtensionConfigSnapshot): Promise<{ ok: true } | { ok: false; reason: "auth" | "config" }> {
	const config = await writeCloudMemoryExtensionConfig(paths, snapshot, false);
	if (!config.ok) return { ok: false, reason: "config" };
	const auth = await clearCloudMemoryAuthToken(paths);
	return auth.ok ? { ok: true } : { ok: false, reason: "auth" };
}

/** 登出/禁用后不留活动凭据：删除令牌文件（扩展缺文件即视为未配置）。 */
export async function clearCloudMemoryAuthToken(paths: CloudMemoryPaths): Promise<{ ok: true } | { ok: false }> {
	try {
		await rm(paths.authFile, { force: true });
		return { ok: true };
	} catch {
		return { ok: false };
	}
}

type PersonaCacheFileShape = {
	version: 1;
	account: string;
	cloudInstanceId: string;
	text: string;
	original_text: string;
	enabled: boolean;
	revision: string;
	raw_revision: string;
	updated_at: string | null;
	fetched_at: string;
};

function toCacheFile(snapshot: CloudMemoryPersonaSnapshot): PersonaCacheFileShape {
	return {
		version: 1,
		account: snapshot.account,
		cloudInstanceId: snapshot.cloudInstanceId,
		text: snapshot.text,
		original_text: snapshot.originalText,
		enabled: snapshot.enabled,
		revision: snapshot.revision,
		raw_revision: snapshot.rawRevision,
		updated_at: snapshot.updatedAt,
		fetched_at: snapshot.fetchedAt,
	};
}

function readString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length <= maxLength ? value : null;
}

/** 解析缓存文件；字段不全、哈希不符、账号/实例为空都视为无缓存（离线回默认规则）。 */
export function parseCloudMemoryPersonaCache(raw: unknown): CloudMemoryPersonaSnapshot | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	// 未知 JSON 收窄成 object 后一律用 Reflect 读字段（不用 as 绕过类型）
	const record: object = raw;
	const account = readString(Reflect.get(record, "account"), 128);
	const cloudInstanceId = readString(Reflect.get(record, "cloudInstanceId"), 128);
	const text = readString(Reflect.get(record, "text"), 64 * 1024);
	const originalText = readString(Reflect.get(record, "original_text"), 64 * 1024);
	const revision = readString(Reflect.get(record, "revision"), 128);
	const rawRevision = readString(Reflect.get(record, "raw_revision"), 128);
	const fetchedAt = readString(Reflect.get(record, "fetched_at"), 64);
	const enabled = Reflect.get(record, "enabled");
	if (!account || !cloudInstanceId || text === null || originalText === null || !revision || !rawRevision || !fetchedAt || typeof enabled !== "boolean") return null;
	const updatedAtRaw = Reflect.get(record, "updated_at");
	const snapshot: CloudMemoryPersonaSnapshot = {
		account,
		cloudInstanceId,
		text,
		originalText,
		enabled,
		revision,
		rawRevision,
		updatedAt: readString(updatedAtRaw, 64),
		fetchedAt,
	};
	return verifyPersonaSnapshot(snapshot) ? snapshot : null;
}

/** 写缓存前调用方必须已通过 verifyPersonaSnapshot（这里再校验一次，避免误用）。 */
export async function writeCloudMemoryPersonaCache(paths: CloudMemoryPaths, snapshot: CloudMemoryPersonaSnapshot): Promise<{ ok: true } | { ok: false; reason: "unverified" | "writeFailed" }> {
	if (!verifyPersonaSnapshot(snapshot)) return { ok: false, reason: "unverified" };
	return writePrivateFile(paths.personaCacheFile, `${JSON.stringify(toCacheFile(snapshot), null, 2)}\n`);
}

export async function readCloudMemoryPersonaCache(paths: CloudMemoryPaths): Promise<CloudMemoryPersonaSnapshot | null> {
	try {
		const raw = await readFile(paths.personaCacheFile, "utf8");
		return parseCloudMemoryPersonaCache(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/** 登出/换账号：人格是个人内容，删除缓存而不是留给下一个账号；失败如实回传。 */
export async function clearCloudMemoryPersonaCache(paths: CloudMemoryPaths): Promise<{ ok: true } | { ok: false }> {
	try {
		await rm(paths.personaCacheFile, { force: true });
		return { ok: true };
	} catch {
		return { ok: false };
	}
}
