/**
 * 云端记忆本地文件布局（N04）。
 *
 * 所有连接配置、投影给 Pi 扩展的配置/令牌、人格缓存都放在 `userData/cloud-memory/` 下：
 * - 它们是启动/设置数据，不是运行时通信通道（宿主与 Pi 仍只走 stdio JSON-RPC）；
 * - spawn 时把 config 与 data 目录以 env 显式注入 pi 子进程（见 PiProcess.cloudMemoryPaths），
 *   扩展据此在允许根内读取，不去猜用户目录。
 *
 * 单一 owner：路径只在这里推导，Service / IPC / 测试都从这里取，避免三处各拼一次。
 */

import { join } from "node:path";

export type CloudMemoryPaths = {
	dataDir: string;
	/** 宿主侧连接状态 + 加密凭据（只由 TPA 读写）。 */
	connectionFile: string;
	/** 扩展配置快照（只读；连接或开关变化时整份重写）。 */
	configFile: string;
	/** 运行时令牌文件（只含 token；与扩展侧 parseAuthToken 兼容）。 */
	authFile: string;
	/** 扩展观测日志（由 Pi 扩展写入，宿主不读它当运行时状态）。 */
	logFile: string;
	/** 已确认人格缓存（按账号 + 实例隔离，原子替换）。 */
	personaCacheFile: string;
};

export const CLOUD_MEMORY_DIR_NAME = "cloud-memory";

/** 默认关闭的内置扩展入口名：只有用户在设置页明确开关时才登记/撤销。 */
export const CLOUD_MEMORY_EXTENSION_ENTRY = "pi-deck-cloud-memory.ts";

export function resolveCloudMemoryPaths(userDataDir: string): CloudMemoryPaths {
	const dataDir = join(userDataDir, CLOUD_MEMORY_DIR_NAME);
	return {
		dataDir,
		connectionFile: join(dataDir, "connection.json"),
		configFile: join(dataDir, "config.json"),
		authFile: join(dataDir, "auth.json"),
		logFile: join(dataDir, "pi-deck-cloud-memory.log.jsonl"),
		personaCacheFile: join(dataDir, "persona-cache.json"),
	};
}
