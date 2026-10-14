/**
 * 待办账号作用域与本地文件布局（P02）。
 *
 * 隔离键固定为 `origin + cloudInstanceId + account`：
 * - 只用 username：同一账号换实例（地址/端口）会复用旧缓存与旧队列；
 * - 只用实例：多账号共用一个实例会串数据。
 * 因此缓存与待传队列按 `accountKey = sha256(origin|instance|account)` 分目录，切账号不共享任何文件。
 *
 * 边界：本模块只做纯身份运算与路径推导；身份文件（account.json）只保留非密钥字段，
 * 凭据仍由 cloudMemory 的加密连接文件持有，待办域不读也不写任何令牌。
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export type PersonalTodoIdentity = {
	origin: string;
	account: string;
	cloudInstanceId: string;
};

/** 稳定隔离键；截断到 40 hex 足够避免碰撞，也让目录名可读。 */
export function personalTodoAccountKey(identity: PersonalTodoIdentity): string {
	return createHash("sha256").update(`${identity.origin}\u0000${identity.cloudInstanceId}\u0000${identity.account}`, "utf8").digest("hex").slice(0, 40);
}

/** 同一账号判定（不比较 configEpoch：epoch 变只说明设置改过，身份未变时缓存仍可用）。 */
export function samePersonalTodoIdentity(a: PersonalTodoIdentity | null, b: PersonalTodoIdentity | null): boolean {
	if (!a || !b) return a === b;
	return a.origin === b.origin && a.account === b.account && a.cloudInstanceId === b.cloudInstanceId;
}

export type PersonalTodoPaths = {
	accountDir: string;
	identityFile: string;
	cacheFile: string;
	outboxFile: string;
	ledgerFile: string;
};

/** 目录布局：`userData/personal-todos/<accountKey>/`；每个账号一个子目录，互不写入。 */
export function resolvePersonalTodoPaths(userDataDir: string, accountKey: string): PersonalTodoPaths {
	const accountDir = join(userDataDir, "personal-todos", accountKey);
	return {
		accountDir,
		identityFile: join(accountDir, "account.json"),
		cacheFile: join(accountDir, "cache.json"),
		outboxFile: join(accountDir, "outbox.json"),
		ledgerFile: join(accountDir, "ledger.json"),
	};
}

function readBoundedString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

/** 宽容读取身份文件：缺字段/损坏条目一律作废（不用半个身份去取缓存）。 */
export function parsePersonalTodoStoredIdentity(raw: unknown): PersonalTodoIdentity | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record: object = raw;
	const origin = readBoundedString(Reflect.get(record, "origin"), 2048);
	const account = readBoundedString(Reflect.get(record, "account"), 128);
	const cloudInstanceId = readBoundedString(Reflect.get(record, "cloudInstanceId"), 128);
	if (!origin || !account || !cloudInstanceId) return null;
	return { origin, account, cloudInstanceId };
}
