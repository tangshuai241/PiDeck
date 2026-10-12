/**
 * 基稿选择、授权与修改范围纯策略（无 IO，可直接单测）。
 *
 * 规则来源（docs/tpa-document-work-v1.md 第 4、6 节）：
 * - 下一轮默认基稿取「本件工作最近成功归档、文件可读取、所需检查通过」的版本；
 * - failed / unverified 不是合格基稿，只有用户显式指定才可使用；
 * - 缺可用基稿、多个候选主文件或范围冲突时返回歧义，让调用方去澄清；
 * - 手工修改版只有在归属唯一且不与范围冲突时才自动接续。
 */
import { isUsableAsBase, sectionReferenceMatches } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentWorkBase, DocumentWorkScope } from "../../shared/types/documentWork";

export type BaseAmbiguityReason = "no_usable_base" | "unreadable_base" | "scope_conflict" | "multiple_primary" | "ambiguous_manual";

export type BaseSelection = { kind: "create" } | { kind: "selected"; version: DocumentArtifactVersion; origin: "archived" | "external_manual"; fileDigest: string } | { kind: "ambiguous"; reason: BaseAmbiguityReason };

export type DiscoveredArtifact = { relativePath: string; digest: string; role: DocumentArtifactVersion["artifacts"][number]["role"] };

export type BaseReconciliation = { kind: "unchanged"; version: DocumentArtifactVersion; fileDigest: string } | { kind: "adopted"; version: DocumentArtifactVersion; fileDigest: string } | { kind: "ambiguous"; reason: BaseAmbiguityReason };

export function primaryArtifacts(version: Pick<DocumentArtifactVersion, "artifacts">) {
	return version.artifacts.filter((artifact) => artifact.role === "primary");
}

/**
 * 选择本轮基稿。`explicitVersionId` 来自用户明确指定，优先于自动规则，
 * 但仍要求文件实际可读（可读性由调用方通过 `readableDigest` 传入）。
 */
export function selectBaseVersion(input: { kind: "create_document" | "revise_document"; versions: readonly DocumentArtifactVersion[]; explicitVersionId?: string; readableDigest?: (versionId: string, relativePath: string) => string | undefined }): BaseSelection {
	const readableDigest = input.readableDigest ?? (() => undefined);
	if (input.explicitVersionId) {
		const explicit = input.versions.find((version) => version.versionId === input.explicitVersionId);
		if (!explicit) return { kind: "ambiguous", reason: "no_usable_base" };
		const artifact = primaryArtifacts(explicit);
		if (artifact.length !== 1) return { kind: "ambiguous", reason: "multiple_primary" };
		const digest = readableDigest(explicit.versionId, artifact[0].relativePath);
		if (!digest) return { kind: "ambiguous", reason: "unreadable_base" };
		return { kind: "selected", version: explicit, origin: "archived", fileDigest: digest };
	}
	// 只有通过检查的版本能自动成为基稿；unverified 需要用户显式指定。
	const usable = input.versions.filter((version) => isUsableAsBase(version.inspection));
	if (usable.length === 0) return input.kind === "create_document" && input.versions.length === 0 ? { kind: "create" } : { kind: "ambiguous", reason: "no_usable_base" };
	const latest = usable.reduce((left, right) => (right.ordinal > left.ordinal ? right : left));
	const artifacts = primaryArtifacts(latest);
	if (artifacts.length !== 1) return { kind: "ambiguous", reason: "multiple_primary" };
	const digest = readableDigest(latest.versionId, artifacts[0].relativePath);
	if (!digest) return { kind: "ambiguous", reason: "unreadable_base" };
	return { kind: "selected", version: latest, origin: "archived", fileDigest: digest };
}

/**
 * 观察到的文件指纹与归档记录不一致时的接续判定。
 * 只有「该版本是最新版 + 恰好一个主文件变化 + 其他文件未动 + 新文件可读」才自动接续。
 */
export function reconcileObservedBase(input: { version: DocumentArtifactVersion; isLatestVersion: boolean; observedFileDigest?: string; changedArtifactPaths: readonly string[]; recordedDigest: string; adoptable: boolean }): BaseReconciliation {
	if (!input.observedFileDigest) return { kind: "ambiguous", reason: "unreadable_base" };
	if (input.observedFileDigest === input.recordedDigest) return { kind: "unchanged", version: input.version, fileDigest: input.observedFileDigest };
	if (!input.isLatestVersion) return { kind: "ambiguous", reason: "ambiguous_manual" };
	if (input.changedArtifactPaths.length !== 1) return { kind: "ambiguous", reason: "ambiguous_manual" };
	if (!input.adoptable) return { kind: "ambiguous", reason: "ambiguous_manual" };
	return { kind: "adopted", version: input.version, fileDigest: input.observedFileDigest };
}

/** 声明的章节引用必须在基稿标题中存在；否则属于范围冲突，先澄清再制作。 */
export function validateScopeAgainstHeadings(scope: DocumentWorkScope, headings: readonly string[]): { ok: true } | { ok: false; missing: string[] } {
	const missing = scope.sections.filter((section) => !sectionReferenceMatches(section, headings));
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function toWorkBase(version: DocumentArtifactVersion, fileDigest: string, frozenPath: string, fileName: string, origin: "archived" | "external_manual"): DocumentWorkBase {
	return { versionId: version.versionId, ordinal: version.ordinal, digest: fileDigest, fileName, frozenPath, origin };
}

/** 改稿只能挂在已有成果上；新建只在没有可用成果时成立。 */
export function kindConflictsWithHistory(kind: "create_document" | "revise_document", versions: readonly DocumentArtifactVersion[]): boolean {
	if (kind === "revise_document") return versions.length === 0;
	return versions.length > 0;
}
