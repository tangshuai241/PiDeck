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
import type { DocumentArtifactVersion, DocumentChangeScope, DocumentBaseSelection } from "../../shared/types/documentWork";

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

/** 改稿指令的范围判定结果：要么给出本轮冻结范围，要么要求澄清。 */
export type InstructionScopeDecision = { kind: "scope"; scope: DocumentChangeScope; matched: string[]; note?: string } | { kind: "clarify"; reason: string };

/** 明确的改动动词；没有它们就不是执行指令（只是讨论/提问）。 */
const CHANGE_VERBS = /(改|修|调整|重写|更新|补充|删|去掉|换|精简|润色|扩写|加|rewrite|revise|update|adjust|edit|change|add|remove|shorten|expand|replace)/i;
/** 明确的禁止/否定：要求"别改，只解释"时绝不构成执行授权。 */
const PROHIBITION = /(不要改|别改|先别改|不用改|无须改|无需改|不改动|先解释|只解释|只要解释|先说明|只说明|do ?n[o']?t (change|edit|modify|touch)|just explain|only explain|no changes? (yet|please)?)/i;
/** 整篇授权：只有明确说了才成立。 */
const WHOLE_DOCUMENT = /(全文|整篇|通篇|全篇|整份|整篇重写|rewrite (the )?(whole|entire)|from scratch|rewrite it all)/i;
/** 「第N节/章/部分/条」的显式定位。 */
const ORDINAL_SECTION = /第\s*([一二三四五六七八九十百\d]+)\s*(节|章|部分|条|段)/g;
/** 引号里的标题（中英文引号）。 */
const QUOTED = /[“"「『]([^”"」』]{1,80})[”"」』]/g;

function normalizedText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

const CHINESE_DIGITS = new Map<string, number>([
	["一", 1],
	["二", 2],
	["三", 3],
	["四", 4],
	["五", 5],
	["六", 6],
	["七", 7],
	["八", 8],
	["九", 9],
	["十", 10],
]);

function ordinalValue(raw: string): number | undefined {
	if (/^\d+$/.test(raw)) return Number(raw);
	const trimmed = raw.replace(/^十/, "").trim();
	if (!trimmed) return 10;
	const digits = [...trimmed].map((character) => CHINESE_DIGITS.get(character));
	if (digits.some((digit) => digit === undefined)) return undefined;
	return (digits as number[]).reduce((total: number, digit: number) => total * 10 + digit, 0);
}

/**
 * 从本轮用户指令推导授权范围。
 *
 * 两条硬性规则：
 * 1. 授权来自"这一轮由真实用户发出的指令"（由调用方验证角色与最新性），
 *    这里只负责把**范围**说清楚；范围不能沿用上一轮的要求单，否则"只改第二节"
 *    会被放宽成整篇授权；
 * 2. 说不清范围就返回澄清（`APPROVAL_REQUIRED`），不做关键词以外的猜测、
 *    也不默认允许改动。
 *
 * @param baseHeadings 冻结基稿里实际存在的标题（按文档顺序）；用于把"第N节"或
 *   引号标题落到真实章节上。拿不到标题时按空处理，引用序号的指令会走澄清。
 */
export function deriveInstructionScope(input: { instruction: string; baseHeadings: readonly string[]; inheritedPreserve?: readonly string[] }): InstructionScopeDecision {
	const instruction = normalizedText(input.instruction);
	if (!instruction) return { kind: "clarify", reason: "the change request is empty" };
	if (PROHIBITION.test(instruction)) return { kind: "clarify", reason: "the message asks not to change anything (or only to explain); confirm the change explicitly" };
	const headings = input.baseHeadings.map((heading) => normalizedText(heading)).filter((heading) => heading.length > 0);
	const preserve = [...new Set((input.inheritedPreserve ?? []).map((item) => normalizedText(item)).filter((item) => item.length > 0))];
	const matched: string[] = [];
	const pushMatch = (heading: string) => {
		if (!matched.includes(heading)) matched.push(heading);
	};
	for (const heading of headings) {
		// 标题必须原样出现在指令里才算点名；不做模糊相似度匹配。
		if (instruction.includes(heading)) pushMatch(heading);
	}
	for (const match of instruction.matchAll(QUOTED)) {
		const quoted = normalizedText(match[1] ?? "");
		if (!quoted) continue;
		const hit = headings.find((heading) => heading.includes(quoted) || quoted.includes(heading));
		if (hit) pushMatch(hit);
	}
	for (const match of instruction.matchAll(ORDINAL_SECTION)) {
		const value = ordinalValue(match[1] ?? "");
		if (value === undefined || value < 1 || value > headings.length) {
			if (value !== undefined && value >= 1) return { kind: "clarify", reason: `the document has ${headings.length} located headings, so section ${value} cannot be identified` };
			continue;
		}
		pushMatch(headings[value - 1]);
	}
	const wholeDocument = WHOLE_DOCUMENT.test(instruction);
	if (wholeDocument) {
		// 明确整篇重写：允许全篇改动，但保留块（上一轮要求里的"必须保留"）仍然生效。
		return { kind: "scope", scope: { allow: [], preserve, wholeDocument: true }, matched: [], note: "explicit whole-document rewrite" };
	}
	if (matched.length === 0 || !CHANGE_VERBS.test(instruction)) {
		return { kind: "clarify", reason: "the change request does not name a section that exists in the document, or is not an explicit change instruction" };
	}
	const ordered = headings.filter((heading) => matched.includes(heading));
	return { kind: "scope", scope: { allow: ordered, preserve, wholeDocument: false }, matched: ordered };
}
