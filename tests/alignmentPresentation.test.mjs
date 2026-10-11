import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const policy = loadTsCommonJs("src/renderer/src/utils/alignmentPresentation.ts");
const brief = { goal: "整理术语", scope: [], materials: [], deliverable: "Excel", preserve: [], acceptance: ["可追加条目"], questions: [] };
const ready = { schemaVersion: 1, briefId: "brief-123", revision: 4, phase: "ready", brief };
const view = (overrides = {}) => policy.deriveAlignmentPresentation({ selected: true, state: ready, hasRuntime: true, busy: false, pending: false, sending: false, queuedCount: 0, ...overrides });

test("selecting alignment without input shows no progress or confirmation", () => {
	assert.equal(view({ state: undefined }).kind, "hidden");
	assert.equal(view({ state: { ...ready, phase: "clarifying", brief: undefined } }).kind, "hidden");
});
test("an unanswered draft is waiting for answers, never complete or spinning", () => {
	const result = view({ state: { ...ready, phase: "clarifying", brief: { ...brief, questions: ["请确定范围", "请确定材料"] } } });
	assert.equal(result.kind, "questions");
	assert.equal(result.questionCount, 2);
	assert.equal(result.canApprove, false);
});
test("only idle ready requirements have both the completion title and executable action", () => {
	assert.equal(view().kind, "ready");
	assert.equal(view().canApprove, true);
	for (const override of [{ busy: true }, { sending: true }, { pending: true }, { queuedCount: 1 }, { hasRuntime: false }]) {
		const result = view(override);
		assert.notEqual(result.kind, "ready");
		assert.equal(result.canApprove, false);
	}
});
test("a new submission invalidates old ready requirements before a runtime event arrives", () => {
	const submission = { requestId: "req1", briefId: ready.briefId, revision: ready.revision };
	assert.equal(view({ submission, sending: true }).kind, "sending");
	assert.equal(view({ submission, busy: true }).kind, "working");
	assert.equal(view({ submission }).kind, "incomplete");
	assert.equal(view({ submission, state: { ...ready, revision: 5 } }).kind, "ready");
});
test("idle missing publication and interrupted rounds offer continuation instead of infinite progress", () => {
	assert.equal(view({ state: { ...ready, phase: "clarifying" } }).kind, "incomplete");
	assert.equal(view({ state: { ...ready, phase: "clarifying", lastStopReason: "aborted" } }).kind, "interrupted");
	assert.equal(view({ state: { ...ready, phase: "clarifying", lastStopReason: "error" } }).kind, "failed");
});
test("delivery uncertainty and control failure never claim completion", () => {
	assert.equal(view({ sendStatus: "unknown" }).kind, "unknown");
	assert.equal(view({ sendStatus: "error" }).kind, "failed");
	assert.equal(view({ controlError: "Approval did not arrive" }).kind, "failed");
});
test("approved and complete are separate authoritative outcomes", () => {
	assert.equal(view({ state: { ...ready, phase: "approved" }, busy: true }).kind, "approved");
	assert.equal(view({ state: { ...ready, phase: "complete" } }).kind, "complete");
	assert.equal(view({ state: { ...ready, phase: "cancelled" }, selected: false }).kind, "hidden");
});
test("input invalidation retains old questions but cannot present them as newly published questions, including restored history", () => {
	const retained = { ...ready, phase: "clarifying", revision: 5, briefRevision: 4, brief: { ...brief, questions: ["此前已回答的问题"] } };
	assert.equal(view({ state: retained }).kind, "incomplete");
	assert.equal(view({ state: { ...retained, revision: 6, briefRevision: 6, brief: { ...brief, questions: ["新发现的缺失信息"] } } }).kind, "questions");
});

test("historical approval without a runtime cannot claim that execution has started", () => {
	assert.equal(view({ state: { ...ready, phase: "approved" }, hasRuntime: false }).kind, "unavailable");
});

test("local queue hides the stale confirmation even while the runtime is idle", () => {
	assert.equal(view({ queuedCount: 2 }).kind, "queued");
});
