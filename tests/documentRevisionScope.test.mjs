/**
 * 改稿范围解析（纯策略）：正/负子句分开、序号映射到真实标题、歧义一律 fail closed。
 *
 * 反例来源：根协调者用生产检查器复现的 `ordinal-scope-probe/result.json` ——
 * 「把第二节改短，改成“布设传感器后每日检查。”，第一节保持不变。」在旧实现里得到
 * allow=['第二节','第一节']（既把保留句当授权，又映射不到真实标题），合法的「只改第二节」判 failed。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
/** 被加载模块在 vm 里有独立原型链：结构比较前先 JSON 归一。 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const scope = loadTsCommonJs(`${ROOT}/src/shared/documentRevisionScope.ts`);

const HEADINGS = ["一、项目背景", "二、实施安排"];
const EXACT_INSTRUCTION = "把第二节改短，改成“布设传感器后每日检查。”，第一节保持不变。";

test("根协调者复现的原指令：第二节解析成真实标题，第一节只进保留集", () => {
	const result = scope.resolveRevisionScope({ instruction: EXACT_INSTRUCTION, headings: HEADINGS });
	assert.equal(result.kind, "resolved", JSON.stringify(result));
	assert.deepEqual(plain(result.allow), ["二、实施安排"], "正向目标必须是冻结基稿里的真实标题");
	assert.equal(result.allow.includes("第一节"), false, "序数引用不得原样进 allow");
	assert.equal(result.allow.includes("一、项目背景"), false, "「第一节保持不变」绝不能扩充 allow");
	assert.deepEqual(plain(result.preserve), ["一、项目背景"], "被显式要求保留的块进 preserve");
});

test("同一节既能被点名又带保留句时不冲突：改第二节、第一节不要改", () => {
	const result = scope.resolveRevisionScope({ instruction: "改第二节，第一节不要改。", headings: HEADINGS });
	assert.equal(result.kind, "resolved", JSON.stringify(result));
	assert.deepEqual(plain(result.allow), ["二、实施安排"]);
	assert.deepEqual(plain(result.preserve), ["一、项目背景"]);
});

test("按标题自带编号定位，不因文档顺序不同而歧义", () => {
	// 有编号标签时以标签为准：用户说「第二节」指的是标着二的标题。
	const labelled = scope.resolveRevisionScope({ instruction: "改第二节。", headings: ["二、乙", "一、甲"] });
	assert.equal(labelled.kind, "resolved", JSON.stringify(labelled));
	assert.deepEqual(plain(labelled.allow), ["二、乙"]);

	// 文档标题（无编号）在前也不影响章节定位。
	const withDocTitle = scope.resolveRevisionScope({ instruction: "改第二节。", headings: ["季度报告", "第一节 概述", "第二节 方法"] });
	assert.equal(withDocTitle.kind, "resolved", JSON.stringify(withDocTitle));
	assert.deepEqual(plain(withDocTitle.allow), ["第二节 方法"]);

	// 有编号标签但缺这个号 → 不按位置猜。
	const missingNumber = scope.resolveRevisionScope({ instruction: "改第四节。", headings: ["一、甲", "二、乙"] });
	assert.equal(missingNumber.kind, "unresolved");
	assert.equal(missingNumber.reason, "unresolved_reference");
});

test("编号重复、标题重名、同一节矛盾要求都 fail closed", () => {
	const duplicatedOrdinal = scope.resolveRevisionScope({ instruction: "改第二节。", headings: ["一、甲", "二、乙", "二、丙"] });
	assert.equal(duplicatedOrdinal.kind, "unresolved");
	assert.equal(duplicatedOrdinal.reason, "ambiguous_reference");

	const duplicatedTitle = scope.resolveRevisionScope({ instruction: "改第二节。", headings: ["一、项目背景", "二、项目背景"] });
	assert.equal(duplicatedTitle.kind, "unresolved");
	assert.equal(duplicatedTitle.reason, "duplicate_headings");

	const contradictory = scope.resolveRevisionScope({ instruction: "把第二节改短，第二节保持不变。", headings: HEADINGS });
	assert.equal(contradictory.kind, "unresolved");
	assert.equal(contradictory.reason, "contradictory_scope");
});

test("没有可解析的正向目标时不返回「全文档可改」", () => {
	// 目标超出现有大纲：解析不到 → 整轮不成立，而不是放开整篇。
	const outOfRange = scope.resolveRevisionScope({ instruction: "改第三节。", headings: HEADINGS });
	assert.equal(outOfRange.kind, "unresolved");
	assert.equal(outOfRange.reason, "unresolved_reference");

	// 只用泛化定位词（正文/开头/结尾…）而没有可解析的章节：同样不能变成 allow=全部。
	const namedMiss = scope.resolveRevisionScope({ instruction: "把正文整体重写一遍。", headings: HEADINGS });
	assert.equal(namedMiss.kind, "unresolved");
	assert.equal(namedMiss.reason, "no_positive_target", "泛化定位词不构成可解析的章节目标");

	// 完全没有定位的改写要求：交给普通聊天澄清。
	const noTarget = scope.resolveRevisionScope({ instruction: "把内容改短一点。", headings: HEADINGS });
	assert.equal(noTarget.kind, "unresolved");
	assert.equal(noTarget.reason, "no_positive_target");
});

test("整轮否定/先解释仍留在普通聊天", () => {
	for (const instruction of ["先不要改，先解释一下为什么。", "别改，先说明依据。", "第一节保持不变。"]) {
		assert.equal(scope.resolveRevisionScope({ instruction, headings: HEADINGS }).kind, "ordinary", instruction);
	}
});

test("无序号标题按文档顺序定位；序号与标题名并存时取唯一标题", () => {
	const positional = scope.resolveRevisionScope({ instruction: "改第二节。", headings: ["项目背景", "实施安排"] });
	assert.equal(positional.kind, "resolved");
	assert.deepEqual(plain(positional.allow), ["实施安排"]);

	const titled = scope.resolveRevisionScope({ instruction: "改第二节（实施安排部分）。", headings: HEADINGS });
	assert.equal(titled.kind, "resolved");
	assert.deepEqual(plain(titled.allow), ["二、实施安排"]);

	const namedLocator = scope.resolveRevisionScope({ instruction: "重写结论，其它保持不变。", headings: ["一、项目背景", "二、结论"] });
	assert.equal(namedLocator.kind, "resolved");
	assert.deepEqual(plain(namedLocator.allow), ["二、结论"]);
});

test("中文序号解析覆盖十/百位写法", () => {
	assert.equal(scope.parseOrdinalNumber("十二"), 12);
	assert.equal(scope.parseOrdinalNumber("二十"), 20);
	assert.equal(scope.parseOrdinalNumber("一百零二"), 102);
	assert.equal(scope.parseOrdinalNumber("3"), 3);
	assert.equal(scope.parseOrdinalNumber("十"), 10);
	assert.equal(scope.parseOrdinalNumber("零"), undefined);
	assert.equal(scope.parseOrdinalNumber("第"), undefined);
});
