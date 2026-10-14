// pi-deck-cloud-memory-sync-identity 的针对性测试：来源身份、原文哈希、内容哈希、修订事件。
// 只加载生产 TS 纯函数；不碰文件系统/网络/pi 运行时。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const identity = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-identity.ts");

const baseIdentity = { accountId: "acct-1", cloudInstanceId: "cloud-1", deviceId: "dev-1", sessionId: "sess-1", entryId: "entry-1", revision: 1 };
const baseInput = { identity: baseIdentity, role: "user", content: "原话第一行\n原话第二行", occurredAt: "2026-10-13T12:00:00.000Z", project: "TPA" };

function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

test("source_id：按固定 JSON 数组字段顺序对身份取完整 SHA-256，src_ 前缀", () => {
	const sourceId = identity.buildSourceId(baseIdentity);
	assert.equal(sourceId, `src_${sha256(JSON.stringify(["acct-1", "cloud-1", "dev-1", "sess-1", "entry-1", 1]))}`);
	assert.match(sourceId, identity.SOURCE_ID_PATTERN);
	const record = identity.createSyncRecord(baseInput);
	assert.equal(record.sourceId, sourceId);
});

test("source_id：任一身份字段变化都产生新来源，entry/session 组合不可拆", () => {
	const fields = ["accountId", "cloudInstanceId", "deviceId", "sessionId", "entryId"];
	const original = identity.buildSourceId(baseIdentity);
	for (const field of fields) {
		const changed = identity.buildSourceId({ ...baseIdentity, [field]: `${baseIdentity[field]}-x` });
		assert.notEqual(changed, original, field);
	}
	assert.notEqual(identity.buildSourceId({ ...baseIdentity, revision: 2 }), original);
	assert.notEqual(identity.buildSourceId({ ...baseIdentity, entryId: "entry-1" }), identity.buildSourceId({ ...baseIdentity, sessionId: "sess-2" }));
});

test("text_sha256：对原始 UTF-8 逐字取哈希，不 trim、不折叠空白、不转换换行", () => {
	const record = identity.createSyncRecord({ ...baseInput, content: " a\r\nb  c " });
	assert.equal(record.textSha256, sha256(" a\r\nb  c "));
	assert.notEqual(record.textSha256, sha256("a\nb c"));
	assert.equal(record.visibleText, " a\r\nb  c ", "可见文本逐字保留");
});

test("可见文本块：多 text 块以 LF 连接、块内逐字保留、非 text 块不进原话", () => {
	const record = identity.createSyncRecord({
		...baseInput,
		content: [
			{ type: "text", text: "第一块\n保留" },
			{ type: "tool_use", name: "bash", input: {} },
			{ type: "thinking", thinking: "思考不进原话" },
			{ type: "text", text: "第二块" },
			{ type: "text", text: "" },
		],
	});
	assert.deepEqual(
		Array.from(record.textBlocks, (block) => block.text),
		["第一块\n保留", "第二块"],
	);
	assert.equal(record.visibleText, "第一块\n保留\n第二块");
	assert.equal(record.textSha256, sha256("第一块\n保留\n第二块"));
});

test("content_hash：只覆盖固定业务字段，revision 与队列元数据不参与", () => {
	const first = identity.createSyncRecord(baseInput);
	const revisionBumped = identity.createSyncRecord({ ...baseInput, identity: { ...baseIdentity, revision: 3 } });
	assert.equal(first.contentHash, revisionBumped.contentHash, "revision 不进 content_hash");
	assert.equal(first.contentHash, sha256(identity.canonicalJson({ branch: null, completion: "completed", kind: "message", occurred_at: baseInput.occurredAt, parent_source_id: null, project: "TPA", role: "user", target_source_id: null, text_blocks: [{ text: baseInput.content, type: "text" }], visibility: "visible" })));

	for (const change of [{ role: "assistant" }, { project: "其他" }, { parentSourceId: "src_" + "a".repeat(64) }, { branch: "feature" }, { completion: "incomplete" }, { visibility: "hidden" }, { occurredAt: "2026-10-13T12:00:01.000Z" }]) {
		const changed = identity.createSyncRecord({ ...baseInput, ...change });
		assert.notEqual(changed.contentHash, first.contentHash, JSON.stringify(change));
	}

	// 事件语义与指向必须进哈希：同 sourceId（同身份同 revision）下 kind/targetSourceId 不同不得当同内容。
	const targetSourceId = identity.buildSourceId(baseIdentity);
	const visibilityEvent = identity.createSyncRecord({ ...baseInput, kind: "visibility" });
	const retargeted = identity.createSyncRecord({ ...baseInput, targetSourceId });
	assert.notEqual(visibilityEvent.contentHash, first.contentHash, "kind 进 content_hash");
	assert.notEqual(retargeted.contentHash, first.contentHash, "targetSourceId 进 content_hash");
	assert.equal(visibilityEvent.sourceId, first.sourceId, "事件语义变化不改变身份");
});

test("canonicalJson：对象键排序、数组保序、非法值报错", () => {
	assert.equal(identity.canonicalJson({ b: 1, a: { d: null, c: [2, 1] } }), '{"a":{"c":[2,1],"d":null},"b":1}');
	assert.notEqual(identity.canonicalJson({ a: [1, 2] }), identity.canonicalJson({ a: [2, 1] }));
	assert.throws(() => identity.canonicalJson({ a: undefined }), TypeError);
	assert.throws(() => identity.canonicalJson(new Date(0)), TypeError);
});

test("身份校验：空字段、控制字符、非法 revision 被拒绝", () => {
	assert.throws(() => identity.createSyncRecord({ ...baseInput, identity: { ...baseIdentity, accountId: "" } }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, identity: { ...baseIdentity, sessionId: "bad\u0000id" } }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, identity: { ...baseIdentity, revision: 0 } }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, identity: { ...baseIdentity, revision: 1.5 } }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, role: "system" }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, completion: "maybe" }), TypeError);
	assert.throws(() => identity.createSyncRecord({ ...baseInput, project: "x".repeat(65) }), TypeError);
});

test("parseSyncRecord：round-trip 通过；派生字段对不上的文件判为损坏", () => {
	const record = identity.createSyncRecord({ ...baseInput, content: "原文" });
	const parsed = identity.parseSyncRecord(JSON.parse(JSON.stringify(record)));
	assert.deepEqual(parsed, record, "JSON round-trip 保持记录");

	const tamperedText = { ...record, textSha256: sha256("被篡改") };
	assert.equal(identity.parseSyncRecord(tamperedText), null, "text_sha256 与文本不符 → 损坏");
	const tamperedSource = { ...record, sourceId: identity.buildSourceId({ ...baseIdentity, revision: 9 }) };
	assert.equal(identity.parseSyncRecord(tamperedSource), null, "source_id 与身份不符 → 损坏");
	const missingField = { ...record };
	delete missingField.textBlocks;
	assert.equal(identity.parseSyncRecord(missingField), null);
	assert.equal(identity.parseSyncRecord({ schema: "other", version: 1 }), null);
});

test("advanceSyncRevision：原生 entry 不改写，编辑/隐藏以 revision+1 新事件表达", () => {
	const original = identity.createSyncRecord(baseInput);
	const edited = identity.advanceSyncRevision(original, { occurredAt: "2026-10-13T12:01:00.000Z", content: "修改后的原话" });
	assert.equal(edited.identity.revision, 2);
	assert.equal(edited.sourceId, identity.buildSourceId({ ...baseIdentity, revision: 2 }));
	assert.equal(edited.targetSourceId, original.sourceId);
	assert.equal(edited.kind, "message");
	assert.notEqual(edited.contentHash, original.contentHash);
	assert.equal(original.identity.revision, 1, "原记录保持不可变");
	assert.equal(original.visibleText, baseInput.content);

	const hidden = identity.advanceSyncRevision(original, { occurredAt: "2026-10-13T12:02:00.000Z", visibility: "hidden", kind: "visibility" });
	assert.equal(hidden.identity.revision, 2);
	assert.equal(hidden.visibility, "hidden");
	assert.equal(hidden.visibleText, original.visibleText, "隐藏事件仍携带原文，内容不改");
	assert.equal(hidden.kind, "visibility");
	assert.equal(hidden.targetSourceId, original.sourceId);
});

test("parseSyncRecord 兼容缺省可选字段的旧记录（project/parent/branch/visibility 缺省）", () => {
	const legacyRecord = identity.createSyncRecord({ identity: baseIdentity, role: "user", content: "旧原话", occurredAt: baseInput.occurredAt });
	const legacy = JSON.parse(JSON.stringify(legacyRecord));
	delete legacy.project;
	delete legacy.parentSourceId;
	delete legacy.targetSourceId;
	delete legacy.branch;
	delete legacy.visibility;
	delete legacy.kind;
	const parsed = identity.parseSyncRecord(legacy);
	assert.ok(parsed, "缺省字段按 null/visible/message 读取");
	assert.equal(parsed.project, null);
	assert.equal(parsed.visibility, "visible");
	assert.equal(parsed.kind, "message");
	assert.equal(parsed.sourceId, legacyRecord.sourceId);
	assert.equal(parsed.contentHash, legacyRecord.contentHash);
});
