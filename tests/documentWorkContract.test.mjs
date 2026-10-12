/**
 * 公共契约测试：主进程与 Pi 扩展两份协议必须逐字段一致，解析必须 fail-closed。
 *
 * 覆盖方案 §9 的 `documentWorkContract`：输入形态/长度/预算、损坏与未知协议版本、
 * 结构化错误、main 与扩展字段一致。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const shared = loadTsCommonJs("src/shared/documentWork.ts");
const types = loadTsCommonJs("src/shared/types/documentWork.ts");
const extensionProtocol = loadTsCommonJs("resources/extensions/pi-deck-document-work-protocol.ts");

test("main 与扩展的协议常量逐字段一致", () => {
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.schemaVersion, extensionProtocol.DOCUMENT_WORK_PROTOCOL.schemaVersion);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.stateType, extensionProtocol.DOCUMENT_WORK_PROTOCOL.stateType);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.snapshotType, extensionProtocol.DOCUMENT_WORK_PROTOCOL.snapshotType);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.command, extensionProtocol.DOCUMENT_WORK_PROTOCOL.command);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.materialTool, extensionProtocol.DOCUMENT_WORK_PROTOCOL.materialTool);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.reportTool, extensionProtocol.DOCUMENT_WORK_PROTOCOL.reportTool);
	assert.equal(shared.DOCUMENT_WORK_PROTOCOL.converterVersion, extensionProtocol.DOCUMENT_WORK_PROTOCOL.converterVersion);
	assert.deepEqual({ ...shared.DOCUMENT_WORK_PROTOCOL.budgets }, { ...extensionProtocol.DOCUMENT_WORK_PROTOCOL.budgets });
	// 常量本身也要和类型层的定义一致，避免"两处都对但第三处忘了改"。
	assert.equal(shared.DOCUMENT_WORK_SCHEMA_VERSION, types.DOCUMENT_WORK_SCHEMA_VERSION);
	assert.equal(shared.DOCUMENT_WORK_STATE_TYPE, types.DOCUMENT_WORK_STATE_TYPE);
	assert.equal(shared.DOCUMENT_WORK_COMMAND, types.DOCUMENT_WORK_COMMAND);
});

test("绑定载荷两侧编解码一致，且拒绝非规范编码", () => {
	const payload = { schemaVersion: 1, workId: "work_1", materials: [{ materialId: "mat_1", sha256: "a".repeat(64) }] };
	const encoded = shared.encodeWorkBinding(payload);
	const decodedByExtension = extensionProtocol.decodeBindingPayload(encoded);
	assert.deepEqual(decodedByExtension === undefined, true, "只在完整形态下解出对象");
	// 主进程解码同样只在规范形态下成功。
	assert.deepEqual(shared.decodeWorkBinding(encoded)?.workId, "work_1");
	// 非规范 JSON（带空格/换行）不得被接受：否则同一逻辑载荷会有多种字节形态。
	const raw = JSON.stringify(payload, null, 2);
	const loose = Buffer.from(raw, "utf8").toString("base64url");
	assert.equal(shared.decodeWorkBinding(loose), undefined);
	assert.equal(extensionProtocol.decodeBindingPayload(loose), undefined);
	assert.equal(shared.decodeWorkBinding("not base64!"), undefined);
	assert.equal(extensionProtocol.decodeBindingPayload(""), undefined);
});

test("绑定载荷超预算/未知协议版本一律拒绝", () => {
	const huge = { schemaVersion: 1, workId: "work_1", blob: "x".repeat(shared.DOCUMENT_WORK_BUDGETS.bindPayloadBytes + 10) };
	assert.equal(shared.decodeWorkBinding(shared.encodeWorkBinding(huge)), undefined);
	assert.equal(extensionProtocol.parseBindingPayload({ ...huge, schemaVersion: 2 }), undefined);
	assert.equal(
		extensionProtocol.parseBindingPayload({ schemaVersion: 2, sessionId: "s", workId: "w", attemptId: "a", preparationId: "p", digest: "d", kind: "create_document", stagingRelativeDir: "s/a", outputRelativeDir: "w", outputRootPath: "/tmp", materials: [], scope: { allow: [], preserve: [], wholeDocument: true } }),
		undefined,
	);
});

test("相对路径校验挡住绝对路径、上跳与反斜杠", () => {
	for (const value of ["/etc/passwd", "C:\\windows\\system32", "..\\escape", "work/../../etc", "a//b", "", "a\u0000b"]) {
		assert.equal(shared.isSafeRelativePath(value), false, value);
		assert.equal(extensionProtocol.isSafeRelativePath(value), false, value);
	}
	assert.equal(shared.isSafeRelativePath("work/staging/prep/deliverable.docx"), true);
	assert.equal(extensionProtocol.isSafeRelativePath("work/staging/prep/deliverable.docx"), true);
});

test("结构化错误只带代码与可判定字段", () => {
	const failure = shared.workFail("REVISION_CONFLICT", true, { currentRevision: 3, detail: "advanced" });
	assert.equal(failure.ok, false);
	assert.equal(failure.error.code, "REVISION_CONFLICT");
	assert.equal(failure.error.retryable, true);
	assert.equal(failure.error.currentRevision, 3);
	assert.equal(shared.parseWorkError({ code: "NOPE", retryable: false }), undefined);
	assert.deepEqual(shared.parseWorkError({ code: "IO_ERROR", retryable: true })?.code, "IO_ERROR");
});

test("准备记录不可变形态：改稿必须有基稿，范围与保留项不能自相矛盾", () => {
	const preparation = {
		schemaVersion: 1,
		preparationId: "prep_1",
		kind: "revise_document",
		workRevision: 1,
		requirementsRef: { kind: "alignment", briefId: "brief_1", revision: 2 },
		authorization: { kind: "revision_instruction", sourceTurnId: "turn_1" },
		materials: [],
		materialRoots: [{ rootId: "root_1", kind: "output_root", path: "C:/out", label: "out" }],
		base: { versionId: "v0001_a", artifactId: "v0001_a:work/staging/prep/a.docx", relativePath: "work/staging/prep/a.docx", sha256: "a".repeat(64), bytes: 10, explicit: false, handEdited: false },
		instruction: { sourceTurnId: "turn_1", text: "only section two", textDigest: "c".repeat(64) },
		scope: { allow: ["section one"], preserve: ["section two"], wholeDocument: false },
		stagingRelativeDir: "work/staging/prep_1",
		outputRelativeDir: "work",
		digest: "digest",
		createdAt: 1,
	};
	assert.ok(shared.parsePreparation(preparation));
	assert.equal(shared.parsePreparation({ ...preparation, base: undefined }), undefined, "改稿缺基稿必须拒绝");
	// 整篇授权与"必须逐字保留"是矛盾要求：要澄清，不能静默降级成"允许改"。
	assert.equal(shared.parsePreparation({ ...preparation, scope: { allow: ["a"], preserve: ["section two"], wholeDocument: true } }), undefined, "整篇授权与保留块互斥");
	assert.ok(shared.parsePreparation({ ...preparation, scope: { allow: [], preserve: [], wholeDocument: true } }), "明确的整篇授权（无保留块）是有效的");
	assert.equal(shared.normalizeChangeScope({ allow: [], preserve: [], wholeDocument: false }), undefined, "空范围不是有效范围");
});

test("绑定状态与候选汇报解析有界且字段一致", () => {
	const state = { schemaVersion: 1, sessionId: "session-1", nativeSessionId: "pi-native-1", workId: "work_1", attemptId: "attempt_1", preparationId: "prep_1", digest: "digest-1", phase: "reported", reportId: "report_1" };
	assert.deepEqual(shared.parseBindingState(state)?.phase, "reported");
	assert.equal(shared.parseBindingState({ ...state, phase: "approved" }), undefined);
	// 原生会话 id 是身份判据，缺失即拒绝。
	assert.equal(shared.parseBindingState({ ...state, nativeSessionId: undefined }), undefined);
	assert.equal(extensionProtocol.parseBindingState({ ...state, schemaVersion: 3 }), undefined);

	const report = {
		schemaVersion: 1,
		workId: "work_1",
		attemptId: "attempt_1",
		preparationId: "prep_1",
		digest: "digest-1",
		reportId: "report_1",
		artifacts: ["work_1/staging/prep_1/a.docx"],
		editableSources: [],
		summary: "done",
		risks: [],
	};
	assert.ok(shared.parseArtifactCandidateReport(report));
	assert.equal(shared.parseArtifactCandidateReport({ ...report, artifacts: ["../../escape.docx"] }), undefined);
	assert.equal(shared.parseArtifactCandidateReport({ ...report, artifacts: [] }), undefined);
	assert.equal(extensionProtocol.parseArtifactReport({ ...report, artifacts: new Array(shared.DOCUMENT_WORK_BUDGETS.reportFiles + 1).fill("work_1/staging/prep_1/a.docx") }), undefined);
});

test("汇报体积超预算（64KiB）时拒绝，不截断冒充完整汇报", () => {
	const big = {
		schemaVersion: 1,
		workId: "work_1",
		attemptId: "attempt_1",
		preparationId: "prep_1",
		digest: "digest-1",
		reportId: "report_1",
		artifacts: ["work_1/staging/prep_1/a.docx"],
		editableSources: [],
		summary: "x".repeat(5000),
		risks: new Array(20).fill("y".repeat(3000)),
	};
	assert.equal(shared.parseArtifactCandidateReport(big), undefined);
	assert.equal(extensionProtocol.parseArtifactReport(big), undefined);
});

test("汇报路径必须落在本轮 staging 内", () => {
	assert.equal(extensionProtocol.isInsideStaging("work_1/staging/prep_1", "work_1/staging/prep_1/a.docx"), true);
	assert.equal(extensionProtocol.isInsideStaging("work_1/staging/prep_1", "work_1/staging/prep_2/a.docx"), false);
	assert.equal(extensionProtocol.isInsideStaging("work_1/staging/prep_1", "work_1/versions/v0001/a.docx"), false);
	assert.equal(extensionProtocol.isInsideStaging("work_1/staging/prep_1", "work_1/staging/prep_1/_tpa/base/a.docx"), false);
});
