/**
 * 文稿共享契约：有界解析、预算、编码器对称性，以及扩展镜像与主进程解析的一致性。
 *
 * 不测实现细节：只从公开解析入口断言「哪些输入被接受、哪些必须被拒绝」。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const shared = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);
const records = loadTsCommonJs(`${ROOT}/src/shared/documentWorkRecords.ts`);

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
/** 被加载模块在 vm 里有独立原型链：结构比较前先 JSON 归一，否则 deepStrictEqual 会因原型不同而红。 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const eq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

function binding(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: "dw_abc",
		attemptId: "at_abc",
		preparationId: "pr_abc",
		digest: digest("p"),
		sessionId: "session-a",
		kind: "create_document",
		workDirectory: "C:\\out\\dw_abc",
		stagingDirectory: "C:\\out\\dw_abc\\staging\\at_abc",
		materialCacheDirectory: "C:\\userData\\document-work\\materials\\cache",
		materials: [{ materialId: "m1", label: "材料.docx", path: "C:\\in\\材料.docx", digest: digest("m") }],
		scope: { summary: "改写第二章", sections: ["第二章"], preserve: ["保留结论"] },
		requirements: { summary: "输出一份报告" },
		...overrides,
	};
}

test("绑定载荷编解码对称，并拒绝超预算与损坏输入", () => {
	const payload = binding();
	const encoded = shared.encodeBindingPayload(payload);
	assert.equal(typeof encoded, "string");
	eq(shared.decodeBindingPayload(encoded), payload);

	assert.equal(shared.decodeBindingPayload("!!!!"), undefined, "非 base64url 字符集必须拒绝");
	assert.equal(shared.decodeBindingPayload(""), undefined, "空载荷必须拒绝");
	const oversized = shared.encodeBindingPayload({ blob: "x".repeat(70 * 1024) });
	assert.equal(oversized, undefined, "超过 64 KiB 的载荷不能编码");
});

test("base64url 编解码往返覆盖多字节与任意字节边界", () => {
	for (const value of ["", "a", "ab", "abc", "abcd", "中文材料", "🙂 emoji", "line\nbreak"]) {
		const encoded = shared.encodeBase64Url(value);
		assert.equal(shared.decodeBase64Url(encoded), value, value);
	}
	// 非法 UTF-8 序列必须拒绝，而不是解出替换字符。
	assert.equal(shared.decodeBase64Url("_w"), undefined);
});

test("扩展状态解析要求身份四元组齐全并拒绝越界候选", () => {
	const state = {
		schemaVersion: 1,
		workId: "dw_abc",
		attemptId: "at_abc",
		preparationId: "pr_abc",
		digest: digest("p"),
		sessionId: "session-a",
		phase: "reported",
		materials: [{ materialId: "m1", status: "converted", digest: digest("m"), converterVersion: "anydoc-argv-1" }],
		report: { reportId: "rp_1", artifacts: [{ relativePath: "out.docx", role: "primary" }], summary: "完成", risks: [] },
	};
	eq(shared.parseDocumentWorkExtensionState(state), state);

	assert.equal(shared.parseDocumentWorkExtensionState({ ...state, schemaVersion: 2 }), undefined, "未来协议版本必须拒绝");
	assert.equal(shared.parseDocumentWorkExtensionState({ ...state, digest: "short" }), undefined, "指纹形态必须校验");
	assert.equal(shared.parseDocumentWorkExtensionState({ ...state, report: { reportId: "rp", artifacts: [{ relativePath: "../escape.docx", role: "primary" }], summary: "", risks: [] } }), undefined, "相对路径不得逃出版本目录");
	assert.equal(shared.parseDocumentWorkExtensionState({ ...state, report: { reportId: "rp", artifacts: [{ relativePath: "/abs.docx", role: "primary" }], summary: "", risks: [] } }), undefined, "绝对路径必须拒绝");
	const tooMany = Array.from({ length: 33 }, (_, index) => ({ relativePath: `f${index}.docx`, role: "primary" }));
	assert.equal(shared.parseDocumentWorkExtensionState({ ...state, report: { reportId: "rp", artifacts: tooMany, summary: "", risks: [] } }), undefined, "候选文件数超过 32 必须拒绝");
	assert.equal(shared.extensionStateMatchesBinding(state, { ...state, attemptId: "at_other" }), false, "迟到候选不能绑定到新尝试");
	assert.equal(shared.extensionStateMatchesBinding(state, state), true);
});

test("授权引用不接受布尔值或未知类型，且指纹必须是 sha256", () => {
	eq(shared.parseAuthorizationReference({ kind: "alignment_confirmation", briefId: "b1", revision: 3 }), { kind: "alignment_confirmation", briefId: "b1", revision: 3 });
	eq(shared.parseAuthorizationReference({ kind: "revision_instruction", sourceTurnId: "turn-1", sourceTurnHash: digest("x") }), { kind: "revision_instruction", sourceTurnId: "turn-1", sourceTurnHash: digest("x") });
	assert.equal(shared.parseAuthorizationReference({ approved: true }), undefined, "布尔字段不能授权");
	assert.equal(shared.parseAuthorizationReference({ kind: "alignment_confirmation", briefId: "b1", revision: -1 }), undefined);
	assert.equal(shared.parseAuthorizationReference({ kind: "revision_instruction", sourceTurnId: "t", sourceTurnHash: "nope" }), undefined);
	assert.equal(shared.parseRequirementsReference({ kind: "user_instruction", sourceTurnId: "t" }), undefined, "缺正文指纹的指令引用必须拒绝");
});

test("检查状态聚合与基稿可用性：failed 优先，unverified 不作合格基稿", () => {
	assert.equal(shared.deriveInspectionStatus([{ id: "a", status: "passed" }]), "passed");
	assert.equal(shared.deriveInspectionStatus([{ id: "a", status: "unverified" }]), "unverified");
	assert.equal(
		shared.deriveInspectionStatus([
			{ id: "a", status: "unverified" },
			{ id: "b", status: "failed" },
		]),
		"failed",
	);
	assert.equal(shared.isUsableAsBase({ status: "passed" }), true);
	assert.equal(shared.isUsableAsBase({ status: "failed" }), false);
	assert.equal(shared.isUsableAsBase({ status: "unverified" }), false);
	assert.equal(shared.isUsableAsBase(undefined), false);
});

test("稳定序列化与工作目录名不依赖字段顺序或危险字符", () => {
	assert.equal(shared.stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), shared.stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
	assert.equal(shared.stableStringify({ a: undefined, b: 1 }), '{"b":1}', "undefined 字段不参与摘要");
	assert.equal(shared.buildWorkFolder("dw_abc", "季度:报告/草稿?"), "dw_abc-季度报告草稿");
	assert.equal(shared.buildWorkFolder("dw_abc", "   "), "dw_abc");
	assert.equal(shared.formatVersionDirectory(7), "v0007");
	assert.equal(shared.isSafeRelativePath("sub/out.docx"), true);
	assert.equal(shared.isSafeRelativePath("sub\\out.docx"), true, "Windows 反斜杠写法归一后仍是安全相对路径");
	assert.equal(shared.isSafeRelativePath("..\\out.docx"), false);
	assert.equal(shared.isSafeRelativePath("C:/tmp/out.docx"), false);
});

test("章节引用匹配会剥离序号前缀，避免把「第二章」误判成范围冲突", () => {
	assert.equal(shared.sectionReferenceMatches("第二章 市场分析", ["市场分析"]), true);
	assert.equal(shared.sectionReferenceMatches("市场分析", ["第二章 市场分析"]), true);
	assert.equal(shared.sectionReferenceMatches("2.1 竞争格局", ["竞争格局"]), true);
	assert.equal(shared.sectionReferenceMatches("财务预测", ["市场分析", "风险提示"]), false);
});

test("磁盘记录解析：状态自洽性、版本目录形态与越界字段一律拒绝", () => {
	const inspection = {
		schemaVersion: 1,
		inspectionId: "ins_1",
		versionId: "v_1",
		status: "passed",
		items: [{ id: "package_readable", status: "passed" }],
		coverage: { format: "docx", bytesRead: 10, bytesTotal: 10, textDigest: digest("t"), formatDigest: digest("f"), truncated: false },
		byteBudget: 1024,
		durationMs: 3,
		inspectorVersion: "docx-1",
		createdAt: 1,
	};
	eq(records.parseDocumentInspection(inspection)?.status, "passed");
	assert.equal(records.parseDocumentInspection({ ...inspection, status: "failed" }), undefined, "记录写 passed 而检查项没有 failed 时不得自洽");

	const version = {
		schemaVersion: 1,
		versionId: "v_1",
		ordinal: 1,
		workId: "dw_abc",
		kind: "create_document",
		title: "报告",
		directory: "v0001",
		artifacts: [{ relativePath: "out.docx", role: "primary", digest: digest("a"), bytes: 12 }],
		snapshotDirectory: "C:\\userData\\snapshots\\dw_abc\\v_1",
		modelRisks: [],
		userAcceptance: "not_collected",
		createdAt: 1,
	};
	assert.equal(records.parseArtifactVersion(version, "dw_abc")?.ordinal, 1);
	assert.equal(records.parseArtifactVersion({ ...version, directory: "1" }, "dw_abc"), undefined, "版本目录必须是 vNNNN");
	assert.equal(records.parseArtifactVersion({ ...version, workId: "dw_other" }, "dw_abc"), undefined, "跨工作记录不得被接受");
	assert.equal(records.parseArtifactVersion({ ...version, artifacts: [] }, "dw_abc"), undefined, "空成果版本必须拒绝");

	const operation = {
		schemaVersion: 1,
		requestId: "req-1",
		workId: "dw_abc",
		attemptId: "at_1",
		kind: "create_document",
		phase: "running",
		preparation: { preparationId: "pr_1", digest: digest("p") },
		preparedWorkRevision: 2,
		runtime: { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 4 },
		authorization: { kind: "alignment_confirmation", briefId: "b1", revision: 2 },
		authorizationState: "pending",
		extensionBound: true,
		dispatchAccepted: true,
		dispatchUnknown: false,
		createdAt: 1,
		updatedAt: 2,
	};
	assert.equal(records.parseDocumentWorkOperation(operation, "dw_abc")?.phase, "running");
	assert.equal(records.parseDocumentWorkOperation({ ...operation, phase: "replaying" }, "dw_abc"), undefined, "未知状态必须拒绝");
	assert.equal(records.parseDocumentWorkOperation({ ...operation, runtime: { sessionId: "session-a" } }, "dw_abc"), undefined, "运行时三元组必须完整");
});

test("渲染快照解析拒绝越界形状，不把检查结论伪装成整体状态", () => {
	const view = {
		workId: "dw_abc",
		sessionId: "session-a",
		revision: 3,
		title: "报告",
		outputRootLabel: "文稿",
		requirementsSummary: "",
		active: { attemptId: "at_1", kind: "create_document", phase: "running", authorizationState: "pending" },
		versions: [{ versionId: "v_1", ordinal: 1, title: "报告", fileName: "out.docx", inspection: "passed", userAcceptance: "not_collected", manualModification: false, createdAt: 1 }],
		revisionReady: true,
	};
	assert.equal(records.parseDocumentWorkView(view)?.versions.length, 1);
	assert.equal(records.parseDocumentWorkView({ ...view, versions: [{ ...view.versions[0], inspection: "unknown" }] }), undefined);
	assert.equal(records.parseDocumentWorkView({ ...view, active: { attemptId: "at_1", kind: "create_document", phase: "running", authorizationState: "approved" } }), undefined, "未知授权态必须拒绝");
});

test("扩展镜像与主进程对同一组样例给出一致结论", () => {
	const mirror = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-work-types.ts`);
	const payload = binding();
	const encoded = shared.encodeBindingPayload(payload);
	// 沙箱内构造的对象原型不同，跨 realm 用 JSON 归一后比较结构。
	eq(plain(mirror.decodeBinding(JSON.parse(shared.decodeBase64Url(encoded)))), payload, "镜像必须接受主进程构造的载荷");
	eq(plain(mirror.decodeBindingCommandArgument(encoded)), payload, "镜像必须能直接解出命令参数");

	for (const broken of [
		{ ...payload, workId: "bad id" },
		{ ...payload, stagingDirectory: "relative/path" },
		{ ...payload, materials: [{ materialId: "m1", label: "x", path: "C:\\in", digest: "short" }] },
		{ ...payload, scope: { summary: "s", sections: "nope", preserve: [] } },
	]) {
		assert.equal(mirror.decodeBinding(broken), undefined, JSON.stringify(broken).slice(0, 60));
	}
	// 两侧对同一份扩展状态快照的接受/拒绝必须完全一致。
	const state = { schemaVersion: 1, workId: "dw_abc", attemptId: "at_abc", preparationId: "pr_abc", digest: digest("p"), sessionId: "session-a", phase: "bound", materials: [] };
	eq(plain(mirror.decodeExtensionState(state)), plain(shared.parseDocumentWorkExtensionState(state)));
	assert.equal(mirror.decodeExtensionState({ ...state, workId: "bad id" }), plain(shared.parseDocumentWorkExtensionState({ ...state, workId: "bad id" })));
});
