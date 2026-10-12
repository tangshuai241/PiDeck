/**
 * 授权与当前范围。
 *
 * 覆盖审查修正项 2：
 * - 首次制作**只**认当前对齐确认单（用户指令、模型文本、布尔值都不行）；
 * - 改稿只认"那一轮真实用户消息"：角色必须是 user、必须是最后一条用户消息、
 *   正文指纹必须与读回的正文一致；
 * - 范围来自**本轮指令**（比如"只改第二节"），不沿用上一轮的全篇 scope；
 * - 否定句、提问、assistant/system 文本、旧轮、编辑后正文都不得构成执行授权。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { instructionDigest } from "./helpers/instructionDigest.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const round = loadTsCommonJs("src/main/document-work/DocumentWorkRound.ts");
const policy = loadTsCommonJs("src/main/document-work/DocumentRevisionPolicy.ts");

const BRIEF = { goal: "write a report", scope: ["Section one", "Section two", "Appendix"], materials: [], deliverable: "report.docx", preserve: ["Facts stay"], acceptance: ["matches the outline"], questions: [] };
const READY = { briefId: "brief_1", revision: 3, phase: "ready", hasOpenQuestions: false, brief: BRIEF };

function turn(text, overrides = {}) {
	return { entryId: "turn_1", role: "user", text, textDigest: instructionDigest(text.trim()), isLatestUserTurn: true, ...overrides };
}

test("首次制作只认当前确认单：用户指令、缺确认单、版本变化、未决问题全部拒绝", () => {
	const userInstruction = round.resolveCreateAuthorization({ requirementsRef: { kind: "user_instruction", sourceTurnId: "turn_1" }, alignment: READY });
	assert.equal(userInstruction.ok, false);
	assert.equal(userInstruction.error.code, "APPROVAL_REQUIRED");

	const missing = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 }, alignment: undefined });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "APPROVAL_REQUIRED");

	const wrongBrief = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_other", revision: 3 }, alignment: READY });
	assert.equal(wrongBrief.ok, false);
	assert.equal(wrongBrief.error.code, "APPROVAL_REQUIRED");

	// 确认单在准备期间变过：按失效处理，而不是拿旧版本放行。
	const advanced = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 2 }, alignment: READY });
	assert.equal(advanced.ok, false);
	assert.equal(advanced.error.code, "PREPARATION_STALE");

	const open = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 }, alignment: { ...READY, hasOpenQuestions: true } });
	assert.equal(open.ok, false);
	assert.equal(open.error.code, "APPROVAL_REQUIRED");

	const clarifying = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 }, alignment: { ...READY, phase: "clarifying" } });
	assert.equal(clarifying.ok, false);
	assert.equal(clarifying.error.code, "APPROVAL_REQUIRED");

	// 只有"当前确认单 + ready + 无未决问题"放行，并且授权类型是对齐确认。
	const allowed = round.resolveCreateAuthorization({ requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 3 }, alignment: READY });
	assert.equal(allowed.ok, true);
	assert.deepEqual({ ...allowed.value.authorization }, { kind: "alignment_confirmation", briefId: "brief_1", revision: 3 });
	// 初稿的"必须保留"照常冻结（不与"整篇可改"矛盾）。
	assert.deepEqual([...allowed.value.scope.preserve], ["Facts stay"]);
});

test("改稿授权：角色、最新性、正文指纹三者缺一不可", () => {
	const base = { sourceTurnId: "turn_1", baseHeadings: ["Section one", "Section two"], inheritedPreserve: ["Facts stay"] };
	const text = "只改第二节";
	const ok = round.resolveRevisionRound({ ...base, instruction: text, turn: turn(text) });
	assert.equal(ok.ok, true);

	// assistant / system 文本不是授权。
	for (const role of ["assistant", "system", "tool", "other"]) {
		const rejected = round.resolveRevisionRound({ ...base, instruction: text, turn: turn(text, { role }) });
		assert.equal(rejected.ok, false, role);
		assert.equal(rejected.error.code, "APPROVAL_REQUIRED");
	}
	// 旧轮（之后又来了新消息）。
	const stale = round.resolveRevisionRound({ ...base, instruction: text, turn: turn(text, { isLatestUserTurn: false }) });
	assert.equal(stale.ok, false);
	assert.equal(stale.error.code, "APPROVAL_REQUIRED");
	// 正文被编辑过：指纹与冻结值时的不一致。
	const edited = round.resolveRevisionRound({ ...base, instruction: text, turn: turn(text, { textDigest: instructionDigest("只改第三节") }) });
	assert.equal(edited.ok, false);
	assert.equal(edited.error.code, "PREPARATION_STALE");
	// 读不到那一轮。
	const missing = round.resolveRevisionRound({ ...base, instruction: text, turn: undefined });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "APPROVAL_REQUIRED");
	// 空正文/超预算。
	assert.equal(round.resolveRevisionRound({ ...base, instruction: "", turn: turn(" ") }).ok, false);
	assert.equal(round.resolveRevisionRound({ ...base, instruction: "x".repeat(4001), turn: turn("x".repeat(4001)) }).ok, false);
});

test("范围来自本轮指令：只改第二节就只授权第二节，不沿用旧全篇 scope", () => {
	const decision = policy.deriveInstructionScope({ instruction: "只改第二节，其余保持原样", baseHeadings: ["引言", "方法", "结论"], inheritedPreserve: ["Facts stay"] });
	assert.equal(decision.kind, "scope");
	assert.deepEqual([...decision.matched], ["方法"]);
	assert.deepEqual([...decision.scope.allow], ["方法"]);
	assert.equal(decision.scope.wholeDocument, false);
	assert.deepEqual([...decision.scope.preserve], ["Facts stay"]);

	// 上一轮的全篇确认单不会把这一轮放宽：指令没点名就澄清。
	const unclear = policy.deriveInstructionScope({ instruction: "再打磨一下", baseHeadings: ["引言", "方法"], inheritedPreserve: [] });
	assert.equal(unclear.kind, "clarify");
	// 引用不存在的章节也要澄清，而不是当作整篇。
	const missing = policy.deriveInstructionScope({ instruction: "只改第五节", baseHeadings: ["引言", "方法"], inheritedPreserve: [] });
	assert.equal(missing.kind, "clarify");
	// 明确整篇重写才给整篇授权。
	const whole = policy.deriveInstructionScope({ instruction: "整篇重写一遍", baseHeadings: ["引言", "方法"], inheritedPreserve: ["Facts stay"] });
	assert.equal(whole.kind, "scope");
	assert.equal(whole.scope.wholeDocument, true);
	// 引号标题也能定位。
	const quoted = policy.deriveInstructionScope({ instruction: "把“结论”改短一点", baseHeadings: ["引言", "结论"], inheritedPreserve: [] });
	assert.equal(quoted.kind, "scope");
	assert.deepEqual([...quoted.matched], ["结论"]);
});

test("否定与提问不构成执行授权", () => {
	for (const instruction of ["别改，先解释第二节", "不要改正文，只说思路", "先别改，解释一下第二段", "don't change section two, just explain it", "只解释第三节为什么这么写"]) {
		const decision = policy.deriveInstructionScope({ instruction, baseHeadings: ["第一节", "第二节", "第三节"], inheritedPreserve: [] });
		assert.equal(decision.kind, "clarify", instruction);
		assert.match(decision.reason, /explain|not to change/i);
	}
});

test("改稿的授权类型与冻结指令必须自洽", () => {
	const text = "只改第二节";
	const result = round.resolveRevisionRound({ instruction: text, turn: turn(text), sourceTurnId: "turn_1", baseHeadings: ["第一节", "第二节"], inheritedPreserve: [] });
	assert.equal(result.ok, true);
	assert.deepEqual({ ...result.value.authorization }, { kind: "revision_instruction", sourceTurnId: "turn_1" });
	assert.equal(result.value.instruction.textDigest, instructionDigest(text));
	assert.equal(result.value.instruction.sourceTurnId, "turn_1");
});
