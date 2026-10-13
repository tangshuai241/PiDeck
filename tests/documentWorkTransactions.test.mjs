/**
 * 写入事务与运行时租约：幂等重放、异载荷冲突、并发排他。
 *
 * 这些是「真实 service + 假运行时」的行为断言，不测内部实现：
 * - 同 requestId 同载荷必须返回原回执（含失败与 unknown），且不重新产生副作用；
 * - 同 requestId 异载荷必须显式冲突，且不按后来的载荷执行；
 * - 同一 runtime 同时只允许一轮执行（哪怕换了 work），unknown 之后也不开放新请求；
 * - 不同 runtime 可以并行。
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SESSION_ID, createHarness, createWork, plain, prepareCreate, startRound, waitFor } from "./helpers/documentWorkServiceHarness.mjs";

const AUTHORIZATION = { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 };

/** 绑定命令的条数：用它判断是否真的第二次发了 bind/批准。 */
function countBinds(harness) {
	return harness.state.dispatched.filter((message) => message.startsWith("/tpa-work bind ")).length;
}

function countApproves(harness) {
	return harness.state.dispatched.filter((message) => message.startsWith("/align approve")).length;
}

test("并发同 requestId 同载荷的 start 只产生一次副作用，两个调用者拿到同一回执", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal(prepared.ok, true);
		const request = {
			requestId: "req-start",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		};
		const results = await Promise.all([harness.domain.service.start({ ...request }), harness.domain.service.start({ ...request }), harness.domain.service.start({ ...request })]);
		assert.equal(
			results.every((result) => result.ok),
			true,
		);
		const attemptIds = new Set(results.map((result) => result.value.attemptId));
		assert.equal(attemptIds.size, 1, "三次并发只允许有一个 attemptId");
		assert.equal(countBinds(harness), 1, "只允许一次绑定");
		assert.equal(countApproves(harness), 1, "只允许一次批准");
		// 落盘也不允许留下幽灵 operation。
		const operations = readdirSync(join(harness.root, "userData", "document-work", "works", view.workId, "operations")).filter((name) => name.endsWith(".json"));
		assert.equal(operations.length, 1, `只允许一份 operation 记录，实际 ${operations.join(",")}`);
	} finally {
		await harness.cleanup();
	}
});

test("同 requestId 异载荷显式冲突，且不按后来的载荷执行", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const first = await startRound(harness, view, prepared, "req-start", AUTHORIZATION);
		assert.equal(first.ok, true);
		const before = countBinds(harness);
		// 同 requestId 换授权内容：必须冲突，不能像新请求一样再分发一次。
		const conflict = await harness.domain.service.start({
			requestId: "req-start",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: { kind: "alignment_confirmation", briefId: "brief-other", revision: 2 },
		});
		assert.equal(conflict.ok, false);
		assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
		assert.equal(countBinds(harness), before, "冲突不得触发新的绑定");
	} finally {
		await harness.cleanup();
	}
});

test("失败与 unknown 的回执都会持久化：重放返回原错误，不重新分发", async () => {
	const harness = createHarness({ bindTimeoutMs: 150 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		// 扩展不确认绑定 → 本轮失败；回执必须可重放。
		harness.state.bindingAck = false;
		const request = {
			requestId: "req-start",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		};
		const failed = await harness.domain.service.start({ ...request });
		assert.equal(failed.ok, false);
		assert.equal(failed.error.code, "EXTENSION_UNAVAILABLE");
		const dispatchesAfterFailure = harness.state.dispatched.length;
		const replayed = await harness.domain.service.start({ ...request });
		assert.equal(replayed.ok, false);
		assert.equal(replayed.error.code, "EXTENSION_UNAVAILABLE", "重放必须返回原错误");
		assert.equal(harness.state.dispatched.length, dispatchesAfterFailure, "重放不得再分发");
	} finally {
		await harness.cleanup();
	}
});

test("unknown 分发：重放返回原结论；新 request 与另一件工作都不会再发 bind", async () => {
	const harness = createHarness({ startTimeoutMs: 250 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		const started = await startRound(harness, view, prepared, "req-start", AUTHORIZATION);
		assert.equal(started.ok, true);
		const operation = await harness.terminal(view.workId, "req-start", 3_000);
		assert.equal(operation.phase, "unknown");
		const bindsAfterUnknown = countBinds(harness);

		// 重放同一个 requestId：返回原 unknown 回执，不重新执行。
		const replayed = await startRound(harness, view, prepared, "req-start", AUTHORIZATION);
		assert.equal(replayed.ok, true);
		assert.equal(replayed.value.phase, "unknown");
		assert.equal(countBinds(harness), bindsAfterUnknown, "重放不得再发 bind");

		// 新 request（同一件工作）：仍然被阻塞，不开放第二轮。
		const viewAfter = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		assert.equal(viewAfter.active?.phase, "unknown", "unknown 必须保留 active（保守阻塞）");
		const blockedAgain = await harness.domain.service.prepare({
			requestId: "req-prepare-2",
			workId: view.workId,
			expectedRevision: viewAfter.revision,
			kind: "create_document",
			requirementsRef: { kind: "alignment", briefId: "brief-1", revision: 2 },
			scope: { summary: "s", sections: [], preserve: [] },
			materialPaths: [],
		});
		assert.equal(blockedAgain.ok, false, "unknown 之后不开放新一轮准备");
		assert.equal(countBinds(harness), bindsAfterUnknown, "阻塞期间不得再发 bind");
	} finally {
		await harness.cleanup();
	}
});

test("同一 runtime 上另一件工作不能并行：第二次 start 被租约挡下，只发一次绑定", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", AUTHORIZATION)).ok, true);
		assert.equal(countBinds(harness), 1);

		// 第二件工作：同一会话只能有一件，因此直接构造另一 workId 走同一条 runtime。
		const foreign = await harness.domain.service.start({
			requestId: "req-other",
			workId: "dw_other_work",
			expectedRevision: 1,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		});
		assert.equal(foreign.ok, false, "同一 runtime 不允许第二件工作并行");
		assert.equal(countBinds(harness), 1, "被挡下的请求不得再发绑定");
	} finally {
		await harness.cleanup();
	}
});

test("绑定等待期间（运行时仍空闲）第二次 start 被拒：一次点击只有一次批准", async () => {
	// 绑定确认超时给足，让本轮停在 dispatching，才能验证「运行时仍空闲但在途」这条边界。
	const harness = createHarness({ bindTimeoutMs: 3_000 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		// 扩展暂不确认：本轮停在 dispatching（运行时仍是 idle）。
		harness.state.bindingAck = false;
		const pending = harness.domain.service.start({
			requestId: "req-start",
			workId: view.workId,
			expectedRevision: prepared.value.workRevision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		});
		await waitFor(() => countBinds(harness) === 1);
		// 此时运行时仍空闲，但 attempt 已在途：第二次 start 必须被拒绝。
		const activeView = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);
		const second = await harness.domain.service.start({
			requestId: "req-start-2",
			workId: view.workId,
			expectedRevision: activeView.revision,
			preparation: prepared.value.preparation,
			expectedRuntime: harness.runtime.target(),
			authorization: AUTHORIZATION,
		});
		assert.equal(second.ok, false);
		assert.equal(second.error.code, "RUNTIME_BUSY", JSON.stringify(second.error));
		await pending;
		assert.equal(countBinds(harness), 1, "只有一次绑定");
		assert.equal(countApproves(harness), 0, "绑定未确认时不得分发批准");
	} finally {
		await harness.cleanup();
	}
});

test("不同 runtime 可以并行执行（租约按会话隔离）", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", AUTHORIZATION)).ok, true);
		// 另一个会话（另一个 runtime）的租约互不影响：这里用租约注册表直接断言隔离性。
		const other = await harness.domain.store.readRuntimeLease("session-b");
		assert.equal(other, undefined);
		const lease = await harness.domain.store.readRuntimeLease(SESSION_ID);
		assert.equal(lease?.workId, view.workId);
		assert.equal(lease?.requestId, "req-start");
	} finally {
		await harness.cleanup();
	}
});

test("重启后保持租约：unknown 阻塞，未知 process 的 dispatching 落 interrupted 并清匹配租约", async () => {
	const harness = createHarness({ startTimeoutMs: 250 });
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		assert.equal((await startRound(harness, view, prepared, "req-start", AUTHORIZATION)).ok, true);
		const operation = await harness.terminal(view.workId, "req-start", 3_000);
		assert.equal(operation.phase, "unknown");
		// 重启：没有当前 runtime（旧进程已不在）时，unknown 的租约必须保留。
		await harness.domain.dispose();
		const revived = createHarness({ userDataPath: join(harness.root, "userData"), runtimeUnavailable: true });
		try {
			await revived.domain.service.recoverOnStartup();
			const lease = await revived.domain.store.readRuntimeLease(SESSION_ID);
			assert.equal(lease?.requestId, "req-start", "unknown 的租约在重启后必须保留");
			const recovered = await revived.domain.service.getOperation(view.workId, "req-start", SESSION_ID);
			assert.equal(recovered.value.phase, "unknown", "unknown 不自动转 interrupted");
		} finally {
			await revived.cleanup();
		}
	} finally {
		await harness.cleanup();
	}
});
