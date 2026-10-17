import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionAttentionService } = loadTsCommonJs("src/main/sessions/attention/SessionAttentionService.ts");
const { SessionAttentionStore } = loadTsCommonJs("src/main/sessions/attention/SessionAttentionStore.ts");

/** 轻量替身：真实 AgentManager/Coordinator 的状态事件与绑定关系。 */
function createHarness() {
	const stateListeners = new Set();
	const runListeners = new Set();
	const askNotifiers = new Set();
	const bindings = new Map();
	let runtimes = [];
	let pending = [];
	const agents = {
		list: () => [],
		addStateListener(listener) {
			stateListeners.add(listener);
			return () => stateListeners.delete(listener);
		},
		onAgentRunFinished(listener) {
			runListeners.add(listener);
			return () => runListeners.delete(listener);
		},
	};
	const runtime = {
		listRuntimes: () => runtimes,
		listPendingUiRequests: () => pending,
		getRuntimeBinding: (agentId) => bindings.get(agentId),
		setAskChangeNotifier(listener) {
			if (listener) askNotifiers.add(listener);
		},
	};
	return {
		agents,
		runtime,
		bind(agentId, sessionId) {
			bindings.set(agentId, { sessionId, runtimeGeneration: 1 });
		},
		setRuntimes(items) {
			runtimes = items;
			for (const listener of stateListeners) listener();
		},
		setPending(items) {
			pending = items;
			for (const sessionId of new Set(items.map((item) => item.sessionId))) for (const notifier of askNotifiers) notifier(sessionId);
		},
		finish(agentId, outcome) {
			for (const listener of runListeners) listener({ agentId, outcome });
		},
	};
}

async function withService(run) {
	const dir = await mkdtemp(join(tmpdir(), "tpa-attention-service-"));
	const file = join(dir, "session-attention.json");
	const harness = createHarness();
	const store = new SessionAttentionStore({ getFilePath: () => file });
	const service = new SessionAttentionService({ agents: harness.agents, runtime: harness.runtime, store });
	try {
		await service.start();
		return await run({ service, harness, store });
	} finally {
		service.dispose();
		await rm(dir, { recursive: true, force: true });
	}
}

test("运行中不提前生成结果：直到收到该轮结束事件才写入最近结果", async () => {
	await withService(async ({ service, harness }) => {
		harness.bind("a1", "s1");
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		let summary = service.summaryFor("s1");
		assert.equal(summary.running, true);
		assert.equal(summary.completion, undefined, "执行期间没有完成结果");

		// 自动重试/压缩期间只会重复 running，不产生结束事件。
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		assert.equal(service.summaryFor("s1").completion, undefined);

		harness.finish("a1", "succeeded");
		summary = service.summaryFor("s1");
		assert.equal(summary.completion.outcome, "succeeded");
		assert.equal(summary.completionUnread, true);
	});
});

test("仅启动进程不算一轮执行：starting → idle 不留下虚假结果", async () => {
	await withService(async ({ service, harness, store }) => {
		harness.bind("a1", "s1");
		harness.setRuntimes([{ sessionId: "s1", status: "starting" }]);
		assert.equal(service.summaryFor("s1").running, true);
		harness.setRuntimes([{ sessionId: "s1", status: "idle" }]);
		const entry = store.get("s1");
		assert.equal(entry?.activeRunId, undefined, "启动进程没有开启执行轮次");
		assert.equal(entry?.completion, undefined);
	});
});

test("失败/停止/中断分类写入摘要；停止不产生新的未读", async () => {
	await withService(async ({ service, harness }) => {
		harness.bind("a1", "s1");
		for (const [outcome, expectedUnread] of [
			["failed", true],
			["interrupted", true],
			["aborted", false],
		]) {
			harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
			harness.finish("a1", outcome);
			const summary = service.summaryFor("s1");
			assert.equal(summary.completion.outcome, outcome);
			assert.equal(summary.completionUnread, expectedUnread);
			harness.setRuntimes([{ sessionId: "s1", status: "idle" }]);
		}
	});
});

test("已读确认按结果身份结算，且新一轮运行保留上一轮未读", async () => {
	await withService(async ({ service, harness }) => {
		harness.bind("a1", "s1");
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		harness.finish("a1", "succeeded");
		const first = service.summaryFor("s1").completion.id;
		assert.equal(service.acknowledge("s1", first).completionUnread, false);

		// 新一轮开始：上一轮已读状态不阻止显示运行态，旧结果仍在摘要里。
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		let summary = service.summaryFor("s1");
		assert.equal(summary.running, true);
		assert.equal(summary.completion.id, first);

		harness.finish("a1", "succeeded");
		const second = service.summaryFor("s1").completion.id;
		assert.notEqual(second, first);
		assert.equal(service.acknowledge("s1", first).completionUnread, true, "旧结果的迟到确认不清除新未读");
		assert.equal(service.acknowledge("s1", second).completionUnread, false);
	});
});

test("待回答摘要：单题取问题，批量题取第一题并保留题数", async () => {
	await withService(async ({ service, harness }) => {
		harness.setPending([{ sessionId: "s1", title: "[PI_DECK_PLAN_NEXT] 选择发布方式" }]);
		let summary = service.summaryFor("s1");
		assert.equal(summary.pendingQuestionCount, 1);
		assert.equal(summary.pendingQuestionSummary, "选择发布方式");

		harness.setPending([
			{ sessionId: "s1", title: "", batchQuestions: [{ question: "环境？" }, { question: "端口？" }] },
			{ sessionId: "s1", title: "", batchQuestions: [{ question: "第二个请求" }] },
		]);
		summary = service.summaryFor("s1");
		assert.equal(summary.pendingQuestionCount, 3, "两道批量题 + 一道单题");
		assert.equal(summary.pendingQuestionSummary, "环境？");

		harness.setPending([]);
		assert.equal(service.summaryFor("s1").pendingQuestionCount, 0);
	});
});

test("状态推送只包含受影响的会话且去重", async () => {
	await withService(async ({ service, harness }) => {
		harness.bind("a1", "s1");
		harness.bind("a2", "s2");
		const seen = [];
		service.subscribe((summary) => seen.push(`${summary.sessionId}:${summary.running}`));
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		harness.setRuntimes([{ sessionId: "s1", status: "running" }]);
		harness.setRuntimes([
			{ sessionId: "s1", status: "running" },
			{ sessionId: "s2", status: "running" },
		]);
		assert.deepEqual(seen, ["s1:true", "s2:true"]);
	});
});
