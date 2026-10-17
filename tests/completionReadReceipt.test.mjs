import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldAcknowledgeCompletion } = loadTsCommonJs("src/renderer/src/utils/sessionCompletionRead.ts");

const base = { completionId: "run-1", foreground: true, paneVisible: true, covered: false, following: true, preexisting: false, focusRequested: false, becameFollowing: false };

test("可见的新结果直接确认已读", () => {
	assert.equal(shouldAcknowledgeCompletion(base), true);
});

test("仅打开应用/恢复缓存不确认旧结果", () => {
	assert.equal(shouldAcknowledgeCompletion({ ...base, preexisting: true }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, preexisting: true, focusRequested: true }), true);
	assert.equal(shouldAcknowledgeCompletion({ ...base, preexisting: true, becameFollowing: true }), true);
});

test("个人工作台覆盖、后台、非当前栏、未在视口内都不确认", () => {
	assert.equal(shouldAcknowledgeCompletion({ ...base, covered: true }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, foreground: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, paneVisible: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, following: false }), false);
	assert.equal(shouldAcknowledgeCompletion({ ...base, completionId: undefined }), false);
});
