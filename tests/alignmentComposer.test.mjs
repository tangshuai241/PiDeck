import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const composer = loadTsCommonJs(resolve("src/renderer/src/composerBehavior.ts"));
const controls = loadTsCommonJs(resolve("src/renderer/src/utils/alignmentControls.ts"));
const availability = loadTsCommonJs(resolve("src/renderer/src/hooks/useComposerModeAvailability.ts"), { stubs: { "../desktopApi": { desktopApi: {} } } });
const plain = (value) => JSON.parse(JSON.stringify(value));

function snapshot(overrides = {}) {
	return {
		schemaVersion: 1,
		briefId: "brief-123",
		revision: 2,
		phase: "ready",
		brief: { goal: "整理记录", scope: ["桥面系"], materials: [], deliverable: "Markdown", preserve: [], acceptance: ["范围准确"], questions: [] },
		...overrides,
	};
}

test("alignment keeps visible user text unchanged and adds only an internal marker", () => {
	const result = composer.buildComposerPromptSubmission("先整理这次会议材料", "alignment");
	assert.equal(result.message, "先整理这次会议材料");
	assert.equal(result.agentMessage, "__PI_DECK_ALIGNMENT_MODE__\n先整理这次会议材料");
	assert.deepEqual(plain(composer.buildComposerPromptSubmission("普通聊天", "normal")), { message: "普通聊天" });
	assert.deepEqual(plain(composer.buildComposerPromptSubmission("/align off", "alignment")), { message: "/align off" });
});

test("active alignment restores the pi composer while unsupported backends cannot select it", () => {
	assert.equal(composer.deriveComposerAgentMode({ backend: "pi", localMode: "normal", alignmentPhase: "ready" }), "alignment");
	assert.equal(composer.deriveComposerAgentMode({ backend: "pi", alignmentPhase: "clarifying" }), "alignment");
	assert.equal(composer.deriveComposerAgentMode({ backend: "pi", localMode: "normal", alignmentPhase: "complete" }), "normal");
	assert.equal(composer.deriveComposerAgentMode({ backend: "dsh", localMode: "alignment" }), "normal");
	assert.equal(composer.deriveComposerAgentMode({ backend: "acp", localMode: "alignment", alignmentPhase: "ready" }), "normal");
});

test("alignment appears only when its actual runtime extension is enabled", () => {
	const options = { isImageGen: false, planModeAvailable: true, goalModeAvailable: true };
	assert.deepEqual(plain(availability.computeVisibleModes(options)), ["normal", "goal", "plan"]);
	assert.deepEqual(plain(availability.computeVisibleModes({ ...options, alignmentModeAvailable: true })), ["normal", "alignment", "goal", "plan"]);
	assert.deepEqual(plain(availability.computeVisibleModes({ ...options, isImageGen: true, alignmentModeAvailable: true })), []);
});

test("pending availability does not cancel restored alignment before discovery finishes", () => {
	const options = { isImageGen: false, current: "alignment", planModeAvailable: true, goalModeAvailable: true, alignmentModeAvailable: false, alignmentAvailabilityKnown: false };
	assert.equal(availability.computeUnavailableModeFallback(options), undefined);
	assert.equal(availability.computeUnavailableModeFallback({ ...options, alignmentAvailabilityKnown: true }), "normal");
	assert.equal(availability.computeUnavailableModeFallback({ ...options, alignmentAvailabilityKnown: true, alignmentModeAvailable: true }), undefined);
});

test("entering alignment exits old modes before capturing tools; leaving sends only an explicit cancel", () => {
	assert.deepEqual(plain(controls.alignmentModeCommands("plan", "alignment", true)), ["/plan off", "/align on"]);
	assert.deepEqual(plain(controls.alignmentModeCommands("goal", "alignment", true)), ["/goal pause", "/align on"]);
	assert.deepEqual(plain(controls.alignmentModeCommands("alignment", "normal", true)), ["/align off"]);
	assert.deepEqual(plain(controls.alignmentModeCommands("normal", "alignment", false)), []);
});

test("a stale rendered card cannot approve or revise updated requirements", () => {
	assert.equal(controls.alignmentActionCommand("approve", snapshot(), snapshot({ revision: 3 })), undefined);
	assert.equal(controls.alignmentActionCommand("revise", snapshot(), snapshot({ briefId: "other" })), undefined);
	assert.equal(controls.alignmentActionCommand("approve", snapshot(), snapshot()), "/align approve brief-123 2");
	assert.equal(controls.alignmentActionCommand("approve", snapshot(), snapshot({ phase: "approved" })), undefined);
});

test("runtime identity includes session and generation rather than just agent id", () => {
	const target = { sessionId: "s1", agentId: "a1", runtimeGeneration: 4 };
	assert.equal(controls.sameAlignmentRuntime(target, { ...target }), true);
	assert.equal(controls.sameAlignmentRuntime(target, { ...target, runtimeGeneration: 5 }), false);
	assert.equal(controls.sameAlignmentRuntime(target, { ...target, sessionId: "s2" }), false);
});
