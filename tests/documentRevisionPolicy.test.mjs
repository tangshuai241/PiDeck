/**
 * 基稿选择与修改范围策略（纯函数）：默认基稿、显式历史稿、多对象歧义、
 * 手工修改接续与冲突、未授权段落变化、整篇授权的明确性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const policy = loadTsCommonJs("src/main/document-work/DocumentRevisionPolicy.ts");

const SHA = (char) => char.repeat(64);

function version(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: "work_1",
		versionId: "v0001_attempt_1",
		ordinal: 1,
		attemptId: "attempt_1",
		preparationId: "prep_1",
		kind: "create_document",
		relativeDir: "work_1/versions/v0001",
		artifacts: [{ relativePath: "work_1/versions/v0001/deliverable.docx", sha256: SHA("a"), bytes: 100 }],
		editableSources: [{ relativePath: "work_1/versions/v0001/source.md", sha256: SHA("b"), bytes: 50 }],
		snapshots: [],
		provenance: { kind: "created", method: "word_local_edit" },
		inspection: { schemaVersion: 1, status: "passed", channels: [], inspectorVersion: "doc-inspector-v1", bytes: 100, budgetBytes: 1024, elapsedMs: 5 },
		userAcceptance: "not_collected",
		archivedAt: 1,
		...overrides,
	};
}

/** 默认读法：磁盘上就是归档时记录的内容（没有手工修改）。 */
function unchanged(versions) {
	const byPath = new Map();
	for (const version of versions) for (const file of [...version.artifacts, ...version.editableSources]) byPath.set(file.relativePath, file.sha256);
	return (relativePath) => byPath.get(relativePath);
}

test("默认基稿取最近一版检查通过的，不取目录里最新但未验证的", () => {
	const versions = [version({ ordinal: 1, versionId: "v0001_a", archivedAt: 1 }), version({ ordinal: 2, versionId: "v0002_b", archivedAt: 2, inspection: { schemaVersion: 1, status: "unverified", channels: [], inspectorVersion: "doc-inspector-v1", bytes: 1, budgetBytes: 1, elapsedMs: 1 } })];
	const result = policy.selectBaseVersion({ versions, readCurrentDigest: unchanged(versions) });
	assert.equal(result.ok, true);
	assert.equal(result.value.base.versionId, "v0001_a");
	assert.equal(result.value.handEdited, false);
});

test("没有检查通过的版本时返回 BASE_AMBIGUOUS，不用最新文件顶上", () => {
	const versions = [version({ inspection: { schemaVersion: 1, status: "failed", channels: [], inspectorVersion: "doc-inspector-v1", bytes: 1, budgetBytes: 1, elapsedMs: 1 } })];
	const result = policy.selectBaseVersion({ versions, readCurrentDigest: unchanged(versions) });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_AMBIGUOUS");
});

test("用户显式指定的历史版本优先，即使它不是最新的一版", () => {
	const versions = [version({ ordinal: 1, versionId: "v0001_a" }), version({ ordinal: 2, versionId: "v0002_b", artifacts: [{ relativePath: "work_1/versions/v0002/deliverable.docx", sha256: SHA("c"), bytes: 100 }] })];
	const result = policy.selectBaseVersion({ versions, explicitVersionId: "v0001_a", readCurrentDigest: unchanged(versions) });
	assert.equal(result.ok, true);
	assert.equal(result.value.base.versionId, "v0001_a");
	assert.equal(result.value.base.explicit, true);
});

test("指定的版本不属于本件工作时返回歧义，不猜最接近的一版", () => {
	const result = policy.selectBaseVersion({ versions: [version()], explicitVersionId: "v9999_other", readCurrentDigest: () => SHA("a") });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_AMBIGUOUS");
});

test("归档后正文被手工改过：归属唯一时自动接续并标注 handEdited", () => {
	const versions = [version()];
	const result = policy.selectBaseVersion({ versions, readCurrentDigest: (path) => (path.endsWith("deliverable.docx") ? SHA("d") : SHA("b")) });
	assert.equal(result.ok, true);
	assert.equal(result.value.handEdited, true);
	assert.equal(result.value.base.sha256, SHA("d"));
	assert.match(result.value.note ?? "", /edited outside TPA/);
});

test("多个文件同时变化时返回歧义，交给用户澄清", () => {
	const versions = [
		version({
			artifacts: [
				{ relativePath: "work_1/versions/v0001/a.docx", sha256: SHA("a"), bytes: 1 },
				{ relativePath: "work_1/versions/v0001/b.docx", sha256: SHA("c"), bytes: 1 },
			],
		}),
	];
	const result = policy.selectBaseVersion({ versions, readCurrentDigest: () => SHA("d") });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_AMBIGUOUS");
});

test("只有可编辑源稿被改、正文没变：返回歧义，不拿过期源稿覆盖手改内容", () => {
	const versions = [version()];
	const result = policy.selectBaseVersion({ versions, readCurrentDigest: (path) => (path.endsWith("source.md") ? SHA("e") : SHA("a")) });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_AMBIGUOUS");
});
