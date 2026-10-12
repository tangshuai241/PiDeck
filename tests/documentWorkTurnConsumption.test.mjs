/**
 * 改稿消费的是「用户轮」，不是那段文字。
 *
 * 边界（评审）：
 * - 同一轮不能被消费两次：重新挂载/重启后，历史里那条相同的用户消息不得再次触发执行；
 * - 用户在新的一轮里又说了一遍同样的改稿要求，属于新授权，不能被正文 hash 永久挡掉。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_SESSION_ID, SESSION_ID, TURN_HASH, TURN_TEXT, createDocumentWorkDomain, createHarness, createWork, plain, prepareCreate, startRound, waitFor } from "./helpers/documentWorkServiceHarness.mjs";

const CREATE_ROUND = ["# 季度报告", "", "第一节 概述", "", "原始结论", "", "第二节 方法", "", "可以改的部分", ""].join("\n");

async function archiveInitialDraft(harness, view, prepared) {
	await startRound(harness, view, prepared, "req-start", { kind: "alignment_confirmation", briefId: "brief-1", revision: 2 });
	await harness.finishRound(CREATE_ROUND);
	await harness.terminal(view.workId, "req-start");
}

/** 追加一条真实用户轮（新消息 id，正文可以与旧轮相同）。 */
function pushUserTurn(harness, text, id) {
	harness.state.messages.push({ id, role: "user", text, agentId: "agent-a", timestamp: Date.now() });
}

test("新轮里重复同一句改稿要求属于新授权，可以再次开工", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		await archiveInitialDraft(harness, view, prepared);
		const afterArchive = plain((await harness.domain.service.getView(view.workId, SESSION_ID)).value);

		// 第一轮明确改稿（turn-2）。
		pushUserTurn(harness, TURN_TEXT, "turn-2");
		const firstTurn = await harness.domain.service.autoRevise(SESSION_ID, "auto-1");
		assert.equal(firstTurn.ok, true, JSON.stringify(firstTurn));
		assert.equal(firstTurn.value.engaged, true, "明确改稿要求必须自动接续");
		await waitFor(() => harness.state.dispatched.some((message) => message.startsWith("改稿要求：")));
		await harness.finishRound(`${CREATE_ROUND}\n# 第三节 结论\n\n新结论\n`);
		assert.equal((await harness.terminal(view.workId, "auto-1_s")).phase, "archived");

		// 用户在新的一轮里又说了一遍同样的话：正文 hash 相同，但这是新的授权。
		pushUserTurn(harness, TURN_TEXT, "turn-3");
		harness.runtime.busy();
		const secondTurn = await harness.domain.service.autoRevise(SESSION_ID, "auto-2");
		harness.runtime.settle();
		assert.equal(secondTurn.ok, true, JSON.stringify(secondTurn));
		assert.equal(secondTurn.value.engaged, true, "新轮里的相同文字必须被当成新授权");
		await waitFor(() => harness.state.dispatched.filter((message) => message.startsWith("改稿要求：")).length === 2, 3_000);
		const prompts = harness.state.dispatched.filter((message) => message.startsWith("改稿要求："));
		assert.equal(prompts.length, 2, `两轮各派发一次改稿提示，实际 ${prompts.length}`);
	} finally {
		await harness.cleanup();
	}
});

test("同一轮不能消费两次：重启后同一历史轮不再自动执行", async () => {
	const harness = createHarness();
	try {
		const view = await createWork(harness);
		harness.alignment();
		const prepared = await prepareCreate(harness, view);
		await archiveInitialDraft(harness, view, prepared);

		pushUserTurn(harness, TURN_TEXT, "turn-2");
		harness.runtime.busy();
		const first = await harness.domain.service.autoRevise(SESSION_ID, "auto-1");
		assert.equal(first.value.engaged, true);
		harness.runtime.settle();
		await waitFor(() => harness.state.dispatched.some((message) => message.startsWith("改稿要求：")));
		// 让这一轮正常结算，避免用「在途」状态去检验轮消费。
		await harness.finishRound(`${CREATE_ROUND}
# 第三节 结论

新结论
`);
		assert.equal((await harness.terminal(view.workId, "auto-1_s")).phase, "archived");
		// 轮标识在 start 时就已经落盘消费（不必等归档）。
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(record.consumedRevisionTurnIds.includes("turn-2"), true, "消费的是轮标识");
		assert.equal(record.consumedRevisionTurns.includes(TURN_HASH), true, "正文指纹同时留档");

		// 重挂载（同一 userData 重建域）后，同一条历史消息不得再次触发。
		const revived = createDocumentWorkDomain({
			userDataPath: joinRoot(harness),
			runtimePort: {
				readRuntime: async () => ({ target: harness.runtime.target(), status: "idle", state: {}, messages: harness.state.messages, nativeSessionId: NATIVE_SESSION_ID }),
				dispatch: async () => ({ accepted: true, unknown: false }),
				abort: async () => ({ accepted: true, unknown: false }),
				hasDispatchInFlight: () => false,
				subscribeOutputs: () => () => {},
				subscribePiEvents: () => () => {},
			},
			materials: { isAllowed: async () => false },
			onChanged: () => {},
			logger: { info: () => {}, warn: () => {} },
		});
		try {
			const again = await revived.service.autoRevise(SESSION_ID, "auto-2");
			assert.equal(again.ok, true);
			assert.equal(again.value.engaged, false, "同一轮不得重复执行");
			// 即便绕过 autoRevise 直接准备+开始，也必须被轮标识挡住。
			const direct = await revived.service.prepare({
				requestId: "direct-1",
				workId: view.workId,
				expectedRevision: (await revived.store.getRecord(view.workId)).revision,
				kind: "revise_document",
				requirementsRef: { kind: "user_instruction", sourceTurnId: "turn-2", sourceTurnHash: TURN_HASH },
				scope: { summary: TURN_TEXT, sections: [], preserve: [], allow: ["第二节"] },
				materialPaths: [],
			});
			assert.equal(direct.ok, true, JSON.stringify(direct));
			const runtime = harness.runtime.target();
			const started = await revived.service.start({
				requestId: "direct-2",
				workId: view.workId,
				expectedRevision: direct.value.workRevision,
				preparation: direct.value.preparation,
				expectedRuntime: runtime,
				authorization: { kind: "revision_instruction", sourceTurnId: "turn-2", sourceTurnHash: TURN_HASH },
			});
			assert.equal(started.ok, false, "同一轮不得被消费两次");
			assert.equal(started.error.code, "APPROVAL_REQUIRED");
			assert.equal(started.error.detail, "instruction_replayed");
		} finally {
			await revived.dispose();
		}
	} finally {
		await harness.cleanup();
	}
});

function joinRoot(harness) {
	return `${harness.root}/userData`;
}
