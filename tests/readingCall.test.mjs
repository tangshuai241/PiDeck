/**
 * 契约调用兜底（callReading）：IPC 抛错必须变成结构化 internalError，
 * 让调用方沿用既有 ok/error 分支收尾（不永远 loading、不吞掉未确认反馈、不抛出未处理拒绝）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const calls = loadTsCommonJs("src/renderer/src/utils/readingCall.ts");

test("成功路径原样返回（不改写 ok 结果）", async () => {
	const result = await calls.callReading(async () => ({ ok: true, value: 42 }));
	assert.deepEqual(plain(result), { ok: true, value: 42 });
});

test("拒绝转成结构化 internalError，message 只作兜底且不含控制字符", async () => {
	const result = await calls.callReading(async () => {
		throw new Error("ipc down");
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internalError");
	assert.equal(result.error.message, "ipc down");
	// 非 Error 抛出（字符串/对象）也要有可读兜底
	const thrown = await calls.callReading(async () => {
		throw "boom";
	});
	assert.equal(thrown.error.code, "internalError");
	assert.equal(typeof thrown.error.message, "string");
	const objectThrown = await calls.callReading(async () => {
		throw { weird: true };
	});
	assert.equal(objectThrown.error.code, "internalError");
	assert.ok(objectThrown.error.message.length > 0);
});

test("超长/含换行的错误文本被截断与清洗，不把原始栈写进界面文案", async () => {
	const result = await calls.callReading(async () => {
		throw new Error(`line1\nline2 ${"x".repeat(500)}`);
	});
	assert.ok(result.error.message.length <= 200);
	assert.equal(/[\n\r]/.test(result.error.message), false);
});
