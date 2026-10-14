// auth↔config 绑定与运行时 profile 加载（pi-deck-cloud-memory-runtime-config.ts）的针对性测试。
// 用假 readText：不碰真实文件系统与网络。C 的 auth.json 现在带 account/cloudInstanceId，
// 这里验证「旧只读 token-only 兼容、声明 owner 后必须绑定同一账号/实例」。
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const runtimeConfig = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-runtime-config.ts");

/** vm 沙箱对象原型与测试 realm 不同：比较前转成纯 JSON。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function assertPlain(actual, expected, message) {
	assert.deepEqual(plain(actual), expected, message);
}

const HOME = join("C:", "fake-home");
const AGENT = join(HOME, ".pi", "agent");
const CONFIG_FILE = join(AGENT, "pi-deck-cloud-memory.json");
const AUTH_FILE = join(AGENT, "auth.json");
const LOG_FILE = join(AGENT, "log.jsonl");

const LEGACY_CONFIG = { enabled: true, mode: "personal", baseUrl: "https://memory.example", authFile: AUTH_FILE, logFile: LOG_FILE };

function loader(files, env = {}) {
	const map = new Map(Object.entries(files).map(([key, value]) => [join(key), value]));
	return runtimeConfig.createRuntimeProfileLoader({
		input: { homedir: HOME, env },
		readText: async (path) => (map.has(join(path)) ? { kind: "ok", text: map.get(join(path)) } : { kind: "missing" }),
	});
}

function json(value) {
	return JSON.stringify(value);
}

test("auth 解析：token 必填；account/cloudInstanceId 要么都缺（token-only）要么都合法（绑定）", () => {
	const tokenOnly = runtimeConfig.parseAuthFile({ token: "t" });
	assert.equal(tokenOnly.kind, "ok");
	assert.equal(tokenOnly.binding.kind, "token_only");

	const bound = runtimeConfig.parseAuthFile({ token: "t", account: "acct_1", cloudInstanceId: "inst_1" });
	assert.equal(bound.kind, "ok");
	assert.equal(bound.binding.kind, "bound");
	assert.equal(bound.binding.accountId, "acct_1");

	for (const [raw, reason] of [
		[{}, "auth_token_missing"],
		[{ token: "" }, "auth_token_missing"],
		[{ token: "t", account: "acct_1" }, "auth_binding_incomplete"],
		[{ token: "t", cloudInstanceId: "inst_1" }, "auth_binding_incomplete"],
		[{ token: "t", account: "bad account", cloudInstanceId: "inst_1" }, "auth_account_invalid"],
		[{ token: "t", account: "acct_1", cloudInstanceId: "bad/instance" }, "auth_instance_invalid"],
		["not-an-object", "auth_not_object"],
		[null, "auth_not_object"],
	]) {
		const result = runtimeConfig.parseAuthFile(raw);
		assert.equal(result.kind, "invalid", JSON.stringify(raw));
		assert.equal(result.reason, reason);
	}
});

test("旧配置兼容：无 owner 且 sync 关闭时 token-only 可用；带绑定也接受", async () => {
	const tokenOnly = await loader({ [CONFIG_FILE]: json({ ...LEGACY_CONFIG }), [AUTH_FILE]: json({ token: "t" }) }).load();
	assert.equal(tokenOnly.kind, "ok");
	assert.equal(tokenOnly.profile.authBinding.kind, "token_only");
	assert.equal(tokenOnly.profile.config.account, null);

	const boundWithLegacy = await loader({ [CONFIG_FILE]: json({ ...LEGACY_CONFIG }), [AUTH_FILE]: json({ token: "t", account: "acct_1", cloudInstanceId: "inst_1" }) }).load();
	assert.equal(boundWithLegacy.kind, "ok", "旧配置可带绑定 auth，不影响只读工具");
	assert.equal(boundWithLegacy.profile.authBinding.kind, "bound");
});

test("声明 owner 后 auth 必须绑定同一账号/实例，不一致即拒绝（不只看 token 就放行）", async () => {
	const ownerConfig = { ...LEGACY_CONFIG, account: "acct_1", cloudInstanceId: "inst_1" };
	const matched = await loader({ [CONFIG_FILE]: json({ ...ownerConfig, syncEnabled: true }), [AUTH_FILE]: json({ token: "t", account: "acct_1", cloudInstanceId: "inst_1" }) }).load();
	assert.equal(matched.kind, "ok");

	const tokenOnly = await loader({ [CONFIG_FILE]: json(ownerConfig), [AUTH_FILE]: json({ token: "t" }) }).load();
	assert.equal(tokenOnly.kind, "invalid");
	assert.equal(tokenOnly.reason, "auth_binding_required");

	const otherAccount = await loader({ [CONFIG_FILE]: json(ownerConfig), [AUTH_FILE]: json({ token: "t", account: "acct_2", cloudInstanceId: "inst_1" }) }).load();
	assert.equal(otherAccount.kind, "invalid");
	assert.equal(otherAccount.reason, "auth_account_mismatch");

	const otherInstance = await loader({ [CONFIG_FILE]: json(ownerConfig), [AUTH_FILE]: json({ token: "t", account: "acct_1", cloudInstanceId: "inst_2" }) }).load();
	assert.equal(otherInstance.kind, "invalid");
	assert.equal(otherInstance.reason, "auth_instance_mismatch");

	// 只声明一个 owner 字段时，只核对已声明的那一侧（部分配置仍可用，但绝不换账号）。
	const partial = { ...LEGACY_CONFIG, account: "acct_1" };
	const partialMismatch = await loader({ [CONFIG_FILE]: json(partial), [AUTH_FILE]: json({ token: "t", account: "acct_2", cloudInstanceId: "inst_1" }) }).load();
	assert.equal(partialMismatch.kind, "invalid");
	assert.equal(partialMismatch.reason, "auth_account_mismatch");
	const partialMatch = await loader({ [CONFIG_FILE]: json(partial), [AUTH_FILE]: json({ token: "t", account: "acct_1", cloudInstanceId: "inst_9" }) }).load();
	assert.equal(partialMatch.kind, "ok", "未声明的实例侧不做核对");
});

test("同步门禁：syncEnabled 缺账号/实例仍是 invalid；stateDir 越界仍拒绝", async () => {
	const syncWithoutOwner = await loader({ [CONFIG_FILE]: json({ ...LEGACY_CONFIG, syncEnabled: true }), [AUTH_FILE]: json({ token: "t" }) }).load();
	assert.equal(syncWithoutOwner.kind, "invalid");
	assert.equal(syncWithoutOwner.reason, "config_sync_requires_account_instance");

	const outside = await loader({ [CONFIG_FILE]: json({ ...LEGACY_CONFIG, stateDir: join("D:", "outside", "state") }), [AUTH_FILE]: json({ token: "t" }) }).load();
	assert.equal(outside.kind, "invalid");
	assert.equal(outside.reason, "config_state_dir_outside_allowed_roots");
});

test("运行时 env：显式 PIDECK 配置与数据目录仍是允许根，越界回退默认位置", () => {
	const dataDir = join("D:", "pideck-data", "cloud-memory");
	const resolution = runtimeConfig.resolveRuntimeProfile({ homedir: HOME, env: { PIDECK_CLOUD_MEMORY_CONFIG: join(dataDir, "config.json"), PIDECK_CLOUD_MEMORY_DATA_DIR: dataDir } });
	assert.equal(resolution.source, "pideck-config");
	assert.equal(resolution.configFile, join(dataDir, "config.json"));
	assertPlain(resolution.problems, []);

	const escaped = runtimeConfig.resolveRuntimeProfile({ homedir: HOME, env: { PIDECK_CLOUD_MEMORY_CONFIG: join("D:", "outside", "config.json"), PIDECK_CLOUD_MEMORY_DATA_DIR: "relative" } });
	assert.equal(escaped.source, "agent-dir", "越界/相对 env 回退默认 agent 目录");
	assert.equal(escaped.configFile, join(AGENT, "pi-deck-cloud-memory.json"));
	assertPlain(escaped.problems, ["env_data_dir_relative", "env_config_file_outside_allowed_roots"]);
});
