// sender 宿主（pi-deck-cloud-memory-sync-sender-host.ts）与 sync 状态 schema 的针对性测试。
// 假 sender 工厂 + 假 timer + 假连接读取：只验证 start/wake/stop/心跳配对、连接每 tick 现读与状态字段收窄。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const hostModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-sync-sender-host.ts");
const statusModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-status.ts");

const SCOPE = { accountId: "acct_1", cloudInstanceId: "inst_1", deviceId: "dev_1" };
const QUEUE_SCOPE = { ...SCOPE, stateDir: "D:/pideck-data/cloud-memory", sessionId: "session-1" };

function makeHost(options = {}) {
	let sender = null;
	const log = [];
	const statuses = [];
	const timers = [];
	let connectionReads = 0;
	let failNext = options.failNext === true;
	const senderFactory = (deps) => {
		if (failNext) {
			failNext = false;
			throw new Error("sender create failed");
		}
		log.push(`create:${deps.scope.accountId}`);
		const buildStatus = () => ({
			running: true,
			phase: "idle",
			accountId: deps.scope.accountId,
			cloudInstanceId: deps.scope.cloudInstanceId,
			deviceId: deps.scope.deviceId,
			pendingTotal: 3,
			pendingBytes: 120,
			conflictCount: 0,
			notStoredCount: 0,
			oversizedCount: 0,
			oversized: [],
			batchesSent: 0,
			confirmedCount: 0,
			lastReceiptAt: null,
			lastError: null,
			lastErrorAt: null,
			hasLease: false,
			updatedAt: "2026-10-13T00:00:00.000Z",
		});
		let lastConnection = null;
		return {
			async start() {
				log.push("start");
				deps.onStatus(buildStatus());
			},
			wake() {
				log.push("wake");
				deps.onStatus(buildStatus());
			},
			async stop() {
				log.push("stop");
			},
			getStatus() {
				return buildStatus();
			},
			// 测试用：暴露连接读取以断言「每 tick 现读」。
			readConnectionNow: async () => {
				lastConnection = await deps.getConnection();
				return lastConnection;
			},
			lastConnection: () => lastConnection,
		};
	};
	const capturingFactory = (deps) => {
		sender = senderFactory(deps);
		return sender;
	};
	const host = hostModule.createSenderHost({
		queueFor: async (scope) => ({ scope }),
		readConnection: () => {
			connectionReads += 1;
			if ("connection" in options) return options.connection;
			return { enabled: true, syncEnabled: true, baseUrl: "https://memory.example", token: `tok-${connectionReads}`, accountId: "acct_1", cloudInstanceId: "inst_1" };
		},
		onStatus: (status, meta) => statuses.push({ phase: status.phase, heartbeat: meta.heartbeat }),
		createSender: capturingFactory,
		heartbeatMs: 1000,
		timerPort: {
			every: (handler) => {
				timers.push(handler);
				const index = timers.length - 1;
				return {
					stop: () => {
						timers[index] = null;
					},
				};
			},
		},
	});
	return {
		host,
		log,
		statuses,
		senderRef: () => sender,
		readConnectionCount: () => connectionReads,
		fireHeartbeat: () => {
			for (const timer of timers) if (timer) timer();
		},
	};
}

test("sender 宿主：ensure 启动并唤醒、同 key 复用、换 key 先停旧的（start/stop 严格配对）", async () => {
	const { host, log, statuses } = makeHost();
	assert.equal(await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE }), "started");
	assert.deepEqual(log, ["create:acct_1", "start"]);
	assert.equal(host.status().pendingTotal, 3);
	assert.equal(host.heartbeatRunning(), true, "启动后心跳在跑");

	assert.equal(await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE }), "already_running");
	assert.deepEqual(log, ["create:acct_1", "start", "wake"], "同 scope 只唤醒不重建");

	assert.equal(await host.ensure({ key: "k2", scope: { ...SCOPE, accountId: "acct_2" }, queueScope: { ...QUEUE_SCOPE, accountId: "acct_2" } }), "started");
	assert.deepEqual(log, ["create:acct_1", "start", "wake", "stop", "create:acct_2", "start"], "换 scope 必须停旧 sender");
	assert.equal(host.currentScope().accountId, "acct_2");

	assert.equal(await host.stop("session_switch"), true);
	assert.equal(await host.stop("session_shutdown"), false, "重复 stop 幂等");
	assert.equal(host.status(), null);
	assert.equal(host.heartbeatRunning(), false, "stop 必须清心跳 timer");
	assert.equal(
		statuses.some((item) => item.heartbeat === false),
		true,
		"sender 自己的状态用 heartbeat=false",
	);
});

test("连接每 tick 现读：readConnection 支持 Promise，且每次调用都重新读（不是缓存的旧 token）", async () => {
	const { host, readConnectionCount, senderRef } = makeHost();
	assert.equal(await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE }), "started");
	const before = readConnectionCount();
	const first = await senderRef().readConnectionNow();
	const afterFirst = readConnectionCount();
	const second = await senderRef().readConnectionNow();
	assert.equal(afterFirst, before + 1, "每次 getConnection 都重新读 profile（不缓存 token）");
	assert.equal(readConnectionCount(), afterFirst + 1);
	assert.notEqual(first.token, second.token, "第二次读到的是新快照（token 刷新场景）");
	assert.equal(first.accountId, "acct_1");
});

test("心跳：低频上报 heartbeat=true 保持 freshness，stop 后不再上报", async () => {
	const { host, statuses, fireHeartbeat } = makeHost();
	await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE });
	statuses.length = 0;
	fireHeartbeat();
	assert.deepEqual(statuses, [{ phase: "idle", heartbeat: true }], "心跳消息必须带 heartbeat=true");
	await host.stop("session_shutdown");
	statuses.length = 0;
	fireHeartbeat();
	assert.deepEqual(statuses, [], "停止后旧 timer 不得再上报（stop 清 timer）");
});

test("sender 宿主：创建失败返回 failed 且不留下半个 sender", async () => {
	const { host, log, statuses } = makeHost({ failNext: true });
	assert.equal(await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE }), "failed");
	assert.equal(host.status(), null);
	assert.equal(host.heartbeatRunning(), false);
	assert.deepEqual(log, [], "失败不留 create/start 记录");
	assert.deepEqual(statuses, []);
});

test("sync 状态 schema：kind/state/pendingCount/lastReceiptAt 收窄，state 只接受固定枚举", () => {
	const built = statusModule.buildCloudMemoryStatus({
		kind: "sync",
		status: "sending",
		nowIso: "2026-10-13T00:00:00.000Z",
		state: "sending",
		deviceId: "dev_1",
		pendingCount: 3,
		lastReceiptAt: "2026-10-13T00:01:00.000Z",
		reason: null,
	});
	assert.equal(built.schema, "pi-deck-cloud-memory-status");
	assert.equal(built.version, 1, "版本保持 1（新增字段可空兼容）");
	assert.equal(built.kind, "sync");
	assert.equal(built.state, "sending");
	assert.equal(built.pendingCount, 3);
	assert.equal(built.lastReceiptAt, "2026-10-13T00:01:00.000Z");
	assert.equal(built.deviceId, "dev_1");
	assert.equal(statusModule.statusContent(built), "", "控制消息 content 为空（模型不可见、宿主读 details）");

	const bogus = statusModule.buildCloudMemoryStatus({ kind: "sync", status: "sending", nowIso: "t", state: "not_a_phase", pendingCount: -1, reason: "自由文本含空格" });
	assert.equal(bogus.state, null, "非固定枚举归 null");
	assert.equal(bogus.pendingCount, null);
	assert.equal(bogus.reason, null);
	assert.equal(statusModule.isStatusControlMessage({ role: "custom", customType: "pi-deck-cloud-memory-status" }), true);
	assert.equal(statusModule.isStatusControlMessage({ role: "custom", customType: "other" }), false);
	assert.equal(statusModule.isStatusControlMessage({ role: "toolResult", customType: "pi-deck-cloud-memory-status" }), false, "工具结果绝不被过滤");
});

test("连接为 null（配置/绑定不可用）：宿主给 disabled 快照让 sender 暂停，不是崩溃也不是继续发", async () => {
	const { host, senderRef } = makeHost({ connection: null });
	assert.equal(await host.ensure({ key: "k1", scope: SCOPE, queueScope: QUEUE_SCOPE }), "started");
	const snapshot = await senderRef().readConnectionNow();
	assert.equal(snapshot.enabled, false, "读不到有效 profile → disabled（sender 暂停）");
	assert.equal(snapshot.token, null);
	await host.stop("test_done");
});
