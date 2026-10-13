/**
 * 基稿选择与范围校验纯策略：没有可用基稿、多个主文件、手工改动归属不清时一律返回歧义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const policy = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentRevisionPolicy.ts`);

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const DIGEST = "a".repeat(64);

function version(overrides = {}) {
	return {
		schemaVersion: 1,
		versionId: "v_1",
		ordinal: 1,
		workId: "dw_test",
		kind: "create_document",
		title: "报告",
		directory: "v0001",
		artifacts: [{ relativePath: "out.docx", role: "primary", digest: DIGEST, bytes: 10 }],
		snapshotDirectory: "C:\\userData\\snapshots\\dw_test\\v_1",
		modelRisks: [],
		userAcceptance: "not_collected",
		createdAt: 1,
		inspection: {
			schemaVersion: 1,
			inspectionId: "ins_1",
			versionId: "v_1",
			status: "passed",
			items: [{ id: "package_readable", status: "passed" }],
			coverage: { format: "docx", bytesRead: 1, bytesTotal: 1, truncated: false },
			byteBudget: 1024,
			durationMs: 1,
			inspectorVersion: "docx-1",
			createdAt: 1,
		},
		...overrides,
	};
}

test("新建工作没有版本时返回 create，改稿没有版本时返回歧义", () => {
	assert.equal(policy.selectBaseVersion({ kind: "create_document", versions: [] }).kind, "create");
	const missing = policy.selectBaseVersion({ kind: "revise_document", versions: [] });
	assert.equal(missing.kind, "ambiguous");
	assert.equal(missing.reason, "no_usable_base");
});

test("只有检查通过的版本能自动成为基稿，取最新序号", () => {
	const failed = version({ versionId: "v_1", ordinal: 1, inspection: { ...version().inspection, status: "failed", items: [{ id: "content_non_empty", status: "failed" }] } });
	const unverified = version({ versionId: "v_2", ordinal: 2, inspection: { ...version().inspection, status: "unverified", items: [{ id: "format_supported", status: "unverified" }] } });
	const passed = version({ versionId: "v_3", ordinal: 3, directory: "v0003" });
	const selected = policy.selectBaseVersion({ kind: "revise_document", versions: [passed, unverified, failed], readableDigest: () => DIGEST });
	assert.equal(selected.kind, "selected");
	assert.equal(selected.version.versionId, "v_3");

	const nothingUsable = policy.selectBaseVersion({ kind: "revise_document", versions: [failed, unverified], readableDigest: () => DIGEST });
	assert.equal(nothingUsable.kind, "ambiguous");
	assert.equal(nothingUsable.reason, "no_usable_base");
});

test("用户显式指定的版本优先，即使它没有通过检查", () => {
	const unverified = version({ versionId: "v_9", ordinal: 9, inspection: { ...version().inspection, status: "unverified", items: [{ id: "format_supported", status: "unverified" }] } });
	// 显式指定仍需文件实际可读：不可读时不能凭指定就采用。
	const selected = policy.selectBaseVersion({ kind: "revise_document", versions: [unverified, version({ versionId: "v_8", ordinal: 8 })], explicitVersionId: "v_9", readableDigest: () => DIGEST });
	assert.equal(policy.selectBaseVersion({ kind: "revise_document", versions: [unverified], explicitVersionId: "v_9" }).reason, "unreadable_base");
	assert.equal(selected.kind, "selected");
	assert.equal(selected.version.versionId, "v_9");
	assert.equal(policy.selectBaseVersion({ kind: "revise_document", versions: [unverified], explicitVersionId: "v_missing" }).reason, "no_usable_base");
});

test("单个版本里主文件不唯一或文件读不到时返回歧义，不猜", () => {
	const twoPrimaries = version({
		artifacts: [
			{ relativePath: "a.docx", role: "primary", digest: DIGEST, bytes: 1 },
			{ relativePath: "b.docx", role: "primary", digest: DIGEST, bytes: 1 },
		],
	});
	assert.equal(policy.selectBaseVersion({ kind: "revise_document", versions: [twoPrimaries] }).reason, "multiple_primary");
	const unreadable = policy.selectBaseVersion({ kind: "revise_document", versions: [version()], readableDigest: () => undefined });
	assert.equal(unreadable.reason, "unreadable_base");
	// 可编辑源稿不算主文件，不参与唯一性判定。
	const withSource = version({
		artifacts: [
			{ relativePath: "out.docx", role: "primary", digest: DIGEST, bytes: 1 },
			{ relativePath: "src.md", role: "editable_source", digest: DIGEST, bytes: 1 },
		],
	});
	assert.equal(policy.selectBaseVersion({ kind: "revise_document", versions: [withSource], readableDigest: () => DIGEST }).kind, "selected");
});

test("手工修改只有「最新版 + 恰好一个文件变化 + 可读」才自动接续", () => {
	const base = { version: version(), isLatestVersion: true, observedFileDigest: DIGEST, changedArtifactPaths: ["out.docx"], recordedDigest: DIGEST, adoptable: true };
	assert.equal(policy.reconcileObservedBase(base).kind, "unchanged", "指纹一致时按归档版处理");
	assert.equal(policy.reconcileObservedBase({ ...base, observedFileDigest: "b".repeat(64) }).kind, "adopted");
	assert.equal(policy.reconcileObservedBase({ ...base, observedFileDigest: "b".repeat(64), isLatestVersion: false }).reason, "ambiguous_manual");
	assert.equal(policy.reconcileObservedBase({ ...base, observedFileDigest: "b".repeat(64), changedArtifactPaths: ["out.docx", "src.md"] }).reason, "ambiguous_manual");
	assert.equal(policy.reconcileObservedBase({ ...base, observedFileDigest: "b".repeat(64), adoptable: false }).reason, "ambiguous_manual");
	assert.equal(policy.reconcileObservedBase({ ...base, observedFileDigest: undefined }).reason, "unreadable_base");
});

test("声明的章节必须在基稿大纲里存在，否则算范围冲突", () => {
	assert.equal(plain(policy.validateScopeAgainstHeadings({ summary: "", sections: ["第二章"], preserve: [] }, ["第二章 市场分析"])).ok, true);
	const conflict = policy.validateScopeAgainstHeadings({ summary: "", sections: ["财务预测"], preserve: [] }, ["市场分析"]);
	assert.equal(conflict.ok, false);
	assert.deepEqual(plain(conflict.missing), ["财务预测"]);
	assert.equal(policy.validateScopeAgainstHeadings({ summary: "", sections: [], preserve: [] }, []).ok, true, "未声明章节时不做冲突判定");
});

test("新建与改稿不能挂在互相矛盾的历史上", () => {
	assert.equal(policy.kindConflictsWithHistory("create_document", []), false);
	assert.equal(policy.kindConflictsWithHistory("create_document", [version()]), true);
	assert.equal(policy.kindConflictsWithHistory("revise_document", [version()]), false);
	assert.equal(policy.kindConflictsWithHistory("revise_document", []), true);
});
