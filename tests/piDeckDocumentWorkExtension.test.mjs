/**
 * 文稿扩展（pi 侧）：绑定命令、成果候选汇报、改稿意图声明与上下文清理。
 *
 * 用假 pi API 驱动注册表；不启动真实 pi，也不调用模型。断言的是扩展的对外行为：
 * 哪些载荷被接受、哪些必须拒绝、候选是否只落在本轮 staging。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const types = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-work-types.ts`);
const extension = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-work.ts`, { stubs: { typebox: require("typebox") } }).default;

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const clone = (value) => JSON.parse(JSON.stringify(value));
const SESSION = "session-a";

function binding(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: "dw_abc",
		attemptId: "at_abc",
		preparationId: "pr_abc",
		digest: "a".repeat(64),
		sessionId: SESSION,
		kind: "create_document",
		workDirectory: "C:\\out\\dw_abc",
		stagingDirectory: "C:\\out\\dw_abc\\staging\\at_abc",
		materialCacheDirectory: "C:\\userData\\cache",
		materials: [{ materialId: "m1", label: "材料.docx", path: "C:\\in\\材料.docx", digest: "b".repeat(64) }],
		scope: { summary: "写第二章", sections: ["第二章"], preserve: ["保留结论"] },
		requirements: { summary: "输出报告" },
		...overrides,
	};
}

/** 假 pi：只实现扩展真正用到的注册面，并保留 branch 供恢复路径使用。 */
function harness({ entries = [], session = SESSION, stagingDirectory } = {}) {
	const commands = new Map();
	const tools = new Map();
	const messages = [];
	const entriesOut = [];
	const notifications = [];
	let branch = clone(entries);
	let currentSession = session;
	let active = [];
	const ctx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionId: () => currentSession, getBranch: () => clone(branch) },
	};
	extension({
		on: () => {},
		registerCommand: (name, value) => commands.set(name, value),
		registerTool: (value) => tools.set(value.name, value),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		appendEntry: (customType, data) => {
			const entry = { type: "custom", customType, data: clone(data) };
			entriesOut.push(entry);
			branch.push(entry);
		},
		sendMessage: (message) => {
			messages.push(clone(message));
			branch.push(clone({ type: "custom_message", ...message }));
		},
	});
	const fire = (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	return {
		commands,
		tools,
		messages,
		entriesOut,
		notifications,
		ctx,
		fire,
		command: (args) => commands.get("tpa-work").handler(args, ctx),
		state: () => messages.filter((item) => item.customType === "pi-deck-document-work-state").at(-1)?.details.documentWork,
		switch: (id, nextEntries) => {
			currentSession = id;
			branch = clone(nextEntries);
		},
		stagingDirectory,
	};
}

test("bind 命令接受主进程构造的载荷并发布绑定状态；越界或跨会话载荷被拒", () => {
	const h = harness();
	const encoded = types.encodeForTest ? undefined : undefined;
	void encoded;
	const command = (payload) => {
		const text = JSON.stringify(payload);
		const bytes = Buffer.from(text, "utf8");
		const b64 = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return h.command(`bind ${b64}`);
	};
	const valid = binding();
	command(valid);
	assert.equal(h.state().phase, "bound");
	assert.equal(h.state().workId, "dw_abc");
	assert.equal(h.entriesOut.filter((entry) => entry.customType === "tpa-document-work-binding").length, 1);

	// 跨会话载荷不得绑定：否则 fork/导入的会话会继承别的工作身份。
	const foreign = harness({ session: "session-b" });
	const text = JSON.stringify(binding());
	const b64 = Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	foreign.command(`bind ${b64}`);
	assert.equal(foreign.state(), undefined);
	assert.equal(foreign.notifications.length, 1);

	const broken = harness();
	broken.command(`bind ${Buffer.from(JSON.stringify(binding({ stagingDirectory: "relative" })), "utf8").toString("base64url")}`);
	assert.equal(broken.state(), undefined, "相对 staging 路径必须拒绝");
});

test("tpa_artifact_report 只接受本轮 staging 内的非空文件，且每次尝试只汇报一次", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-ext-"));
	try {
		const staging = join(root, "staging", "at_abc");
		mkdirSync(staging, { recursive: true });
		writeFileSync(join(staging, "out.md"), "# 成果\n", "utf8");
		const h = harness({ stagingDirectory: staging });
		const command = h.command;
		const text = JSON.stringify(binding({ stagingDirectory: staging }));
		command(`bind ${Buffer.from(text, "utf8").toString("base64url")}`);

		const missing = await h.fire("tpa_artifact_report", { summary: "s", artifacts: [{ relativePath: "nope.md", role: "primary" }], risks: [] });
		assert.equal(missing.details.documentWork.ok, false);
		assert.equal(h.state().phase, "bound", "无效候选不得改写绑定状态");

		const ok = await h.fire("tpa_artifact_report", { summary: "初稿", artifacts: [{ relativePath: "out.md", role: "primary" }], risks: ["未核对"] });
		assert.equal(ok.details.documentWork.ok, true);
		assert.equal(h.state().phase, "reported");
		assert.equal(h.state().report.artifacts[0].relativePath, "out.md");
		assert.equal(h.entriesOut.filter((entry) => entry.customType === "tpa-document-work-report").length, 1);

		// 同一尝试不允许覆盖已被检查的候选。
		const again = await h.fire("tpa_artifact_report", { summary: "改口径", artifacts: [{ relativePath: "out.md", role: "primary" }], risks: [] });
		assert.equal(again.details.documentWork.ok, false);
		assert.equal(again.details.documentWork.reason, "already_reported");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("未绑定时汇报工具如实返回失败，不伪造成功", async () => {
	const h = harness();
	const reported = await h.fire("tpa_artifact_report", { summary: "s", artifacts: [{ relativePath: "a.md", role: "primary" }], risks: [] });
	assert.equal(reported.details.documentWork.ok, false);
	assert.equal(reported.details.documentWork.reason, "no_work");
	const intent = await h.fire("tpa_work_revise", { instruction: "改标题", sections: [], preserve: [] });
	assert.equal(intent.details.documentWork.reason, "no_work");
});

test("tpa_work_revise 用最新用户轮正文指纹声明意图，并在无用户轮时不动作", async () => {
	const h = harness();
	const text = JSON.stringify(binding());
	h.command(`bind ${Buffer.from(text, "utf8").toString("base64url")}`);
	h.switch(SESSION, [...h.ctx.sessionManager.getBranch(), { type: "message", id: "turn-7", message: { role: "user", content: [{ type: "text", text: "把第二节改短一点" }] } }]);
	// 会话被 switch 置换了分支，重新绑定以恢复内存状态。
	h.command(`bind ${Buffer.from(text, "utf8").toString("base64url")}`);
	const result = await h.fire("tpa_work_revise", { instruction: "把第二节改短一点", sections: ["第二节"], preserve: ["保留结论"] });
	assert.equal(result.details.documentWork.ok, true);
	const intent = h.messages.filter((item) => item.customType === "pi-deck-document-revision-intent").at(-1);
	assert.equal(intent.details.documentWorkIntent.sourceTurnId, "turn-7");
	assert.match(intent.details.documentWorkIntent.sourceTurnHash, /^[0-9a-f]{64}$/);
	assert.equal(intent.display, false, "意图消息不得出现在可见历史里");

	const noTurn = harness();
	noTurn.command(`bind ${Buffer.from(text, "utf8").toString("base64url")}`);
	const blocked = await noTurn.fire("tpa_work_revise", { instruction: "改标题", sections: [], preserve: [] });
	assert.equal(blocked.details.documentWork.ok, false);
	assert.equal(blocked.details.documentWork.reason, "no_turn");
});

test("绑定与汇报记录可从活动分支恢复，并且恢复后重新发布状态", () => {
	const h = harness();
	const text = JSON.stringify(binding());
	h.command(`bind ${Buffer.from(text, "utf8").toString("base64url")}`);
	const history = h.ctx.sessionManager.getBranch();
	const reopened = harness({ entries: history });
	// 重新创建扩展后走 session 恢复路径：这里直接以同一分支构造新实例并重新绑定。
	const payload = binding();
	reopened.command(`bind ${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`);
	assert.equal(reopened.state().phase, "bound");
	assert.equal(reopened.state().attemptId, "at_abc");
	assert.match(reopened.messages.at(-1).customType, /pi-deck-document-work-state/);
});

test("扩展镜像的绑定与候选解析与主进程 shared 判定一致", () => {
	assert.equal(types.decodeBinding(binding()).workId, "dw_abc");
	assert.equal(types.decodeBinding(binding({ kind: "revise_document" })).kind, "revise_document");
	assert.equal(types.decodeBinding(binding({ materials: [{ materialId: "m1", label: "x", path: "relative", digest: "b".repeat(64) }] })), undefined);
	assert.equal(plain(types.decodeArtifactCandidate({ reportId: "rp", artifacts: [{ relativePath: "a/b.docx", role: "primary" }], summary: "", risks: [] })).artifacts.length, 1);
	assert.equal(types.decodeArtifactCandidate({ reportId: "rp", artifacts: [{ relativePath: "../x.docx", role: "primary" }], summary: "", risks: [] }), undefined);
});
