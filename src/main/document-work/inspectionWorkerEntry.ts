/**
 * 结构检查 worker 入口。
 *
 * 为什么必须是独立入口：XML/ZIP 解析是同步 CPU 工作，`Promise.race` 拦不住已经进入
 * 同步计算的调用；只有把整份计算放进可 `terminate()` 的 worker，2 秒时限才真的成立。
 *
 * 该文件只做「收任务 → 跑纯逻辑 → 回结果」；不读配置、不发 IPC、不碰 Electron。
 */
import { parentPort, workerData } from "node:worker_threads";
import { decodeInspectionTaskInput, runInspectionTask } from "./inspectionTask";

const port = parentPort;
if (port) {
	const input = decodeInspectionTaskInput(workerData);
	void (input ? runInspectionTask(input) : Promise.resolve({ ok: false, reason: "inspector_failed" })).then((result) => port.postMessage(result)).catch(() => port.postMessage({ ok: false, reason: "inspector_failed" }));
}
