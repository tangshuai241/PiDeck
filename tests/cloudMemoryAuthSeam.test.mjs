/**
 * 云端账号认证复用 seam 窄测（P02）：待办复用已连接账号与受保护凭据。
 *
 * 覆盖：身份快照与记忆总开关解耦、身份不符时不发网络请求、会话失效如实返回、
 * 凭据只在主进程内流转（返回值里只有令牌本体，且不由本测试用于任何持久化）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { CloudMemoryService } = loadTsCommonJs("src/main/cloudMemory/CloudMemoryService.ts");
const { createDefaultCloudMemorySettings } = loadTsCommonJs("src/main/cloudMemory/cloudMemoryStore.ts");

/** vm 沙箱里的对象原型与宿主不同；结构比较前先转成宿主普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function createHarness(t, settingsOverrides = {}, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-todo-auth-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const state = { whoamiCalls: 0, loginCalls: 0 };
	const settings = { ...createDefaultCloudMemorySettings(), ...settingsOverrides };
	const store = {
		read: async () => settings,
		write: async () => ({ ok: true }),
		isSecureStorageAvailable: () => true,
		protectSecret: (plain) => `protected:${plain}`,
		readSecret: (current, kind) => (options.secretKind === "none" ? null : kind === (options.secretKind ?? "token") ? (current.protectedToken ?? "tok_secret") : null),
	};
	const client = {
		whoami: async (_origin, token) => {
			state.whoamiCalls += 1;
			return { ok: true, payload: { kind: "user", username: "admin", scopes: ["memory"], token } };
		},
		login: async () => {
			state.loginCalls += 1;
			return { ok: false, error: { code: "unauthorized", message: "不重登" } };
		},
		persona: async () => ({ ok: true, payload: {} }),
		logout: async () => ({ ok: true }),
	};
	const service = new CloudMemoryService({
		paths: { dataDir: dir, configFile: join(dir, "config.json"), authFile: join(dir, "auth.json"), logFile: join(dir, "log"), personaCacheFile: join(dir, "persona.json") },
		store,
		client,
		isPiExtensionEnabled: () => false,
		setPiExtensionEnabled: async () => undefined,
		log: () => undefined,
	});
	return { service, state, dir };
}

test("记忆总开关关闭时身份快照仍可用（记忆与待办是两个开关）", async (t) => {
	const { service, state } = createHarness(t, { enabled: false, baseUrl: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 3, protectedToken: "stored" });
	await service.initialize();
	const snapshot = service.getAuthSnapshot();
	assert.deepEqual(plain(snapshot), { origin: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 3 });
	const lease = await service.acquireAuthLease(snapshot);
	assert.equal(lease.ok, true);
	assert.equal(lease.lease.token, "stored", "令牌由记忆服务在进程内提供，前端不接触");
	assert.equal(state.whoamiCalls, 1, "换令牌前先验一次 whoami");
	service.dispose();
});

test("身份不符直接判 stale，不发出任何网络请求", async (t) => {
	const { service, state } = createHarness(t, { enabled: false, baseUrl: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 3, protectedToken: "stored" });
	await service.initialize();
	const stale = await service.acquireAuthLease({ origin: "https://cloud.example", account: "other", cloudInstanceId: "inst1", configEpoch: 3 });
	assert.equal(stale.ok, false);
	assert.equal(stale.stale, true, "换账号后旧账号请求不得发到新账号");
	assert.equal(state.whoamiCalls, 0);
	assert.equal(state.loginCalls, 0);
	service.dispose();
});

test("未配置账号返回 null；令牌失效且未记住登录时如实报 unauthorized", async (t) => {
	const empty = createHarness(t);
	await empty.service.initialize();
	assert.equal(empty.service.getAuthSnapshot(), null);
	empty.service.dispose();
	const { service, state } = createHarness(t, { enabled: false, baseUrl: "https://cloud.example", account: "admin", cloudInstanceId: "inst1", configEpoch: 1 }, { secretKind: "none" });
	await service.initialize();
	const snapshot = service.getAuthSnapshot();
	assert.equal(snapshot.account, "admin", "登出后身份保留（便于提示重新连接）");
	const lease = await service.acquireAuthLease(snapshot);
	assert.equal(lease.ok, false);
	assert.equal(lease.stale, false, "认证失效不是「身份已切换」，界面应提示重连");
	assert.equal(lease.error.code, "unauthorized");
	assert.equal(state.loginCalls, 0, "没有记住登录时不重登");
	service.dispose();
});
