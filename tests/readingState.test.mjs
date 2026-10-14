/**
 * 阅读页状态映射：错误码 → 文案、可用性决策（连不上/需要密码/未部署/就绪）、能力位三态。
 *
 * 「入口可用性要真实页面状态」在这里落地：静态 ready 只说明页面已实现，
 * 服务是否在线由这次决策给出，不用布尔值冒充。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const state = loadTsCommonJs("src/renderer/src/utils/readingState.ts");

function status(overrides = {}) {
	return { availability: "ready", connection: { baseUrl: "http://127.0.0.1:18965", connected: true, authRequired: null, credentialStored: false, rememberPassword: false, lastError: null, lastConnectedAt: null }, notesApi: null, historyApi: null, dataDir: "/tmp", ...overrides };
}

test("错误码映射：每个契约错误码都有文案，未知码不落到服务端文本", () => {
	const codes = ["unavailable", "needsConnection", "invalidInput", "notFound", "unsupported", "staleVersion", "conflict", "unknownOutcome", "writeFailed", "secureStorageUnavailable", "internalError"];
	for (const code of codes) {
		const key = state.readingErrorKey(code);
		assert.match(key, /^reading\.error/, `${code} 必须有 reading.error* 文案`);
	}
	assert.equal(state.readingErrorKey("futureCode"), "reading.errorInternal");
	assert.equal(state.readingErrorInfoKey(null), null);
	assert.equal(state.readingErrorInfoKey({ code: "notFound", message: "x" }), "reading.errorNotFound");
});

test("可用性决策：加载中 / 就绪 / 需要密码 / 连不上 / 未部署，各自分清", () => {
	assert.equal(state.resolveReadingAvailabilityDecision({ status: null, error: null, loading: true }).kind, "loading");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: null, error: null, loading: false }).kind, "loading", "还没拿到状态不等于在线");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: status(), error: null, loading: false }).kind, "ready");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: status({ availability: "needsConnection" }), error: null, loading: false }).kind, "needsConnection");
	const unavailable = state.resolveReadingAvailabilityDecision({ status: status({ availability: "unavailable" }), error: null, loading: false });
	assert.equal(unavailable.kind, "unavailable");
	assert.equal(unavailable.errorKey, "reading.errorUnavailable");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: null, error: { code: "needsConnection", message: "x" }, loading: false }).kind, "needsConnection", "401 是正常路径，可以就地输入密码");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: null, error: { code: "unsupported", message: "x" }, loading: false }).kind, "unsupported");
	assert.equal(state.resolveReadingAvailabilityDecision({ status: null, error: { code: "internalError", message: "x" }, loading: false }).kind, "unavailable");
});

test("未探测状态按「有没有成功过」收口：无成功历史回连接面板，有历史才继续等（不扫默认口）", () => {
	const fresh = status({ availability: "unknown", connection: { baseUrl: "http://127.0.0.1:18965", connected: false, authRequired: null, credentialStored: false, rememberPassword: false, lastError: null, lastConnectedAt: null } });
	assert.equal(state.resolveReadingAvailabilityDecision({ status: fresh, error: null, loading: false, hasPriorSuccess: false }).kind, "needsConnection", "从未成功过：显示连接面板，不停在 loading");
	const hadSuccess = status({ availability: "unknown", connection: { ...fresh.connection, lastConnectedAt: "2026-10-14T10:00:00.000Z" } });
	assert.equal(state.resolveReadingAvailabilityDecision({ status: hadSuccess, error: null, loading: false, hasPriorSuccess: true }).kind, "loading", "成功过但还没读到：保持加载态等结果");
	// 判定只看成功证据：connected===true 或有有效 lastConnectedAt；credentialStored/authRequired 都不算
	assert.equal(state.readingConnectionHasPriorSuccess({ connected: true, lastConnectedAt: null }), true);
	assert.equal(state.readingConnectionHasPriorSuccess({ connected: false, lastConnectedAt: "2026-10-14T10:00:00.000Z" }), true);
	assert.equal(state.readingConnectionHasPriorSuccess({ connected: false, lastConnectedAt: null, credentialStored: true, authRequired: true }), false);
	assert.equal(state.readingConnectionHasPriorSuccess(null), false);
	// 已连接状态不受新入参影响
	assert.equal(state.resolveReadingAvailabilityDecision({ status: status(), error: null, loading: false, hasPriorSuccess: false }).kind, "ready");
});

test("能力位三态：未探测 / 可用 / 服务未提供分别说明", () => {
	assert.equal(state.readingCapabilityState(null), "unknown");
	assert.equal(state.readingCapabilityState(true), "available");
	assert.equal(state.readingCapabilityState(false), "unsupported");
	assert.equal(state.readingCapabilityNoticeKey("unsupported"), "reading.capabilityUnsupported");
	assert.equal(state.readingCapabilityNoticeKey("available"), null);
	assert.equal(state.readingCapabilityNoticeKey("unknown"), null);
});

test("位置陈旧原因：只有版本不符与章节缺失要提示，none 不占位", () => {
	assert.equal(state.readingStaleReasonKey("versionMismatch"), "reading.positionStaleVersion");
	assert.equal(state.readingStaleReasonKey("missing"), "reading.positionStaleMissing");
	assert.equal(state.readingStaleReasonKey("none"), null);
});

test("可重试判定：unsupported / invalidInput 不自动重试（不轮询、不刷请求）", () => {
	assert.equal(state.readingErrorIsRetryable("unavailable"), true);
	assert.equal(state.readingErrorIsRetryable("needsConnection"), true);
	assert.equal(state.readingErrorIsRetryable("unsupported"), false);
	assert.equal(state.readingErrorIsRetryable("invalidInput"), false);
});
