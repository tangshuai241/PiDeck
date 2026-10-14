/**
 * 云端记忆原生 RPC 状态投影（纯策略）单测。
 *
 * 覆盖：载荷收窄（未知字段/越界值）、运行时绑定（sessionId/agentId/runtimeGeneration）、
 * 账号与实例作用域、按设备去重聚合、新鲜度与生命周期（remove/clear）。
 * 不涉及 fs/网络/Electron，状态只来自原生消息。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const projectionModule = loadTsCommonJs("src/main/cloudMemory/cloudMemoryStatusProjection.ts");

const SCOPE = { account: "alice", cloudInstanceId: "inst-1" };
const BINDING = { agentId: "agent-1", sessionId: "pi-session-1", deckSessionId: "deck-1", runtimeGeneration: 3 };
const AT = "2026-10-13T08:00:00.000Z";

function payload(overrides = {}) {
	return {
		schema: "pi-deck-cloud-memory-status",
		version: 1,
		kind: "capture",
		status: "ok",
		at: AT,
		sessionId: "pi-session-1",
		account: "alice",
		cloudInstanceId: "inst-1",
		personaRevision: null,
		registered: 2,
		failed: 0,
		lineagePartial: false,
		needsNewSession: false,
		reason: null,
		...overrides,
	};
}

test("载荷收窄：schema/version/kind 不符即拒绝，越界字段落 null 不抛", () => {
	assert.ok(projectionModule.parseNativeStatus(payload()));
	assert.equal(projectionModule.parseNativeStatus(payload({ schema: "other" })), null);
	assert.equal(projectionModule.parseNativeStatus(payload({ version: 2 })), null);
	assert.equal(projectionModule.parseNativeStatus(payload({ kind: "unknown-kind" })), null);
	assert.equal(projectionModule.parseNativeStatus(null), null);
	assert.equal(projectionModule.parseNativeStatus([]), null);
	const loose = projectionModule.parseNativeStatus(payload({ registered: -1, failed: "3", at: "not-a-date", pendingCount: 1.5, deviceId: 42 }));
	assert.equal(loose.registered, null);
	assert.equal(loose.failed, null);
	assert.equal(loose.pendingCount, null);
	assert.equal(loose.deviceId, null);
	assert.equal(loose.at, new Date(0).toISOString(), "非法时间回 epoch，不编造时间");
});

test("运行时绑定：报 pi id 或 deck id 都接受，跨会话/旧 generation 一律拒绝", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	assert.equal(projection.accept(BINDING, payload(), SCOPE), true);
	assert.equal(projection.accept(BINDING, payload({ sessionId: "deck-1" }), SCOPE), true, "扩展报 deck id 属于同一 runtime");
	const fresh = new projectionModule.CloudMemoryStatusProjection();
	assert.equal(fresh.accept(BINDING, payload({ sessionId: "other-session" }), SCOPE), false, "跨会话状态不得采纳");
	// 先接一条合法状态，再拿旧 generation 试探
	assert.equal(fresh.accept(BINDING, payload(), SCOPE), true);
	assert.equal(fresh.accept({ ...BINDING, runtimeGeneration: 2 }, payload(), SCOPE), false, "同 agentId 的旧 generation 拒绝");
	assert.equal(fresh.accept({ ...BINDING, runtimeGeneration: 4 }, payload(), SCOPE), true, "新 generation 接替");
	// 同 generation 但换了会话 = 身份不一致（重启新旧进程混用同一 agentId）
	assert.equal(fresh.accept({ ...BINDING, runtimeGeneration: 4, sessionId: "pi-session-2", deckSessionId: "deck-2" }, payload({ sessionId: "pi-session-2" }), SCOPE), false);
});

test("作用域：只接受当前账号与云实例的状态", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	assert.equal(projection.accept(BINDING, payload({ account: "bob" }), SCOPE), false);
	assert.equal(projection.accept(BINDING, payload({ cloudInstanceId: "inst-2" }), SCOPE), false);
	assert.equal(projection.accept(BINDING, payload({ account: null, cloudInstanceId: null }), SCOPE), false);
	assert.equal(projection.snapshot(SCOPE, Date.now()), null);
});

test("聚合：同设备取最新快照、异设备相加、未知保持 null", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	const now = Date.now();
	projection.accept({ ...BINDING, agentId: "a1" }, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 3, lastReceiptAt: "2026-10-13T07:00:00.000Z" }), SCOPE);
	projection.accept({ ...BINDING, agentId: "a2" }, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 5, lastReceiptAt: "2026-10-13T07:30:00.000Z" }), SCOPE);
	projection.accept({ ...BINDING, agentId: "a3" }, payload({ kind: "sync", deviceId: "dev-2", pendingCount: 2 }), SCOPE);
	const summary = projection.snapshot(SCOPE, now);
	assert.equal(summary.pendingCount, 7, "同设备取最新（5，后到）+ 另一设备 2");
	assert.equal(summary.sessions, 3);
	assert.equal(summary.lastReceiptAt, "2026-10-13T07:30:00.000Z", "最晚回执取最大");
	const noReceipt = new projectionModule.CloudMemoryStatusProjection();
	noReceipt.accept(BINDING, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 1 }), SCOPE);
	assert.equal(noReceipt.snapshot(SCOPE, Date.now()).lastReceiptAt, null, "没报回执就是未知，不拿状态时间冒充");

	const noPending = new projectionModule.CloudMemoryStatusProjection();
	noPending.accept(BINDING, payload({ kind: "sync", deviceId: "dev-1" }), SCOPE);
	assert.equal(noPending.snapshot(SCOPE, Date.now()).pendingCount, null, "没报到计数就是未知，不是 0");

	const mixed = new projectionModule.CloudMemoryStatusProjection();
	mixed.accept({ ...BINDING, agentId: "a1" }, payload({ registered: 4, failed: 1 }), SCOPE);
	mixed.accept({ ...BINDING, agentId: "a2" }, payload({ registered: null, failed: null, needsNewSession: true, personaRevision: "rev-2" }), SCOPE);
	const mixedSummary = mixed.snapshot(SCOPE, Date.now());
	assert.equal(mixedSummary.registered, 4);
	assert.equal(mixedSummary.failed, 1);
	assert.equal(mixedSummary.needsNewSession, true);
	assert.equal(mixedSummary.personaRevision, "rev-2");
});

test("新鲜度与生命周期：过期/移除/清空后一律 null（未知不是 0）", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	projection.accept(BINDING, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 0 }), SCOPE);
	assert.equal(projection.snapshot(SCOPE, Date.now()).pendingCount, 0, "明确报到 0 才显示 0");
	projection.accept(BINDING, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 0 }), SCOPE);
	assert.equal(projection.snapshot(SCOPE, Date.now() + projectionModule.NATIVE_STATUS_FRESH_MS + 1), null, "超过新鲜窗口视为未知");
	projection.remove(BINDING.agentId);
	assert.equal(projection.snapshot(SCOPE, Date.now()), null);
	projection.accept(BINDING, payload(), SCOPE);
	projection.clear();
	assert.equal(projection.snapshot(SCOPE, Date.now()), null);
});

test("customType 常量与资源侧 pi-deck-cloud-memory-status.ts 保持一致", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync("resources/extensions/pi-deck-cloud-memory-status.ts", "utf8");
	const match = source.match(/STATUS_CUSTOM_TYPE\s*=\s*"([^"]+)"/);
	assert.ok(match, "资源侧必须定义 STATUS_CUSTOM_TYPE");
	assert.equal(projectionModule.NATIVE_STATUS_CUSTOM_TYPE, match[1]);
	assert.equal(projectionModule.NATIVE_STATUS_SCHEMA, match[1]);
});

test("同步相位：只采纳固定枚举，未知值落 null；多会话相位去重聚合", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	projection.accept(BINDING, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 1, state: "auth_blocked" }), SCOPE);
	projection.accept({ ...BINDING, agentId: "a2" }, payload({ kind: "sync", deviceId: "dev-2", pendingCount: 2, state: "idle" }), SCOPE);
	const summary = projection.snapshot(SCOPE, Date.now());
	assert.deepEqual([...summary.syncStates], ["auth_blocked", "idle"]);
	const unknown = projectionModule.parseNativeStatus(payload({ kind: "sync", state: "made_up_phase" }));
	assert.equal(unknown.state, null, "未知相位不得当已知状态展示");
	assert.equal(projectionModule.parseNativeStatus(payload({ kind: "capture" })).state, null, "非 sync 状态没有相位");
});

test("相位枚举与资源侧 pi-deck-cloud-memory-status.ts 的 SYNC_STATES 一致", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync("resources/extensions/pi-deck-cloud-memory-status.ts", "utf8");
	const match = source.match(/SYNC_STATES\s*=\s*\[([^\]]+)\]/);
	assert.ok(match, "资源侧必须定义 SYNC_STATES");
	const states = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
	assert.deepEqual([...projectionModule.NATIVE_SYNC_STATES], states);
});

test("窄用例：sync 5 → persona 状态 → 同设备另一会话 sync 归零，不得误报积压", () => {
	const projection = new projectionModule.CloudMemoryStatusProjection();
	const now = Date.now();
	// 会话 A：同设备报 5 条待传
	projection.accept({ ...BINDING, agentId: "a1" }, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 5, state: "sending" }), SCOPE);
	assert.equal(projection.snapshot(SCOPE, now).pendingCount, 5);
	// 同会话随后报人格状态：sync 槽必须保留（不是每 agent 只留一条）
	projection.accept({ ...BINDING, agentId: "a1" }, payload({ kind: "persona", status: "applied", personaRevision: "rev-1" }), SCOPE);
	const afterPersona = projection.snapshot(SCOPE, now);
	assert.equal(afterPersona.pendingCount, 5, "人格状态不得抹掉队列快照");
	assert.equal(afterPersona.personaRevision, "rev-1");
	// 同设备另一会话报归零（更新）：必须显示 0，而不是旧会话的 5
	projection.accept({ ...BINDING, agentId: "a2" }, payload({ kind: "sync", deviceId: "dev-1", pendingCount: 0, state: "idle" }), SCOPE);
	const drained = projection.snapshot(SCOPE, now);
	assert.equal(drained.pendingCount, 0, "队列归零必须如实显示 0");
	assert.equal(drained.personaRevision, "rev-1", "人格槽仍在");
	assert.deepEqual([...drained.syncStates], ["idle"], "只保留最新 sync 快照的相位");
});
