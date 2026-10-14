// pi-deck-cloud-memory 人格缓存（pi-deck-cloud-memory-persona.ts）的针对性测试。
// 用 loadTsCommonJs 加载生产 TS；不碰网络与文件系统。
// 关键：镜像云端 domain-store 的 revision 算法（sha256(JSON.stringify([text, enabled]))），
// 这里用独立实现复算，防止两边公式悄悄漂移。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const persona = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-persona.ts");

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const cloudRevision = (text, enabled) => sha256(JSON.stringify([text, enabled]));
const cloudRawRevision = (raw, enabled) => sha256(JSON.stringify([raw, enabled]));

function cacheFile(overrides = {}) {
	const text = overrides.text ?? "用户偏好直接、少客套。\n决定：周五复盘。";
	const originalText = overrides.original_text ?? "  用户偏好直接、少客套。\r\n决定：周五复盘。  ";
	const enabled = overrides.enabled ?? true;
	return {
		version: 1,
		account: "acct_1",
		cloudInstanceId: "inst-abc",
		text,
		original_text: originalText,
		enabled,
		revision: overrides.revision ?? cloudRevision(text, enabled),
		raw_revision: overrides.raw_revision ?? cloudRawRevision(originalText, enabled),
		updated_at: "2026-10-13T00:00:00.000Z",
		fetched_at: "2026-10-13T00:10:00.000Z",
		...overrides,
	};
}

const EXPECTED = { account: "acct_1", cloudInstanceId: "inst-abc" };

test("revision 算法与云端 domain-store 一致（归一化正文 + 原稿分别绑定）", () => {
	const text = "决定：周五复盘。";
	const original = " 决定：周五复盘。\r\n";
	assert.equal(persona.personaRevision(text, true), cloudRevision(text, true));
	assert.equal(persona.personaRawRevision(original, true), cloudRawRevision(original, true));
	assert.notEqual(persona.personaRevision(text, true), persona.personaRevision(text, false), "enabled 参与 revision");
	assert.equal(persona.normalizePersonaText(original), text, "CRLF→LF 后 trim，与云端 normalizeText 一致");
	assert.equal(persona.normalizePersonaText(null), "");
});

test("缓存校验：账号/实例/两个 revision 任一不符都视为无人格（离线回默认规则）", () => {
	const ok = persona.parsePersonaCache(cacheFile(), EXPECTED);
	assert.equal(ok.kind, "ok");
	assert.equal(ok.persona.revision, cloudRevision(ok.persona.text, true));

	for (const [patch, reason] of [
		[{ account: "acct_2" }, "account_mismatch"],
		[{ cloudInstanceId: "other" }, "instance_mismatch"],
		[{ revision: "0".repeat(64) }, "revision_mismatch"],
		[{ raw_revision: "1".repeat(64) }, "raw_revision_mismatch"],
		[{ enabled: undefined }, "enabled_missing"],
		[{ version: 2 }, "version_unsupported"],
		[{ fetched_at: undefined }, "fetched_at_missing"],
		[{ text: undefined }, "text_missing"],
	]) {
		const result = persona.parsePersonaCache(cacheFile(patch), EXPECTED);
		assert.equal(result.kind, "none", `${JSON.stringify(patch)} 应回默认规则`);
		assert.equal(result.reason, reason);
	}
	// enabled=false 是「明确关闭人格」，与「没有缓存」区分，但仍不注入。
	const disabled = persona.parsePersonaCache(cacheFile({ enabled: false }), EXPECTED);
	assert.equal(disabled.kind, "disabled");
	assert.equal(disabled.reason, "persona_disabled");
	assert.equal(persona.parsePersonaCache(null, EXPECTED).reason, "cache_not_object");
	assert.equal(persona.parsePersonaCache(cacheFile(), { account: null, cloudInstanceId: "inst-abc" }).reason, "profile_account_missing");
	assert.equal(persona.parsePersonaCache(cacheFile(), { account: "acct_1", cloudInstanceId: null }).reason, "profile_instance_missing");
	assert.equal(persona.parsePersonaCache(cacheFile({ text: "", original_text: "" }), EXPECTED).reason, "text_empty");
});

test("注入文本：只追加短稿并保留来源标注，不替换系统提示；超上界显式截断", () => {
	const parsed = persona.parsePersonaCache(cacheFile(), EXPECTED);
	const append = persona.buildPersonaAppend(parsed.persona);
	assert.ok(append);
	assert.match(append.text, /只读；不改动系统提示、AGENTS 与项目规则/);
	assert.match(append.text, /决定：周五复盘。/);
	assert.match(append.text, new RegExp(parsed.persona.revision));
	assert.equal(append.truncated, false);

	const long = persona.parsePersonaCache(cacheFile({ text: "x".repeat(persona.MAX_PERSONA_APPEND_CHARS + 10), original_text: "y" }), EXPECTED);
	assert.equal(long.kind, "ok");
	const truncated = persona.buildPersonaAppend(long.persona);
	assert.equal(truncated.truncated, true);
	assert.match(truncated.text, /按本地上界截断/);
	assert.equal(truncated.text.length < long.persona.text.length + 200, true);

	const disabled = persona.parsePersonaCache(cacheFile({ enabled: false }), EXPECTED);
	assert.equal(persona.buildPersonaAppend(disabled.persona), null);
});
