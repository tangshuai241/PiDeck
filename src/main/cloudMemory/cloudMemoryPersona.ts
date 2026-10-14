/**
 * 云端人格 GET 载荷 → 本地缓存快照的纯解析。
 *
 * 为什么独立于 Service：这是「什么算一份可用的人格版本」的判定（字段形状 + 本地复刻的
 * revision/raw_revision 哈希），必须能脱离 fs/网络单测；Service 只负责编排与落盘。
 * Service 仍 re-export 本函数，保持既有调用方与测试的 import 路径不变。
 */

import type { CloudMemoryPersonaSnapshot } from "../../shared/types/cloudMemory";
import { verifyPersonaSnapshot } from "./cloudMemoryValidation";

/** 云端人格 GET 载荷 → 本地缓存快照；字段缺失、类型不符或哈希不符一律返回 null。 */
export function parsePersonaPayload(payload: unknown, account: string, cloudInstanceId: string, fetchedAt: string): CloudMemoryPersonaSnapshot | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const record: object = payload;
	const rawText = Reflect.get(record, "original_text");
	const text = Reflect.get(record, "text");
	const enabled = Reflect.get(record, "enabled");
	const revision = Reflect.get(record, "revision");
	const rawRevision = Reflect.get(record, "raw_revision");
	if (typeof text !== "string" || typeof enabled !== "boolean" || typeof revision !== "string" || typeof rawRevision !== "string") return null;
	const originalText = typeof rawText === "string" ? rawText : text;
	const updatedAtRaw = Reflect.get(record, "updated_at");
	const snapshot: CloudMemoryPersonaSnapshot = {
		account,
		cloudInstanceId,
		text,
		originalText,
		enabled,
		revision,
		rawRevision,
		updatedAt: typeof updatedAtRaw === "string" && !Number.isNaN(Date.parse(updatedAtRaw)) ? updatedAtRaw : null,
		fetchedAt,
	};
	return verifyPersonaSnapshot(snapshot) ? snapshot : null;
}
