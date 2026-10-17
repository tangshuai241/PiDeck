/**
 * 图表导出 IPC 的边界行为：渲染层只给内容与建议文件名，主进程负责清洗、限体量、写盘。
 *
 * 关心的是「什么会被写盘、什么必须被拒绝」：非法格式、缺内容、超上限、取消保存
 * 都不应产生写盘动作；文件名里的路径分隔符与非法字符必须被清洗掉。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const ROOT = process.cwd();

function createHarness(initialDialogResult = { canceled: false, filePath: "C:/tmp/out.csv" }) {
	const handlers = new Map();
	const writes = [];
	let dialogResult = initialDialogResult;
	const dialogCalls = [];
	const sandbox = createTsSandbox({
		stubs: {
			electron: {
				ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
				dialog: {
					showSaveDialog: async (options) => {
						dialogCalls.push(options);
						return dialogResult;
					},
				},
			},
			"node:fs/promises": {
				writeFile: async (filePath, payload) => {
					writes.push({ filePath, payload });
				},
			},
			"../../shared/ipc": { ipcChannels: { chartExport: "chart:export" } },
		},
	});
	const mod = sandbox(join(ROOT, "src/main/ipc/chartIpc.ts"));
	const logs = [];
	mod.registerChartIpc({ appLogger: { info: (domain, message) => logs.push([domain, message]), error: (domain, message) => logs.push([domain, message]) } });
	return {
		handler: handlers.get("chart:export"),
		writes,
		dialogCalls,
		logs,
		setDialogResult: (next) => {
			dialogResult = next;
		},
		sanitize: mod.sanitizeChartExportName,
	};
}

test("writes a CSV to the path the user picked", async () => {
	const harness = createHarness({ canceled: false, filePath: "C:/tmp/支出.csv" });
	const result = await harness.handler(null, { format: "csv", suggestedName: "月度支出", text: "月份,人工费\n01,100" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, filePath: "C:/tmp/支出.csv" });
	assert.equal(harness.writes.length, 1);
	assert.equal(harness.writes[0].payload, "月份,人工费\n01,100");
	assert.match(harness.dialogCalls[0].defaultPath, /月度支出\.csv$/);
});

test("writes PNG bytes decoded from the data URL", async () => {
	const harness = createHarness({ canceled: false, filePath: "C:/tmp/out.png" });
	const result = await harness.handler(null, { format: "png", suggestedName: "月度支出", dataUrl: "data:image/png;base64,aGVsbG8=" });
	assert.equal(result.ok, true);
	assert.equal(harness.writes.length, 1);
	assert.equal(Buffer.isBuffer(harness.writes[0].payload), true);
	assert.equal(harness.writes[0].payload.toString("utf8"), "hello");
	assert.equal(harness.dialogCalls[0].filters[0].extensions[0], "png");
});

test("returns canceled without writing when the user closes the dialog", async () => {
	const harness = createHarness({ canceled: true, filePath: undefined });
	const result = await harness.handler(null, { format: "csv", suggestedName: "x", text: "a" });
	assert.equal(result.ok, false);
	assert.equal(result.canceled, true);
	assert.equal(harness.writes.length, 0);
});

test("rejects invalid formats, missing payloads and oversized payloads before any dialog", async () => {
	const harness = createHarness();
	const cases = [
		{ format: "pdf", suggestedName: "x", text: "a" },
		{ format: "csv", suggestedName: "x" },
		{ format: "png", suggestedName: "x", dataUrl: "data:image/jpeg;base64,AAAA" },
		{ format: "png", suggestedName: "x", dataUrl: "data:image/png;base64," },
		{ format: "csv", suggestedName: "x", text: "a".repeat(16 * 1024 * 1024 + 1) },
		{ suggestedName: "x", text: "a" },
	];
	for (const request of cases) {
		const result = await harness.handler(null, request);
		assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(request).slice(0, 60)}`);
	}
	assert.equal(harness.dialogCalls.length, 0);
	assert.equal(harness.writes.length, 0);
});

test("sanitizes the suggested file name instead of trusting it", () => {
	const harness = createHarness();
	// 路径被剥到只剩基本名
	assert.equal(harness.sanitize("C:\\Users\\me\\报表/支出", "csv"), "支出.csv");
	// 非法字符替换为空格，控制字符去掉
	assert.equal(harness.sanitize('a<b>c:d"e|f?g*h', "csv"), "a b c d e f g h.csv");
	// 空名与超长名有边界
	assert.equal(harness.sanitize("", "png"), "chart.png");
	assert.equal(harness.sanitize("   ", "png"), "chart.png");
	const long = harness.sanitize("长".repeat(500), "csv");
	assert.ok(long.length <= 124, `unexpected length ${long.length}`);
	// 已带目标扩展名时不重复追加
	assert.equal(harness.sanitize("chart.csv", "csv"), "chart.csv");
});
