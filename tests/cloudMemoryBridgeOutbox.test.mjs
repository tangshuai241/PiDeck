// 采集接线（pi-deck-cloud-memory-sync-bridge.ts）与 D 的真实 identity/outbox 生产模块的交叉集成测试。
// 不 stub 任何接口：真的用 createSyncRecord/advanceSyncRevision 生成记录、真的写 D 的持久队列（临时目录）。
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const bridgeModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-bridge.ts");

const SCOPE = { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_11111111-2222-3333-4444-555555555555", sessionId: "session-1" };
const ENTRY_ID = "entry-1";
const NOW = "2026-10-13T00:00:00.000Z";

function messageAction() {
	return {
		kind: "message",
		entryId: ENTRY_ID,
		revision: 1,
		role: "user",
		textBlocks: [{ type: "text", text: "用户原话\n第二行" }],
		visibleText: "用户原话\n第二行",
		occurredAt: NOW,
		completion: "completed",
		project: "TPA",
		branch: "leaf-1",
		parentEntryId: null,
		parentSourceId: null,
		targetSourceId: null,
		visibility: "visible",
		previousRecord: null,
	};
}

test("bridge → D 的真实 outbox：登记成功、同内容幂等、编辑生成新 revision 指向上一条", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pideck-bridge-"));
	try {
		const registrar = bridgeModule.createCaptureRegistrar();
		const first = await registrar.register({ ...SCOPE, stateDir }, messageAction());
		assert.equal(first.ok, true, first.ok ? "" : `register failed: ${first.reason}`);
		assert.match(first.sourceId, /^src_[0-9a-f]{64}$/, "sourceId 由 D 的 identity 派生");
		assert.equal(first.revision, 1);
		assert.equal(first.record.role, "user");
		assert.equal(first.record.project, "TPA");
		assert.equal(first.record.textBlocks[0].text, "用户原话\n第二行", "逐字保留");

		// 同身份同内容再次登记：D 的队列按 sourceId 判重，不生成第二条。
		const duplicate = await registrar.register({ ...SCOPE, stateDir }, messageAction());
		assert.equal(duplicate.ok, true);
		assert.equal(duplicate.sourceId, first.sourceId, "幂等：同内容不新建记录");

		// 编辑：advanceSyncRevision 生成 revision 2，并指向上一条 sourceId。
		const edited = await registrar.register({ ...SCOPE, stateDir }, { ...messageAction(), kind: "message", revision: 2, textBlocks: [{ type: "text", text: "编辑后的文本" }], visibleText: "编辑后的文本", targetSourceId: first.sourceId, previousRecord: first.record });
		assert.equal(edited.ok, true);
		assert.equal(edited.revision, 2);
		assert.notEqual(edited.sourceId, first.sourceId);
		assert.equal(edited.record.targetSourceId, first.sourceId, "编辑记录保留与原件的关系");
		assert.equal(edited.record.contentHash !== first.record.contentHash, true, "内容哈希随内容变化（D 的冻结字段表）");

		// 队列里确实有两条 pending（真实落盘），且 sender 与 register 共用同一实例。
		const queue = await registrar.queue({ ...SCOPE, stateDir });
		const pending = await queue.listPending();
		assert.equal(pending.entries.length, 2);
		const files = await readdir(join(stateDir, "acct_1", "inst_1", "pending"));
		assert.equal(files.length, 2, "队列文件真实落盘");
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("bridge：队列不可用时登记失败返回结构化原因，不抛异常（采集侧据此不推进游标）", async () => {
	const registrar = bridgeModule.createCaptureRegistrar();
	const result = await registrar.register({ ...SCOPE, stateDir: "relative/not-absolute" }, messageAction());
	assert.equal(result.ok, false);
	assert.equal(typeof result.reason, "string");
});
