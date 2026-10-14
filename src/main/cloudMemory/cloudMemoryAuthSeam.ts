/**
 * 云端账号认证复用 seam（P02 待办复用 N04 已连接账号与受保护凭据）。
 *
 * 为什么需要：pi 的凭据只由 CloudMemoryService 持有（加密落盘、whoami 校验、单次重登），
 * 其它主进程域（首个使用方是个人待办）不能自行读 connection.json、不能重新实现登录，
 * 也不能把令牌交给渲染层。这里只定义最小端口：取当前身份快照 + 按该身份换一次会话令牌。
 *
 * 边界：
 * - `lease.token` 只在主进程内使用（HTTP Authorization），不得进入 IPC 返回值、日志或错误 detail；
 * - 身份由 `origin + account + cloudInstanceId` 三者共同构成：地址或账号任一变化即换作用域，
 *   调用方必须用 `sameCloudMemoryAuthIdentity` 复核，不得只比 username；
 * - `stale=true` 表示「身份已切换，本次结果作废」：调用方不得把它显示成用户可见错误；
 * - 记忆总开关关闭不影响本 seam：账号连接存在即可换取令牌（记忆与待办是两个功能开关）。
 */

import type { CloudMemoryErrorInfo } from "../../shared/types/cloudMemory";

export type CloudMemoryAuthSnapshot = {
	/** 规范化 origin（https 或回环 http）。 */
	origin: string;
	account: string;
	cloudInstanceId: string;
	/** 连接设置版本：账号/地址/开关变化时自增，供调用方识别「换了身份」。 */
	configEpoch: number;
};

export type CloudMemoryAuthLease = CloudMemoryAuthSnapshot & {
	/** 会话令牌：只在主进程内传给 HTTP 客户端，绝不外泄。 */
	token: string;
};

export type CloudMemoryAuthLeaseResult = { ok: true; lease: CloudMemoryAuthLease } | { ok: false; stale: boolean; error: CloudMemoryErrorInfo };

export type CloudMemoryAuthPort = {
	/** 当前连接身份（不含凭据）；未配置账号时为 null。 */
	getSnapshot(): CloudMemoryAuthSnapshot | null;
	/** 按调用方持有的身份换一次令牌；身份已变则返回 stale。 */
	acquireLease(expected: CloudMemoryAuthSnapshot): Promise<CloudMemoryAuthLeaseResult>;
};

/** 同一账号作用域判定：origin/account/cloudInstanceId 都必须相同（epoch 不参与）。 */
export function sameCloudMemoryAuthIdentity(a: CloudMemoryAuthSnapshot | null, b: CloudMemoryAuthSnapshot | null): boolean {
	if (!a || !b) return a === b;
	return a.origin === b.origin && a.account === b.account && a.cloudInstanceId === b.cloudInstanceId;
}
