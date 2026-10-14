/**
 * 云端记忆纯校验层（URL / 登录入参 / 服务端主体 / 人格哈希）单测。
 *
 * 覆盖 dispatch 要求的「URL/输入」与「人格 hash」两类判定；不碰网络与文件系统。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const validation = loadTsCommonJs("src/main/cloudMemory/cloudMemoryValidation.ts");

test("baseUrl：只允许 https 或回环 http，且不接受路径/查询/内嵌凭据", () => {
	const https = validation.normalizeCloudMemoryBaseUrl("https://workbench.example.com");
	assert.equal(https.ok, true);
	assert.equal(https.baseUrl, "https://workbench.example.com");
	// 尾斜杠规范化为 origin
	const trailing = validation.normalizeCloudMemoryBaseUrl("https://workbench.example.com/");
	assert.equal(trailing.ok, true);
	assert.equal(trailing.baseUrl, "https://workbench.example.com");
	assert.equal(validation.normalizeCloudMemoryBaseUrl("http://127.0.0.1:4790").ok, true);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("http://localhost:4790").ok, true);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("http://memory.example.com").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("ftp://memory.example.com").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("https://user:pass@memory.example.com").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("https://memory.example.com/api").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("https://memory.example.com/?a=1").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("https://memory.example.com/#x").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl("").ok, false);
	assert.equal(validation.normalizeCloudMemoryBaseUrl(123).ok, false);
});

test("connect 入参：缺字段/坏布尔/换行密码都被拒，正常输入归一化", () => {
	const base = { baseUrl: "https://memory.example.com", account: "alice", password: "p@ss", syncMode: "personal", rememberSignIn: true };
	const ok = validation.parseCloudMemoryConnectInput(base);
	assert.equal(ok.ok, true);
	assert.equal(ok.input.baseUrl, base.baseUrl);
	assert.equal(ok.input.account, base.account);
	assert.equal(ok.input.password, base.password);
	assert.equal(ok.input.syncMode, "personal");
	assert.equal(ok.input.rememberSignIn, true);
	assert.equal(validation.parseCloudMemoryConnectInput({ ...base, account: "  " }).ok, false);
	assert.equal(validation.parseCloudMemoryConnectInput({ ...base, password: "a\nb" }).ok, false);
	assert.equal(validation.parseCloudMemoryConnectInput({ ...base, password: "" }).ok, false);
	assert.equal(validation.parseCloudMemoryConnectInput({ ...base, syncMode: "all" }).ok, false);
	assert.equal(validation.parseCloudMemoryConnectInput({ ...base, rememberSignIn: "yes" }).ok, false);
	assert.equal(validation.parseCloudMemoryConnectInput(null).ok, false);
	// 账号与密码不做 trim（密码前后空格可能是真实字符），但账号会 trim
	const padded = validation.parseCloudMemoryConnectInput({ ...base, account: " alice ", password: " p " });
	assert.equal(padded.ok, true);
	assert.equal(padded.input.account, "alice");
	assert.equal(padded.input.password, " p ");
});

test("cloudInstanceId：规范化 baseUrl 的完整 SHA-256，同址稳定、异址不同", () => {
	const a = validation.cloudInstanceIdFromOrigin("https://memory.example.com");
	const b = validation.cloudInstanceIdFromOrigin("https://memory.example.com");
	const c = validation.cloudInstanceIdFromOrigin("https://other.example.com");
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.equal(a.length, 64);
	assert.match(a, /^[0-9a-f]{64}$/);
	// 地址变化（含端口）即换隔离键：旧状态不能复用
	assert.notEqual(a, validation.cloudInstanceIdFromOrigin("https://memory.example.com:8443"));
});

test("人格哈希：与云端 normalizeText + sha256(JSON.stringify([text, enabled])) 口径一致，篡改即失败", () => {
	const text = validation.normalizePersonaText("你好\r\n世界 ");
	assert.equal(text, "你好\n世界");
	const revision = validation.personaRevisionOf(text, true);
	const rawRevision = validation.personaRawRevisionOf("你好\r\n世界 ", true);
	const snapshot = { text, originalText: "你好\r\n世界 ", enabled: true, revision, rawRevision };
	assert.equal(validation.verifyPersonaSnapshot(snapshot), true);
	assert.equal(validation.verifyPersonaSnapshot({ ...snapshot, text: "被篡改" }), false);
	assert.equal(validation.verifyPersonaSnapshot({ ...snapshot, enabled: false }), false);
	assert.equal(validation.verifyPersonaSnapshot({ ...snapshot, rawRevision: "0".repeat(64) }), false);
});

test("whoami 主体校验：必须是用户会话、账号一致、含 memory 作用域", () => {
	const ok = validation.validateCloudPrincipal({ kind: "user", username: "alice", scopes: ["memory", "chat"] }, "alice");
	assert.equal(ok.ok, true);
	assert.equal(ok.account, "alice");
	assert.deepEqual([...ok.scopes], ["memory", "chat"]);
	const device = validation.validateCloudPrincipal({ kind: "device", username: "alice", scopes: ["memory"] }, "alice");
	assert.equal(device.ok, false);
	assert.equal(device.error.code, "principalMismatch");
	const mismatch = validation.validateCloudPrincipal({ kind: "user", username: "bob", scopes: ["memory"] }, "alice");
	assert.equal(mismatch.ok, false);
	assert.equal(mismatch.error.code, "principalMismatch");
	const noScope = validation.validateCloudPrincipal({ kind: "user", username: "alice", scopes: ["chat"] }, "alice");
	assert.equal(noScope.ok, false);
	assert.equal(noScope.error.code, "scopeMissing");
	assert.equal(validation.validateCloudPrincipal(null, "alice").ok, false);
});
