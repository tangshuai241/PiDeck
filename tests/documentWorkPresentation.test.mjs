/**
 * 文稿卡片呈现策略（纯函数）：状态区分「已归档 / 检查失败 / 分发未知 / 已中断」，
 * 不用一个「完成」把不同事实糊在一起。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const presentation = loadTsCommonJs(`${ROOT}/src/renderer/src/utils/documentWorkPresentation.ts`);

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function view(overrides = {}) {
	return {
		workId: "dw_1",
		sessionId: "session-a",
		revision: 3,
		title: "报告",
		outputRootLabel: "文稿",
		requirementsSummary: "",
		active: null,
		versions: [{ versionId: "v_1", ordinal: 1, title: "报告", fileName: "out.md", inspection: "passed", userAcceptance: "not_collected", manualModification: false, createdAt: 1 }],
		revisionReady: true,
		...overrides,
	};
}

const derive = (input) => plain(presentation.deriveDocumentWorkCardPresentation({ phase: "idle", ...input }));

test("首次提交后没有工作也没有输出根时提示选择保存位置，其余情况隐藏", () => {
	assert.equal(derive({ view: null, pendingCreation: { sourceTurnId: "turn-1" } }).kind, "needsLocation");
	assert.equal(derive({ view: null }).kind, "hidden");
	assert.equal(derive({ view: null, pendingCreation: { sourceTurnId: "turn-1" }, phase: "creating" }).kind, "needsLocation");
});

test("进行中与检查中的阶段各自成态，且只在允许时才显示取消", () => {
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "dispatching", authorizationState: "pending" } }) }).kind, "dispatching");
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "running", authorizationState: "confirmed" } }) }).kind, "running");
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "inspecting", authorizationState: "confirmed" } }) }).kind, "inspecting");
	for (const phase of ["dispatching", "running", "inspecting"]) {
		const card = derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase, authorizationState: "pending" } }) });
		assert.equal(card.canCancel, true, phase);
		assert.equal(card.canRevise, false, "进行中不允许再发起改稿");
	}
});

test("归档、失败、未知与中断分别是不同状态，不合并成「完成」", () => {
	assert.equal(derive({ view: view(), change: { workId: "dw_1", changeKind: "archived", revision: 4 } }).kind, "archived");
	assert.equal(derive({ view: view(), change: { workId: "dw_1", changeKind: "failed", revision: 4 } }).kind, "failed");
	assert.equal(derive({ view: view(), change: { workId: "dw_1", changeKind: "unknown", revision: 4 } }).kind, "unknown");
	assert.equal(derive({ view: view(), change: { workId: "dw_1", changeKind: "cancelled", revision: 4 } }).kind, "interrupted");
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "failed", authorizationState: "confirmed" } }) }).kind, "failed");
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "unknown", authorizationState: "confirmed" } }) }).kind, "unknown");
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "create_document", phase: "interrupted", authorizationState: "confirmed" } }) }).kind, "interrupted");
	assert.equal(derive({ view: view(), failure: { code: "DISPATCH_UNKNOWN" } }).kind, "unknown");
});

test("只有「有通过检查的版本且没有在途操作」时才允许普通聊天继续改稿", () => {
	assert.equal(derive({ view: view() }).canRevise, true);
	assert.equal(derive({ view: view({ versions: [{ versionId: "v_1", ordinal: 1, title: "报告", fileName: "out.md", inspection: "failed", userAcceptance: "not_collected", manualModification: false, createdAt: 1 }] }) }).canRevise, false);
	assert.equal(derive({ view: view({ versions: [] }) }).canRevise, false);
	assert.equal(derive({ view: view({ active: { attemptId: "at_1", kind: "revise_document", phase: "running", authorizationState: "confirmed" } }) }).canRevise, false);
});

test("版本列表只在有成果或该状态需要用户看时展示", () => {
	assert.equal(derive({ view: view() }).showVersions, true);
	assert.equal(derive({ view: view({ versions: [] }) }).showVersions, false);
	assert.equal(derive({ view: view({ versions: [] }), change: { workId: "dw_1", changeKind: "archived", revision: 4 } }).showVersions, true);
});

test("版本标签固定四位，便于与目录名对应", () => {
	assert.equal(presentation.formatVersionLabel(1), "v0001");
	assert.equal(presentation.formatVersionLabel(12), "v0012");
});
