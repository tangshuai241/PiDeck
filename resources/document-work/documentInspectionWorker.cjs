/**
 * TPA 独立文稿：检查 worker 入口（worker_threads）。
 *
 * 主线程只负责读字节、投任务和收结论；**解析与比较全在这里**，所以 2 秒硬截止
 * 可以用 `terminate()` 真正切断，而不是在主线程里"等一个不会返回的同步循环"。
 *
 * 与 `src/main/document-work/documentInspectionCore.cjs` 是同一份实现（worker 用
 * workerData.corePath 找到它），因此没有第二份解析器。任务失败一律回结构化原因，
 * 由主线程记 `unverified`。
 */
"use strict";

const { parentPort, workerData } = require("node:worker_threads");

function run() {
	const core = require(workerData.corePath);
	// 测试注入点：只在显式传入时占用时间，用来验证超时会真的 terminate。
	if (typeof workerData.testDelayMs === "number" && workerData.testDelayMs > 0) {
		const end = Date.now() + workerData.testDelayMs;
		while (Date.now() < end) {
			// 故意同步忙等：模拟不可中断的 CPU 工作。
		}
	}
	return core.runInspectionJob(workerData.job);
}

try {
	parentPort.postMessage(run());
} catch (error) {
	parentPort.postMessage({ ok: false, reason: error instanceof Error ? error.message : String(error) });
}
