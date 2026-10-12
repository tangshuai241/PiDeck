/**
 * TPA 独立文稿：基稿选择与修改范围的纯策略。
 *
 * 这里只有决策，没有 IO：输入是已归档版本列表、当前磁盘指纹和修改范围，
 * 输出是"用哪个基稿""是否手改接续""允许/未授权变化"的判定。把这些规则写成纯函数
 * 是为了能离开 Electron、pi 和真实文件系统单独断言（见 tests/documentRevisionPolicy.test.mjs）。
 *
 * 三条产品规则：
 * 1. 默认基稿是最近"检查通过且文件可读"的版本——不是目录里最新的文件；
 * 2. 手工改过成果文件时，只在归属唯一且无范围冲突时自动接续，否则返回歧义让用户澄清；
 * 3. 检查失败/未验证的版本保留，但不会被自动选为基稿。
 */
import { workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type { DocumentArtifactVersion, DocumentChangeScope, DocumentInspectionStatus, DocumentBaseSelection } from "../../shared/types/documentWork";

export type BaseSelectionInput = {
	/** 本件工作已归档的版本（按 ordinal 升序）。 */
	versions: readonly DocumentArtifactVersion[];
	/** 当前磁盘上某相对路径的指纹；文件缺失返回 undefined。 */
	readCurrentDigest: (relativePath: string) => string | undefined;
	/** 用户显式指定的历史版本。 */
	explicitVersionId?: string;
};

export type BaseSelection = {
	base: DocumentBaseSelection;
	/** 归档后原文件被外部改动，本轮以新的手工修改版接续。 */
	handEdited: boolean;
	/** 需要写入登记的说明（手改接续时给出），供归档与界面提示。 */
	note?: string;
};

/** 版本是否可作为默认基稿：检查通过、有可读产物、不是"仅存在证据"条目。 */
export function isEligibleBase(version: DocumentArtifactVersion): boolean {
	if (version.inspection.status !== "passed") return false;
	const primary = version.artifacts[0];
	return Boolean(primary && !primary.existenceOnly);
}

function primaryArtifact(version: DocumentArtifactVersion): DocumentArtifactVersion["artifacts"][number] {
	return version.artifacts[0];
}

/**
 * 可编辑源稿与正文脱节检测：源稿被改而正文没变（或反之）说明这一版的两个文件
 * 不再对应当前内容。此时不能沿用旧源稿去覆盖正文，必须让用户澄清以哪份为准。
 */
function sourceDrift(version: DocumentArtifactVersion, readCurrentDigest: (relativePath: string) => string | undefined): string | undefined {
	for (const source of version.editableSources) {
		if (source.existenceOnly) continue;
		const current = readCurrentDigest(source.relativePath);
		if (current !== undefined && current !== source.sha256) return source.relativePath;
	}
	return undefined;
}

/** 检查结论是否允许把这一版当作下一轮基稿（用户显式指定时放宽到任意已归档版本）。 */
function selectionFromVersion(version: DocumentArtifactVersion, input: { explicit: boolean; handEdited: boolean; sha256: string; bytes: number }): DocumentBaseSelection {
	return {
		versionId: version.versionId,
		artifactId: `${version.versionId}:${primaryArtifact(version).relativePath}`,
		relativePath: primaryArtifact(version).relativePath,
		sha256: input.sha256,
		bytes: input.bytes,
		explicit: input.explicit,
		handEdited: input.handEdited,
	};
}

/**
 * 确定本轮基稿。
 *
 * - 用户显式指定版本时优先采用（即使该版检查未通过，用户仍可基于它继续改）；
 *   指定了不存在/不可读的版本返回 `BASE_AMBIGUOUS`，不去猜"最接近"的那版。
 * - 否则取最近一版检查通过的；都没有则返回 `BASE_AMBIGUOUS`。
 * - 目标文件当前指纹与归档记录不一致时，尝试手改接续（见 `continueFromHandEdit`）。
 */
export function selectBaseVersion(input: BaseSelectionInput): WorkResult<BaseSelection> {
	if (input.versions.length === 0) return workFail("BASE_AMBIGUOUS", false, { detail: "this work has no archived version yet" });
	if (input.explicitVersionId) {
		const explicit = input.versions.find((version) => version.versionId === input.explicitVersionId);
		if (!explicit) return workFail("BASE_AMBIGUOUS", false, { detail: "the requested version does not belong to this work" });
		const artifact = primaryArtifact(explicit);
		const current = input.readCurrentDigest(artifact.relativePath);
		if (current === undefined) return workFail("BASE_CHANGED", false, { detail: "the requested version's file is missing or unreadable" });
		if (artifact.existenceOnly) return workFail("BASE_AMBIGUOUS", false, { detail: "the requested version only recorded file existence" });
		if (current !== artifact.sha256) {
			const continued = continueFromHandEdit({ versions: [explicit], readCurrentDigest: input.readCurrentDigest });
			if ("error" in continued) return continued;
			return workOk(continued.value);
		}
		const drifted = sourceDrift(explicit, input.readCurrentDigest);
		if (drifted) return workFail("BASE_AMBIGUOUS", false, { detail: `the editable source ${drifted} changed while the deliverable did not; clarify which content wins` });
		return workOk({ base: selectionFromVersion(explicit, { explicit: true, handEdited: false, sha256: artifact.sha256, bytes: artifact.bytes }), handEdited: false });
	}
	const eligible = input.versions.filter(isEligibleBase);
	if (eligible.length === 0) return workFail("BASE_AMBIGUOUS", false, { detail: "no archived version passed inspection" });
	const latest = [...eligible].sort((left, right) => right.ordinal - left.ordinal)[0];
	const artifact = primaryArtifact(latest);
	const current = input.readCurrentDigest(artifact.relativePath);
	if (current === undefined) return workFail("BASE_CHANGED", false, { detail: "the latest usable version's file is missing or unreadable" });
	if (current !== artifact.sha256) {
		const continued = continueFromHandEdit({ versions: [latest], readCurrentDigest: input.readCurrentDigest });
		if ("error" in continued) return continued;
		return workOk(continued.value);
	}
	const drifted = sourceDrift(latest, input.readCurrentDigest);
	if (drifted) return workFail("BASE_AMBIGUOUS", false, { detail: `the editable source ${drifted} changed while the deliverable did not; clarify which content wins` });
	return workOk({ base: selectionFromVersion(latest, { explicit: false, handEdited: false, sha256: artifact.sha256, bytes: artifact.bytes }), handEdited: false });
}

/**
 * 手工修改接续：归档后用户在成果目录里改了文件。
 *
 * 归属唯一才自动接续——只有最新版本的正文产物变了；若同时有多个文件变化、
 * 或变的是"可编辑源稿"而正文产物未变（说明源稿与正文已经脱节），
 * 返回 `BASE_AMBIGUOUS`，由用户澄清要以哪份内容为准。
 */
export function continueFromHandEdit(input: { versions: readonly DocumentArtifactVersion[]; readCurrentDigest: (relativePath: string) => string | undefined }): WorkResult<BaseSelection> {
	const latest = [...input.versions].sort((left, right) => right.ordinal - left.ordinal)[0];
	if (!latest) return workFail("BASE_AMBIGUOUS", false, { detail: "no archived version to continue from" });
	const deliverable = primaryArtifact(latest);
	const changedArtifacts = latest.artifacts.filter((file) => !file.existenceOnly && input.readCurrentDigest(file.relativePath) !== file.sha256);
	const changedSources = latest.editableSources.filter((file) => input.readCurrentDigest(file.relativePath) !== file.sha256);
	if (changedArtifacts.length === 0 && changedSources.length === 0) return workFail("BASE_AMBIGUOUS", false, { detail: "no hand edit was detected" });
	if (changedArtifacts.length > 1) return workFail("BASE_AMBIGUOUS", false, { detail: "several deliverable files changed; the revision object is ambiguous" });
	if (changedArtifacts.length === 0) return workFail("BASE_AMBIGUOUS", false, { detail: "only the editable source changed while the deliverable did not; clarify which content wins" });
	const changed = changedArtifacts[0];
	if (changed.relativePath !== deliverable.relativePath) return workFail("BASE_AMBIGUOUS", false, { detail: "a non-primary artifact changed; the revision object is ambiguous" });
	const current = input.readCurrentDigest(changed.relativePath);
	if (current === undefined) return workFail("BASE_CHANGED", false, { detail: "the hand-edited file disappeared while selecting a base" });
	return workOk({
		base: { versionId: latest.versionId, artifactId: `${latest.versionId}:${changed.relativePath}`, relativePath: changed.relativePath, sha256: current, bytes: changed.bytes, explicit: false, handEdited: true },
		handEdited: true,
		note: "the deliverable was edited outside TPA; the archived copy is kept and the hand-edited file becomes this round's base",
	});
}

/** 定位块：正文比较以块为单位，标题层级用于把"允许修改章节"映射到实际段落。 */
export type LocatedBlock = {
	text: string;
	/** 1 = 一级标题；undefined = 普通段落。 */
	headingLevel?: number;
};

export type TextStructureFlags = {
	/** 重复标题：无法唯一定位章节。 */
	duplicateHeadings: boolean;
	/** 未解析的修订（w:ins/w:del 等）。 */
	unresolvedRevisions: boolean;
	/** 无法定位的文本框/浮动内容。 */
	unlocatedTextBoxes: boolean;
	/** 存在未覆盖的部件或未知格式。 */
	unknownParts: boolean;
};

export type TextComparisonOutcome = {
	status: DocumentInspectionStatus;
	/** 覆盖范围说明（检查结论只说明实际覆盖的内容）。 */
	coverage: string;
	changes: string[];
	reason?: string;
};

function normalized(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** 章节归属：返回每个块所属的顶层标题（含自身若是标题）。 */
function sectionOf(blocks: readonly LocatedBlock[]): number[] {
	const sections: number[] = [];
	let current = -1;
	blocks.forEach((block, index) => {
		if (block.headingLevel !== undefined) current = index;
		sections.push(current);
	});
	return sections;
}

function blockMatchesScope(block: LocatedBlock, sectionHeading: string | undefined, scope: DocumentChangeScope): boolean {
	const text = normalized(block.text);
	const heading = normalized(sectionHeading ?? "");
	return scope.allow.some((entry) => {
		const target = normalized(entry);
		return (heading.length > 0 && (heading === target || heading.includes(target))) || text.includes(target);
	});
}

function blockMustBePreserved(block: LocatedBlock, sectionHeading: string | undefined, scope: DocumentChangeScope): boolean {
	const text = normalized(block.text);
	const heading = normalized(sectionHeading ?? "");
	return scope.preserve.some((entry) => {
		const target = normalized(entry);
		return (heading.length > 0 && (heading === target || heading.includes(target))) || text.includes(target);
	});
}

/**
 * 正文比较：先掐掉公共前后缀（得到真正的变化区间），再判定这些变化是否在授权范围内。
 *
 * - 出现未授权变化 → `failed`（保留候选版本，并给出具体位置）；
 * - 结构未覆盖（重复标题、未解析修订、文本框、未知部件）→ `unverified`，不因为
 *   "能对上的部分一样"就判通过；
 * - 结果只能说明实际覆盖的块数。
 */
export function compareBlocks(input: { scope: DocumentChangeScope; baseBlocks: readonly LocatedBlock[]; candidateBlocks: readonly LocatedBlock[]; structure: TextStructureFlags }): TextComparisonOutcome {
	const base = [...input.baseBlocks];
	const candidate = [...input.candidateBlocks];
	const coverage = `blocks=${base.length}->${candidate.length}`;
	if (input.structure.duplicateHeadings || input.structure.unlocatedTextBoxes || input.structure.unknownParts) {
		const reason = input.structure.duplicateHeadings ? "duplicate headings make section locations ambiguous" : input.structure.unlocatedTextBoxes ? "text boxes cannot be located" : "the document contains parts the inspector does not cover";
		return { status: "unverified", coverage, changes: [], reason };
	}
	// 未解析修订意味着"看到的文字"和"最终呈现"可能不同，不能据此判通过。
	if (input.structure.unresolvedRevisions) return { status: "unverified", coverage, changes: [], reason: "unresolved revisions change the effective text" };

	let start = 0;
	while (start < base.length && start < candidate.length && normalized(base[start].text) === normalized(candidate[start].text)) start++;
	let endBase = base.length;
	let endCandidate = candidate.length;
	while (endBase > start && endCandidate > start && normalized(base[endBase - 1].text) === normalized(candidate[endCandidate - 1].text)) {
		endBase--;
		endCandidate--;
	}
	if (start === endBase && start === endCandidate) {
		return { status: "passed", coverage, changes: [] };
	}
	const baseSections = sectionOf(base);
	const candidateSections = sectionOf(candidate);
	const changes: string[] = [];
	let unauthorized = 0;
	const record = (blocks: readonly LocatedBlock[], sections: readonly number[], from: number, to: number, offset: number) => {
		for (let index = from; index < to; index++) {
			const block = blocks[index];
			const headingIndex = sections[index];
			const heading = headingIndex >= 0 ? blocks[headingIndex]?.text : undefined;
			// 参考候选/基稿两侧的章节名：改动章节标题本身时任一命中即可。
			const otherHeadingIndex = headingIndex - offset;
			const otherHeading = otherHeadingIndex >= 0 && otherHeadingIndex < (blocks === base ? candidate.length : base.length) ? (blocks === base ? candidate[otherHeadingIndex]?.text : base[otherHeadingIndex]?.text) : undefined;
			const headingCandidate = heading ?? otherHeading ?? "";
			if (blockMustBePreserved(block, headingCandidate, input.scope) || (otherHeading !== undefined && input.scope.preserve.some((entry) => normalized(entry) === normalized(otherHeading ?? "")))) {
				unauthorized++;
				changes.push(`preserved block changed: ${normalized(block.text).slice(0, 120)}`);
				continue;
			}
			if (input.scope.wholeDocument) continue;
			if (!blockMatchesScope(block, headingCandidate, input.scope) && !(otherHeading !== undefined && input.scope.allow.some((entry) => normalized(entry) === normalized(otherHeading ?? "")))) {
				unauthorized++;
				changes.push(`block outside the authorized scope changed: ${normalized(block.text).slice(0, 120)}`);
			}
			if (changes.length >= 40) return;
		}
	};
	record(base, baseSections, start, endBase, endCandidate - endBase);
	if (changes.length < 40) record(candidate, candidateSections, start, endCandidate, endBase - endCandidate);
	if (unauthorized > 0) return { status: "failed", coverage, changes: changes.slice(0, 40), reason: `${unauthorized} change(s) were not authorized by this round's scope` };

	// 授权范围内的改写，但两侧块数不一致说明有增删——覆盖范围如实记入结论。
	const coverageDetail = `${coverage}; changedBlocks=${candidate.length - start - (candidate.length - endCandidate)}`;
	return { status: "passed", coverage: coverageDetail, changes: [] };
}

/** 供服务层判定"这一版能不能当基稿"：检查失败/未验证不算合格。 */
export function isUsableBaseStatus(status: DocumentInspectionStatus): boolean {
	return status === "passed";
}
