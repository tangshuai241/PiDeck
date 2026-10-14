/**
 * CloudMemoryClient 单测：响应体真流式有界、错误分类固定且不回显服务端文本。
 *
 * 为什么单独立文件：这两条是安全边界（DoS 面 + 日志/界面回显面），用替身 fetch 直接断言
 * 比在 Service 层间接验证更准；不依赖网络与 Electron。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const clientModule = loadTsCommonJs("src/main/cloudMemory/cloudMemoryClient.ts");

/** 替身响应：body 走 getReader 流式，分块产出且记录 cancel。 */
function streamedResponse(chunks, { status = 200 } = {}) {
	const state = { cancelled: false };
	let index = 0;
	const body = {
		getReader: () => ({
			read: async () => {
				if (index >= chunks.length) return { done: true };
				const value = Buffer.from(chunks[index], "utf8");
				index += 1;
				return { done: false, value: new Uint8Array(value) };
			},
			cancel: async () => {
				state.cancelled = true;
			},
		}),
	};
	return { response: { status, body }, state };
}

test("响应超上限：流式累计到上限立即 cancel，不把整个 body 读进内存", async () => {
	const big = "x".repeat(clientModule.MAX_RESPONSE_BYTES);
	const { response, state } = streamedResponse([big, big, big]);
	const client = clientModule.createCloudMemoryClient({ fetchImpl: async () => response });
	const result = await client.persona("https://memory.example.com", "token");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internalError");
	assert.equal(state.cancelled, true, "超限必须取消流，不能继续读完");
});

test("响应在上限内：正常解析 JSON 载荷", async () => {
	const { response } = streamedResponse([JSON.stringify({ text: "ok", revision: "r" })]);
	const client = clientModule.createCloudMemoryClient({ fetchImpl: async () => response });
	const result = await client.persona("https://memory.example.com", "token");
	assert.equal(result.ok, true);
	// vm realm 的 Object.prototype 与测试侧不同，逐字段比较而不是 deepEqual
	assert.equal(result.payload.text, "ok");
	assert.equal(result.payload.revision, "r");
});

test("错误不回显服务端文本：只给固定分类与 HTTP status", async () => {
	const serverText = JSON.stringify({ error: { code: "SCOPE_DENIED", message: "服务端内部细节 <script>alert(1)</script> abc-secret-token" } });
	const cases = [
		{ status: 401, code: "unauthorized" },
		{ status: 403, code: "scopeMissing" },
		{ status: 500, code: "internalError" },
		{ status: 418, code: "internalError" },
	];
	for (const { status, code } of cases) {
		const { response } = streamedResponse([serverText], { status });
		const client = clientModule.createCloudMemoryClient({ fetchImpl: async () => response });
		const result = await client.persona("https://memory.example.com", "token");
		assert.equal(result.ok, false, `${status} 必须失败`);
		assert.equal(result.error.code, code, `${status} 错误分类固定`);
		assert.equal(result.error.message.includes("abc-secret-token"), false, "不得回显服务端文本");
		assert.equal(result.error.message.includes("script"), false, "不得回显服务端文本");
	}
});

test("网络异常：归为 offline 且不泄漏底层异常文本", async () => {
	const client = clientModule.createCloudMemoryClient({
		fetchImpl: async () => {
			throw new Error("connect ECONNREFUSED 10.0.0.1:4790?token=leak");
		},
	});
	const result = await client.persona("https://memory.example.com", "token");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "offline");
	assert.equal(result.error.message.includes("leak"), false);
});
