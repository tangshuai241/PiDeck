/**
 * CloudMemoryService 的注入契约与提交结果类型。
 *
 * 为什么独立：这些形状是「装配层对 Service 的承诺」（注入什么、成功/失败/作废怎么表达），
 * 与 Service 的编排逻辑分开后，装配与测试都能只依赖类型而不读实现；Service 仍 re-export，
 * 既有 import 路径不变。
 */

import type { CloudMemoryErrorInfo, CloudMemoryStatus } from "../../shared/types/cloudMemory";
import type { CloudMemoryPaths } from "./cloudMemoryPaths";
import type { CloudMemoryClient } from "./cloudMemoryClient";
import type { CloudMemoryStore } from "./cloudMemoryStore";

export type CloudMemoryServiceDeps = {
	paths: CloudMemoryPaths;
	store: CloudMemoryStore;
	client: CloudMemoryClient;
	/** Pi 扩展是否已登记在 enabledBuiltInExtensions（默认关闭的内置扩展，只在用户明确开启时登记）。 */
	isPiExtensionEnabled: () => boolean;
	/** 写入 enabledBuiltInExtensions（唯一自动改设置的入口，且只由用户开关触发）。 */
	setPiExtensionEnabled: (enabled: boolean) => Promise<void>;
	now?: () => Date;
	log?: (message: string, details?: Record<string, unknown>) => void;
	/** 可见状态变化推送（main/index.ts 接 IPC；未注入时只走拉取）。 */
	onStatusChanged?: () => void;
	/** 后台刷新周期与节流窗口（测试注入小值）。 */
	personaRefreshIntervalMs?: number;
};

/** spawn 投影：路径 + 身份指纹输入（身份变化必须让 standby 池废掉旧进程）。 */
export type CloudMemorySpawnProfile = {
	configPath: string;
	dataDir: string;
	identity: string;
};

export type CloudMemoryConnectOutcome = { ok: true; status: CloudMemoryStatus } | { ok: false; error: CloudMemoryErrorInfo };

export type CommitSuccess<T> = { ok: true; value: T };
export type CommitFailure = { ok: false; error: CloudMemoryErrorInfo };
/** `stale=true` 表示「意图已变，结果作废」：调用方不得把它显示成用户可见错误。 */
export type CommitOutcome<T> = CommitSuccess<T> | (CommitFailure & { stale: boolean });

export function errorInfo(code: CloudMemoryErrorInfo["code"], message: string, detail?: CloudMemoryErrorInfo["detail"]): CloudMemoryErrorInfo {
	return detail ? { code, message, detail } : { code, message };
}
