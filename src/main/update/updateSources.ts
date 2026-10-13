/**
 * 更新源（GitHub Release 镜像）配置 —— 主进程侧编排逻辑。
 *
 * 纯数据与拼接规则在 shared/updateSources.ts（主/渲染共用同一份清单，UI 展示与
 * feed URL 生成自动同步）；本文件只保留需要主进程侧的归一化与查询函数。
 */

import type { UpdateSourceId } from "../../shared/types/settings";
import { normalizeCustomMirrorHost } from "../../shared/updateSources";

export { normalizeCustomMirrorHost }; // 再导出，供调用点单一来源

/** 校验设置里的更新源 id 是否已知；未知值回退 atomgit。 */
export function normalizeUpdateSource(source: unknown): UpdateSourceId {
	const id = typeof source === "string" ? (source as UpdateSourceId) : "atomgit";
	return id === "atomgit" || id === "github" ? id : "atomgit";
}

/** 应用安装包固定来自 fork，null 选择 createAutoUpdater 的 GitHub provider。 */
export function updateSourceFeedUrl(_source: UpdateSourceId, _customHost?: string | null): string | null {
	// 应用安装包只来自 TPA 自己的 GitHub 发布；上游 AtomGit 镜像仍可用于 Pi/DSH 与资源更新。
	return null;
}

/** macOS 应用检查固定使用 fork 发布页，不受上游资源镜像设置影响。 */
export function updateSourceLatestReleaseUrl(_source: UpdateSourceId, _customHost?: string | null): string | null {
	// null 让 macOS 检查器使用 releaseRepo 中的 fork 发布页。
	return null;
}
