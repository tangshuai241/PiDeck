/**
 * 文稿分发的失败归类（真实验收缺陷回归）。
 *
 * 现象：真机上「选择保存目录」后绑定失败，操作被记成 RUNTIME_CHANGED（「会话运行进程已变化」），
 * 但会话运行三元组没变——真正原因是宿主守卫拦下了命令（或扩展未加载）。调用方原先只看
 * `accepted`，把任何非失败都翻译成「进程变了」，排障方向完全相反。
 *
 * 这里驱动真实文稿域（准备 → 启动 → 结算），只让运行时端口返回宿主给的结构化分类，
 * 断言操作错误码与记录里的错误码：分类必须如实落盘，且不能把「命令没被转发」伪装成可重试的换代。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ID, createHarness, createWork, prepareCreate, startRound } from "./helpers/documentWorkServiceHarness.mjs";

/** 一次「准备 → 启动」：启动阶段的绑定被宿主拒绝，返回归档后的操作记录。 */
async function startWithRejection(rejection) {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);
		harness.state.bindRejection = rejection;
		const started = await startRound(harness, view, prepared, "req-bind", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		// 分发被拒时 start 直接返回失败结果；记录里仍要结算成同一种错误码（下面逐项断言）。
		assert.equal(started.ok, false, JSON.stringify(started));
		return { harness, view, started, operation: await harness.terminal(view.workId, "req-bind") };
	} catch (error) {
		await harness.cleanup();
		throw error;
	}
}

test("扩展不可用：记 EXTENSION_UNAVAILABLE，而不是「进程变了」", async () => {
	const { harness, started, operation } = await startWithRejection({ reason: "extension_unavailable", error: "mainAgent.documentWorkUnavailable" });
	try {
		assert.equal(operation.phase, "failed");
		assert.equal(operation.error.code, "EXTENSION_UNAVAILABLE");
		assert.equal(started.error.code, "EXTENSION_UNAVAILABLE");
		assert.equal(operation.error.retryable, false);
		assert.equal(operation.dispatchUnknown, false);
	} finally {
		await harness.cleanup();
	}
});

test("宿主策略拦截：记 COMMAND_BLOCKED（新码），且被写入记录后仍按原码读回", async () => {
	const { harness, view, started, operation } = await startWithRejection({ reason: "alignment_blocked", error: "mainAgent.alignmentCommandBlocked" });
	try {
		assert.equal(operation.phase, "failed");
		assert.equal(operation.error.code, "COMMAND_BLOCKED");
		assert.equal(started.error.code, "COMMAND_BLOCKED");
		assert.equal(operation.error.retryable, false);
		// 读回路径要过记录解析的错误码白名单：新码必须被认，不能静默降级或丢字段。
		const reread = await harness.domain.service.getOperation(view.workId, "req-bind", SESSION_ID);
		assert.equal(reread.ok, true, JSON.stringify(reread));
		assert.equal(reread.value.error.code, "COMMAND_BLOCKED");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length, 0, "绑定没成功就不许发批准");
	} finally {
		await harness.cleanup();
	}
});

test("载荷不合法：记 INVALID_INPUT", async () => {
	const { harness, started, operation } = await startWithRejection({ reason: "invalid_input", error: "mainAgent.documentWorkInvalidCommand" });
	try {
		assert.equal(operation.error.code, "INVALID_INPUT");
		assert.equal(started.error.code, "INVALID_INPUT");
	} finally {
		await harness.cleanup();
	}
});

test("没有分类的老宿主/内部异常：维持 RUNTIME_CHANGED 与可重试语义", async () => {
	const { harness, started, operation } = await startWithRejection({ error: "runtime unavailable" });
	try {
		assert.equal(operation.error.code, "RUNTIME_CHANGED");
		assert.equal(started.error.code, "RUNTIME_CHANGED");
		assert.equal(operation.error.retryable, true);
	} finally {
		await harness.cleanup();
	}
});

test("发送结果未知：仍单独结算成 unknown，保留活动记录等待用户处理", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		harness.state.bindRejection = { reason: "runtime_changed", error: "transport lost", unknown: true };
		const started = await startRound(harness, view, prepared, "req-unknown", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
		assert.equal(started.ok, false);
		assert.equal(started.error.code, "DISPATCH_UNKNOWN");
		const operation = await harness.terminal(view.workId, "req-unknown");
		assert.equal(operation.phase, "unknown");
		assert.equal(operation.error.code, "DISPATCH_UNKNOWN");
		assert.equal(harness.state.dispatched.filter((message) => message.startsWith("/tpa-work release")).length, 0, "未知结果不许释放/重放");
	} finally {
		await harness.cleanup();
	}
});
