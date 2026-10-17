import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { captureCompletionBaseline, shouldAcknowledgeCompletion } = loadTsCommonJs("src/renderer/src/utils/sessionCompletionRead.ts");

const base = { completionId: "run-1", ready: true, baselineCompletionId: undefined, foreground: true, paneVisible: true, covered: false, following: true, focusRequested: false, becameFollowing: false };

test("可见的新结果直接确认已读", () => {
	assert.equal(shouldAcknowledgeCompletion(base), true);
});

test("首次摘要加载完成前不确认，避免把启动时的旧未读当成新结果", () => {
	assert.equal(shouldAcknowledgeCompletion({ ...base, ready: false }), false);
	// 摘要异步到达：加载完成时记录基线，之后同一结果不自动确认。
	const baseline = captureCompletionBaseline({}, { ready: false, sessionId: "s1", completionId: "run-1" });
	assert.equal(baseline.completionId, undefined, "加载前不记录基线");
	const hydrated = captureCompletionBaseline(baseline, { ready: true, sessionId: "s1", completionId: "run-1" });
	assert.equal(hydrated.completionId, "run-1");
	assert.equal(shouldAcknowledgeCompletion({ ...base, baselineCompletionId: "run-1" }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, baselineCompletionId: "run-1", focusRequested: true }), true);
	assert.equal(shouldAcknowledgeCompletion({ ...base, baselineCompletionId: "run-1", becameFollowing: true }), true);
	// 基线之后产生的新结果照常确认。
	assert.equal(shouldAcknowledgeCompletion({ ...base, completionId: "run-2", baselineCompletionId: "run-1" }), true);
});

test("基线按会话记录：切换会话时记录目标会话当前结果", () => {
	const first = captureCompletionBaseline({}, { ready: true, sessionId: "s1", completionId: "run-1" });
	assert.equal(captureCompletionBaseline(first, { ready: true, sessionId: "s1", completionId: "run-2" }), first);
	const second = captureCompletionBaseline(first, { ready: true, sessionId: "s2", completionId: "run-9" });
	assert.equal(second.sessionId, "s2");
	assert.equal(second.completionId, "run-9");
});

test("个人工作台覆盖、后台、非当前栏、未在视口内都不确认", () => {
	assert.equal(shouldAcknowledgeCompletion({ ...base, covered: true }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, foreground: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, paneVisible: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, following: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, completionId: undefined }), false);
});
