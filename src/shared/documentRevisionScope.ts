/**
 * 用户指令型改稿的范围解析（纯策略，无 IO）。
 *
 * 缺陷背景（2026-10-12 真实验收/根协调者复现）：旧实现把指令里所有「第X节」原样塞进
 * `allow`，结果（a）「第一节保持不变」被当成允许改动，等于放开未授权修改；（b）序号从不
 * 映射到冻结基稿的真实标题（`第二节` vs `二、实施安排`），于是真正的目标块落进隐式保留集，
 * 合法的「只改第二节」反而判 failed。
 *
 * 本模块按「用户要什么产物、做什么动作」的正/负子句分开解析：
 * - 正向子句里的引用 → 解析成真实标题后进 `allow`；
 * - 保留/否定子句里的引用 → 只进 `preserve`，**永不**扩充 `allow`；
 * - 序号必须唯一映射到冻结基稿里的某个标题（数量对不上、编号重复、标题重名都算歧义）；
 * - 没有可解析的正向目标时不返回「全文档可改」，而是 unresolved，由调用方 fail closed。
 *
 * 解析结果只描述范围，不构成授权：授权仍是那一轮真实用户轮 + 主进程的复核。
 */

export type RevisionScopeResolution =
	| { kind: "resolved"; allow: string[]; preserve: string[] }
	/** 整轮就是「先别改，先解释」这类否定 → 不是改稿轮，留在普通聊天。 */
	| { kind: "ordinary" }
	| { kind: "unresolved"; reason: RevisionScopeFailure };

export type RevisionScopeFailure = "no_positive_target" | "ambiguous_reference" | "unresolved_reference" | "duplicate_headings" | "contradictory_scope";

/** 引号里的内容是「要写的字」，不是指令：解析前先挖掉，避免把正文当命令读。 */
const QUOTED_SPAN = /“[^”]*”|"[^"]*"|‘[^’]*’|「[^」]*」|『[^』]*』/g;
const CLAUSE_SEPARATOR = /[，,。；;！!？?\n\r]+/;
/** 保留/否定标记：命中即该子句属于「不许动」一侧。 */
const PRESERVE_MARKER = /(?:保持不变|保持原样|原样保留|不要改|不要修改|不要动|别改|别修改|别动|不许改|无需改|不用改|暂不改|暂时不改|不改动|不要变动|保留|维持)/;
/** 改动动作：正向子句必须带一个才能声明目标。 */
const MODIFICATION_VERB = /(?:改|修改|调整|替换|删掉|删除|加上|增加|补上|缩短|精简|润色|重写|改写|扩写|改成|换成|重排|更新)/;
const ORDINAL_REF = /第([一二三四五六七八九十百零〇\d]+)([章节节篇部分条])/g;
/** 无序号定位词：只在能对上真实标题时才解析成功，否则视为无法解析的引用。 */
const NAMED_LOCATOR = /(?:标题|开头|结尾|落款|附录|摘要|结论|正文|附注)/g;
/** 标题自带序号：「一、」「1.」「第二节」等。 */
const HEADING_PREFIX = /^\s*(?:第\s*)?([一二三四五六七八九十百零〇\d]+)\s*(?:[、.．,，:：)）]|[章节节篇部分条])/;

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十二」/「二十」/「一百零二」/「3」→ 数字；无法解析返回 undefined。 */
export function parseOrdinalNumber(value: string): number | undefined {
	if (/^\d+$/.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
	}
	let total = 0;
	let current = 0;
	for (const character of value) {
		if (character === "十") {
			total += (current || 1) * 10;
			current = 0;
			continue;
		}
		if (character === "百") {
			total += (current || 1) * 100;
			current = 0;
			continue;
		}
		const digit = CHINESE_DIGITS[character];
		if (digit === undefined) return undefined;
		current = digit;
	}
	total += current;
	return total > 0 ? total : undefined;
}

/** 标题里的序号（「一、项目背景」→1）。无序号或无法解析返回 undefined。 */
export function headingOrdinal(heading: string): number | undefined {
	const match = HEADING_PREFIX.exec(heading);
	return match ? parseOrdinalNumber(match[1]) : undefined;
}

/** 去掉序号前缀与空白后的标题正文，用于按名字引用比较。 */
export function headingTitle(heading: string): string {
	return heading
		.replace(HEADING_PREFIX, "")
		.replace(/[\s\u3000]+/g, "")
		.toLowerCase();
}

function duplicateTitles(headings: readonly string[]): string[] {
	const seen = new Map<string, number>();
	for (const heading of headings) {
		const title = headingTitle(heading);
		if (!title) continue;
		seen.set(title, (seen.get(title) ?? 0) + 1);
	}
	return [...seen.entries()].filter(([, count]) => count > 1).map(([title]) => title);
}

type Reference = { kind: "ordinal"; value: number; source: string } | { kind: "title"; source: string } | { kind: "named"; source: string };

type ReferenceResolution = { kind: "resolved"; heading: string } | { kind: "ambiguous"; source: string } | { kind: "unresolved"; source: string };

/** 把一个引用解成冻结基稿里的唯一标题；歧义与无法解析分别返回，由调用方决定 fail closed 的方向。 */
function resolveReference(reference: Reference, headings: readonly string[]): ReferenceResolution {
	if (reference.kind === "ordinal") {
		// 先按标题自带的编号定位：「第二节」指编号为二的标题，和它在文档里的位置无关
		//（文档标题「季度报告」会让章节位置整体后移，按位置猜会指错）。
		const byMarker = headings.filter((heading) => headingOrdinal(heading) === reference.value);
		if (byMarker.length > 1) return { kind: "ambiguous", source: reference.source };
		if (byMarker.length === 1) return { kind: "resolved", heading: byMarker[0] };
		// 文档里完全没有编号标签时才按文档顺序定位；有标签但缺这个号 → 不猜位置。
		if (headings.some((heading) => headingOrdinal(heading) !== undefined)) return { kind: "unresolved", source: reference.source };
		const positional = headings[reference.value - 1];
		return positional === undefined ? { kind: "unresolved", source: reference.source } : { kind: "resolved", heading: positional };
	}
	const wanted = headingTitle(reference.source);
	if (reference.kind === "title") {
		const matches = headings.filter((heading) => headingTitle(heading) === wanted);
		if (matches.length === 1) return { kind: "resolved", heading: matches[0] };
		return matches.length > 1 ? { kind: "ambiguous", source: reference.source } : { kind: "unresolved", source: reference.source };
	}
	const named = headings.filter((heading) => headingTitle(heading).includes(wanted) || wanted.includes(headingTitle(heading)));
	if (named.length === 1) return { kind: "resolved", heading: named[0] };
	return named.length > 1 ? { kind: "ambiguous", source: reference.source } : { kind: "unresolved", source: reference.source };
}

/** 从子句里抽引用：先序号，再按标题名（标题名只在子句真的包含时才成立）。 */
function referencesIn(clause: string, headings: readonly string[]): Reference[] {
	const references: Reference[] = [];
	for (const match of clause.matchAll(ORDINAL_REF)) {
		const value = parseOrdinalNumber(match[1]);
		if (value !== undefined) references.push({ kind: "ordinal", value, source: match[0] });
	}
	for (const match of clause.matchAll(NAMED_LOCATOR)) references.push({ kind: "named", source: match[0] });
	// 标题名引用：「把实施安排改短」——子句里出现标题正文（长度 ≥2）即算指名。
	for (const heading of headings) {
		const title = headingTitle(heading);
		if (title.length >= 2 && clause.includes(title)) references.push({ kind: "title", source: heading });
	}
	return references;
}

/**
 * 解析一轮改稿指令的实际范围。
 *
 * @param instruction 主进程读到的真实用户轮正文
 * @param headings 冻结基稿里按文档顺序排列的标题（来自真实检查器，DOCX 与 Markdown 同源）
 */
export function resolveRevisionScope(input: { instruction: string; headings: readonly string[] }): RevisionScopeResolution {
	const instruction = input.instruction.trim();
	if (!instruction) return { kind: "unresolved", reason: "no_positive_target" };
	const headings = input.headings.map((heading) => heading.trim()).filter((heading) => heading.length > 0);
	if (headings.length === 0) return { kind: "unresolved", reason: "no_positive_target" };
	if (duplicateTitles(headings).length > 0) return { kind: "unresolved", reason: "duplicate_headings" };

	// 引号内容是要写入的字，不是指令；挖掉后再切子句。
	const analytical = instruction.replace(QUOTED_SPAN, "⟨内容⟩");
	const allow = new Set<string>();
	const preserve = new Set<string>();
	let positiveTargets = 0;
	let sawAmbiguity = false;
	/** 是否出现过「改动动作」的子句（哪怕没解析出目标）：用于区分「纯保留/解释轮」与「目标无法解析的改稿轮」。 */
	let sawModificationVerb = false;
	let sawPreserveClause = false;
	/** 解析不到但被忽略的引用（保留子句，或不在结构模型里的泛化定位词）：只用于诊断。 */
	const ignoredPreserveRefs: string[] = [];

	for (const clause of analytical.split(CLAUSE_SEPARATOR)) {
		const trimmed = clause.trim();
		if (!trimmed) continue;
		const isPreserveClause = PRESERVE_MARKER.test(trimmed);
		const isPositiveClause = !isPreserveClause && MODIFICATION_VERB.test(trimmed);
		if (!isPreserveClause && !isPositiveClause) continue;
		if (isPreserveClause) sawPreserveClause = true;
		else sawModificationVerb = true;
		const references = referencesIn(trimmed, headings);
		for (const reference of references) {
			const resolution = resolveReference(reference, headings);
			if (resolution.kind === "ambiguous") {
				sawAmbiguity = true;
				continue;
			}
			if (resolution.kind === "unresolved") {
				// 保留子句里解析不到的引用不影响安全（未提及的块本来就隐式保留）。
				if (isPreserveClause) {
					ignoredPreserveRefs.push(resolution.source);
					continue;
				}
				// 泛化定位词（标题/正文/开头/结尾…）指的可能是不在结构模型里的区域（文档标题、首段），
				// 解析不到它不等于「用户点名的章节不存在」：忽略它，允许范围不会因此扩大。
				if (reference.kind === "named") {
					ignoredPreserveRefs.push(resolution.source);
					continue;
				}
				// 点名了具体的章节（序号或章节名）却找不到 → 目标不存在，整轮不成立。
				return { kind: "unresolved", reason: "unresolved_reference" };
			}
			if (isPreserveClause) preserve.add(resolution.heading);
			else {
				allow.add(resolution.heading);
				positiveTargets += 1;
			}
		}
	}
	if (sawAmbiguity) return { kind: "unresolved", reason: "ambiguous_reference" };
	if (positiveTargets === 0 || allow.size === 0) {
		// 没有正向目标又只有保留/否定/解释语气 → 这一轮根本不是改稿（例如「先不要改，先解释一下」）；
		// 有改动动作却解析不到目标 → fail closed，绝不解释成「整篇都能改」。
		if (sawPreserveClause && !sawModificationVerb) return { kind: "ordinary" };
		return { kind: "unresolved", reason: "no_positive_target" };
	}
	// 同一节既被要求改又被要求保留 → 先说清楚，不猜。
	for (const heading of allow) if (preserve.has(heading)) return { kind: "unresolved", reason: "contradictory_scope" };
	// 未提及的块保持隐式保留（检查器同样按 allow 之外默认保留），这里显式写进 preserve 便于审计。
	for (const heading of headings) if (!allow.has(heading) && !preserve.has(heading)) preserve.add(heading);
	// 解析不到的保留引用不影响结论（未提及的块本来就隐式保留），只在保留集里体现不出它。
	void ignoredPreserveRefs;
	return { kind: "resolved", allow: [...allow], preserve: [...preserve].filter((heading) => !allow.has(heading)) };
}
