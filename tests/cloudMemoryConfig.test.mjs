// pi-deck-cloud-memory 配置/auth/路径策略（pi-deck-cloud-memory-config.ts）的针对性测试。
// 用 loadTsCommonJs 加载生产 TS；不碰文件系统与网络。
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const config = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-config.ts");

const HOME = join("C:", "fake", "home");
const AGENT = join(HOME, ".pi", "agent");
const ENV = { homedir: HOME };
const BASE = {
	baseUrl: "https://memory.example",
	authFile: join(AGENT, "auth.json"),
	logFile: join(AGENT, "memory.log.jsonl"),
	mode: "personal",
	enabled: true,
};

test("resolveAgentDir：未设置 PI_CODING_AGENT_DIR 时 ~/.pi/agent，设置后优先", () => {
	assert.equal(config.resolveAgentDir({ homedir: HOME }), AGENT);
	assert.equal(config.resolveAgentDir({ homedir: HOME, piAgentDir: join("D:", "pi-profile", "agent") }), join("D:", "pi-profile", "agent"));
	assert.equal(config.resolveAgentDir({ homedir: HOME, piAgentDir: "~/custom-agent" }), join(HOME, "custom-agent"));
	assert.equal(config.resolveAgentDir({ homedir: HOME, piAgentDir: "  " }), AGENT);
});

test("配置：PI_CODING_AGENT_DIR 是独立允许根（默认配置/日志优先放这里）", () => {
	const profile = join("D:", "pi-profile", "agent");
	const env = { homedir: HOME, piAgentDir: profile };
	const ok = config.parseCloudMemoryConfig({ ...BASE, authFile: join(profile, "auth.json"), logFile: join(profile, "memory.log.jsonl") }, env);
	assert.equal(ok.kind, "ok");
	// profile 之外的 sibling 前缀仍拒绝
	const sibling = config.parseCloudMemoryConfig({ ...BASE, logFile: join("D:", "pi-profile", "agentX", "memory.log.jsonl") }, env);
	assert.equal(sibling.kind, "invalid");
	assert.equal(sibling.reason, "config_log_file_outside_allowed_roots");
	// 未设置时 ~/.pi/agent 仍是根
	const fallback = config.parseCloudMemoryConfig(BASE, { homedir: HOME });
	assert.equal(fallback.kind, "ok");
});

test("配置：日志与 auth 路径必须绝对且位于允许根内", () => {
	for (const [field, path, reason] of [
		["logFile", join(HOME, ".piX", "evil.jsonl"), "config_log_file_outside_allowed_roots"],
		["logFile", join("C:", "Windows", "Temp", "evil.jsonl"), "config_log_file_outside_allowed_roots"],
		["authFile", join("C:", "Windows", "Temp", "auth.json"), "config_auth_file_outside_allowed_roots"],
		["authFile", "relative/auth.json", "config_auth_file_relative"],
		["logFile", "relative/memory.log.jsonl", "config_log_file_relative"],
	]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, [field]: path }, ENV);
		assert.equal(result.kind, "invalid", `${field}=${path} 应拒绝`);
		assert.equal(result.reason, reason);
	}
});

test("配置：显式应用数据目录可作为附加允许根", () => {
	const dataDir = join("D:", "pideck-data");
	const allowed = config.parseCloudMemoryConfig({ ...BASE, logFile: join(dataDir, "memory.log.jsonl") }, { homedir: HOME, dataDir });
	assert.equal(allowed.kind, "ok");
	const outside = config.parseCloudMemoryConfig({ ...BASE, logFile: join("D:", "other", "memory.log.jsonl") }, { homedir: HOME, dataDir });
	assert.equal(outside.kind, "invalid");
	const relativeDataDir = config.parseCloudMemoryConfig({ ...BASE, logFile: join(dataDir, "memory.log.jsonl") }, { homedir: HOME, dataDir: "pideck-data" });
	assert.equal(relativeDataDir.kind, "invalid");
});

test("配置：baseUrl 只放行 https / 回环 http，禁止 query/hash/凭据", () => {
	for (const loopback of ["http://127.0.0.1:8080", "http://localhost:3000/", "http://[::1]:9000"]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, baseUrl: loopback }, ENV);
		assert.equal(result.kind, "ok", `${loopback} 应放行`);
	}
	for (const rejected of ["http://example.com", "http://192.168.1.5:8080", "ftp://memory.example", "not-a-url", ""]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, baseUrl: rejected }, ENV);
		assert.equal(result.kind, "invalid", `${rejected} 应拒绝`);
	}
	for (const [bad, reason] of [
		["https://memory.example/api?tenant=1", "config_base_url_query"],
		["https://memory.example/api#frag", "config_base_url_query"],
		["https://user:pass@memory.example", "config_base_url_credentials"],
	]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, baseUrl: bad }, ENV);
		assert.equal(result.kind, "invalid");
		assert.equal(result.reason, reason);
	}
});

test("配置：enabled:false 是 disabled，缺字段/非法 mode 是 invalid", () => {
	const disabled = config.parseCloudMemoryConfig({ ...BASE, enabled: false }, ENV);
	assert.equal(disabled.kind, "disabled");
	assert.equal(disabled.reason, "config_disabled");

	for (const [patch, reason] of [
		[{ enabled: undefined }, "config_enabled_required"],
		[{ mode: "auto" }, "config_mode_invalid"],
		[{ mode: undefined }, "config_mode_invalid"],
		[{ baseUrl: undefined }, "config_base_url_missing"],
		[{ authFile: undefined }, "config_auth_file_missing"],
		[{ logFile: undefined }, "config_log_file_missing"],
	]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, ...patch }, ENV);
		assert.equal(result.kind, "invalid", `${JSON.stringify(patch)} 应 invalid`);
		assert.equal(result.reason, reason);
	}
	assert.equal(config.parseCloudMemoryConfig(null, ENV).kind, "invalid");
	assert.equal(config.parseCloudMemoryConfig("x", ENV).kind, "invalid");
});

test("配置：同步可选字段兼容老配置；syncEnabled 缺账号/实例即拒绝", () => {
	// 老配置（只有 enabled/baseUrl/authFile/logFile/mode）仍然 ok：只读查记忆不依赖同步字段。
	const legacy = config.parseCloudMemoryConfig(BASE, ENV);
	assert.equal(legacy.kind, "ok");
	assert.equal(legacy.config.syncEnabled, false);
	assert.equal(legacy.config.account, null);
	assert.equal(legacy.config.stateDir, null);

	const stateDir = join(AGENT, "cloud-memory-state");
	const personaCacheFile = join(AGENT, "persona-cache.json");
	const full = config.parseCloudMemoryConfig({ ...BASE, account: "acct_1", cloudInstanceId: "inst.a-1", stateDir, personaCacheFile, syncEnabled: true }, ENV);
	assert.equal(full.kind, "ok");
	assert.equal(full.config.stateDir, stateDir);
	assert.equal(full.config.personaCacheFile, personaCacheFile);
	assert.equal(full.config.account, "acct_1");
	assert.equal(full.config.cloudInstanceId, "inst.a-1");
	assert.equal(full.config.syncEnabled, true);

	// 缺账号或实例一律不得开启同步：不是静默降级，而是明确 invalid（fail-closed）。
	for (const patch of [{ cloudInstanceId: "inst" }, { account: "acct" }]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, ...patch, syncEnabled: true }, ENV);
		assert.equal(result.kind, "invalid", JSON.stringify(patch));
		assert.equal(result.reason, "config_sync_requires_account_instance");
	}

	for (const [patch, reason] of [
		[{ account: "bad account" }, "config_account_invalid"],
		[{ cloudInstanceId: "" }, "config_cloud_instance_invalid"],
		[{ syncEnabled: "yes" }, "config_sync_enabled_invalid"],
		[{ stateDir: "relative/state" }, "config_state_dir_relative"],
		[{ stateDir: join("C:", "Windows", "Temp", "state") }, "config_state_dir_outside_allowed_roots"],
		[{ personaCacheFile: "relative/persona.json" }, "config_persona_cache_relative"],
		[{ personaCacheFile: join("C:", "Windows", "Temp", "persona.json") }, "config_persona_cache_outside_allowed_roots"],
	]) {
		const result = config.parseCloudMemoryConfig({ ...BASE, ...patch }, ENV);
		assert.equal(result.kind, "invalid", `${JSON.stringify(patch)} 应 invalid`);
		assert.equal(result.reason, reason);
	}

	const dataDir = join("D:", "pideck-data");
	assert.equal(config.parseCloudMemoryConfig({ ...BASE, stateDir: join(dataDir, "state") }, { homedir: HOME, dataDir }).kind, "ok");
});

test("auth：token 形状校验，拒绝换行与超长", () => {
	const ok = config.parseAuthToken({ token: "  abc  " });
	assert.equal(ok.kind, "ok");
	assert.equal(ok.token, "abc");
	for (const [raw, reason] of [
		[{}, "auth_token_missing"],
		[{ token: "" }, "auth_token_missing"],
		[{ token: "a\r\nb" }, "auth_token_invalid"],
		[{ token: "x".repeat(config.MAX_AUTH_TOKEN_CHARS + 1) }, "auth_token_too_long"],
		[null, "auth_not_object"],
	]) {
		const result = config.parseAuthToken(raw);
		assert.equal(result.kind, "invalid");
		assert.equal(result.reason, reason);
	}
});
