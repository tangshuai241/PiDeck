import { createHash } from "node:crypto";

/**
 * standby 池复用判定指纹（纯函数，可单测）。
 *
 * 池化进程在 spawn 时快照全部「会影响 spawn 参数」的输入；claim 时重算并比对，
 * 不一致即废弃池化进程、回退正常创建——这样设置/扩展/桥可用性变化天然触发
 * 「下次 spawn 生效」，不需要热更（这些输入本来也只能在 spawn 时注入）。
 * 字段必须覆盖 PiProcessSettings 与 spawn env 的全部来源（见 AgentManager.computeStandbyFingerprintFor）。
 */

export interface StandbyFingerprintInput {
	projectPath: string;
	/** 非交互信任判定通过的标记（脏项目未决策时根本不生成指纹，即不池化）。 */
	trustMarker: string;
	piCliPath?: string;
	offline: boolean;
	noExtensions: boolean;
	noSkills: boolean;
	piProxyEnabled: boolean;
	piProxyUrl: string;
	piProxyBypass: string;
	disabledExtensions: string[];
	disabledSkills: string[];
	disabledPrompts: string[];
	/** 解析后的 -e 注入扩展绝对路径列表（已含 removed/enabled/项目级覆盖语义）。 */
	extensionRoots: string[];
	/** WSL 模式时 cwd/distro/user 都会进 spawn 命令行。 */
	wsl?: { distro: string; user: string; projectPath: string };
	/** 桥可用性与端口会影响注入子进程的 PIDECK_BRIDGE_URL/TOKEN。 */
	bridgeAvailable: boolean;
	bridgeUrl: string;
	autoSessionTitle: boolean;
	/** 云端记忆身份（账号/实例/启用/范围；与路径无关但同样只能在 spawn 时确定）。 */
	cloudMemoryIdentity?: string;
}

export function computeStandbyFingerprint(input: StandbyFingerprintInput): string {
	const normalized = {
		projectPath: input.projectPath,
		trustMarker: input.trustMarker,
		piCliPath: input.piCliPath ?? null,
		offline: input.offline,
		noExtensions: input.noExtensions,
		noSkills: input.noSkills,
		piProxyEnabled: input.piProxyEnabled,
		piProxyUrl: input.piProxyUrl,
		piProxyBypass: input.piProxyBypass,
		disabledExtensions: [...input.disabledExtensions].sort(),
		disabledSkills: [...input.disabledSkills].sort(),
		disabledPrompts: [...input.disabledPrompts].sort(),
		extensionRoots: [...input.extensionRoots].sort(),
		wsl: input.wsl ?? null,
		bridgeAvailable: input.bridgeAvailable,
		bridgeUrl: input.bridgeUrl,
		autoSessionTitle: input.autoSessionTitle,
		cloudMemoryIdentity: input.cloudMemoryIdentity ?? "",
	};
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
