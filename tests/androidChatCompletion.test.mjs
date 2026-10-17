import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { captureChatCompletionBaseline, isPreexistingChatCompletion } = loadTsCommonJs("apps/android/src/chatCompletion.ts");

test("进入会话时没有未读：随后完成的结果是新结果，应自动确认", () => {
	const baseline = captureChatCompletionBaseline({}, { sessionId: "s1", completionId: undefined });
	assert.equal(isPreexistingChatCompletion(baseline, "s1", "run-1"), false);
});

test("进入会话时已有未读：不自动确认，点按提示或滚回底部后才确认", () => {
	const baseline = captureChatCompletionBaseline({}, { sessionId: "s1", completionId: "run-1" });
	assert.equal(isPreexistingChatCompletion(baseline, "s1", "run-1"), true);
	// 新结果替换旧结果后变成“新结果”。
	assert.equal(isPreexistingChatCompletion(baseline, "s1", "run-2"), false);
});

test("基线按会话保留：同一会话的列表更新不会重写基线，切换会话才重记", () => {
	const first = captureChatCompletionBaseline({}, { sessionId: "s1", completionId: undefined });
	assert.equal(captureChatCompletionBaseline(first, { sessionId: "s1", completionId: "run-1" }), first);
	const second = captureChatCompletionBaseline(first, { sessionId: "s2", completionId: "run-9" });
	assert.equal(second.sessionId, "s2");
	assert.equal(second.completionId, "run-9");
	assert.equal(isPreexistingChatCompletion(second, "s1", "run-1"), false);
});
