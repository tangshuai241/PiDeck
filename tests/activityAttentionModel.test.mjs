import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { collectAttentionActivityRows, countAttentionActivity, matchesActivityFilter } = loadTsCommonJs("src/renderer/src/components/sidebar/activitySessionsModel.ts");
const { presentSessionStatus } = loadTsCommonJs("src/renderer/src/utils/sessionStatusPresentation.ts");

function catalog() {
	return {
		projects: [{ id: "p1" }],
		agents: [{ id: "a1", projectId: "p1", title: "运行中", status: "running", createdAt: 1 }],
		runtimeBySessionId: { s1: { agentId: "a1" }, s2: {}, s3: {} },
		sessionsByProject: {
			p1: [
				{ id: "s1", projectId: "p1", title: "运行中", updatedAt: 300 },
				{ id: "s2", projectId: "p1", title: "待回答", updatedAt: 200 },
				{ id: "s3", projectId: "p1", title: "未读结果", updatedAt: 100 },
				{ id: "s4", projectId: "p1", title: "已读空闲", updatedAt: 50 },
			],
		},
	};
}

function attentionById() {
	return {
		s1: { sessionId: "s1", running: true, pendingQuestionCount: 0, completionUnread: false },
		s2: { sessionId: "s2", running: false, pendingQuestionCount: 2, pendingQuestionSummary: "环境？", completionUnread: false },
		s3: { sessionId: "s3", running: false, pendingQuestionCount: 0, completionUnread: true, completion: { id: "run-3", outcome: "failed", finishedAt: 90 } },
		s4: { sessionId: "s4", running: false, pendingQuestionCount: 0, completionUnread: false, completion: { id: "run-4", outcome: "succeeded", finishedAt: 40 } },
	};
}

test("活动行按会话收集：运行/待回答/未读留在列表，纯已读结果不占位", () => {
	const rows = collectAttentionActivityRows(catalog(), attentionById());
	assert.equal(rows.map((row) => row.session.id).join(","), "s1,s2,s3");
	assert.equal(rows[1].attention.pendingQuestionSummary, "环境？");
	assert.equal(rows[2].session.title, "未读结果");
});

test("筛选数量按会话计数；一个会话多道题仍算一个待回答会话", () => {
	const rows = collectAttentionActivityRows(catalog(), attentionById());
	const counts = countAttentionActivity(rows);
	assert.equal(counts.pending, 1);
	assert.equal(counts.unread, 1);
	assert.equal(counts.running, 1);
	assert.equal(
		rows
			.filter((row) => matchesActivityFilter(row, "pending"))
			.map((row) => row.session.id)
			.join(","),
		"s2",
	);
	assert.equal(
		rows
			.filter((row) => matchesActivityFilter(row, "unread"))
			.map((row) => row.session.id)
			.join(","),
		"s3",
	);
});

test("进程退出后未读结果仍可从摘要找到（不依赖 runtime 绑定）", () => {
	const rows = collectAttentionActivityRows(catalog(), attentionById());
	const detached = rows.find((row) => row.session.id === "s3");
	assert.equal(detached.agent, undefined);
	assert.equal(matchesActivityFilter(detached, "unread"), true);
});

test("统一状态规则：运行优先；待回答静态；未读显示结果类型；已停止不再提醒", () => {
	assert.equal(presentSessionStatus({ status: "running" }).kind, "running");
	// Agent 阻塞在提问时优先显示静态待回答，而不是旋转中的「运行中」。
	assert.equal(presentSessionStatus({ status: "running", attention: { running: true, pendingQuestionCount: 1, completionUnread: false } }).kind, "waiting");
	assert.equal(presentSessionStatus({ status: "running", busy: true, attention: { running: true, pendingQuestionCount: 1, completionUnread: false } }).kind, "running");
	const waiting = presentSessionStatus({ status: "idle", attention: { running: false, pendingQuestionCount: 2, pendingQuestionSummary: "环境？", completionUnread: true, completion: { id: "r", outcome: "failed", finishedAt: 1 } } });
	assert.equal(waiting.kind, "waiting");
	assert.equal(waiting.summary, "环境？");
	const unread = presentSessionStatus({ status: "idle", attention: { running: false, pendingQuestionCount: 0, completionUnread: true, completion: { id: "r", outcome: "interrupted", finishedAt: 1 } } });
	assert.equal(unread.kind, "unread");
	assert.equal(unread.outcome, "interrupted");
	assert.equal(unread.labelKey, "app.statusUnreadInterrupted");
	const stopped = presentSessionStatus({ attention: { running: false, pendingQuestionCount: 0, completionUnread: false, completion: { id: "r", outcome: "aborted", finishedAt: 1 } } });
	assert.equal(stopped.kind, "stopped");
	assert.equal(presentSessionStatus({ status: "idle" }).kind, "idle");
	assert.equal(presentSessionStatus({}).kind, "none");
});
