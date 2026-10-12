/**
 * 生产环境的 worker 工厂：用 electron-vite 的 `?nodeWorker` 插件把 TS 入口独立编译成
 * 可加载的 worker bundle，所以这里不需要新增 resources 交付物或依赖。
 *
 * 只有真正的主进程入口（`main/index.ts`）会 import 本文件；业务测试用注入的工厂替代，
 * 因此 `loadTsCommonJs` 不会碰到 `?nodeWorker` 查询串。
 */
import createWorker from "./inspectionWorkerEntry.ts?nodeWorker";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { setInspectionWorkerFactory } from "./DocumentInspectionService";

export function installInspectionWorkerFactory(): void {
	setInspectionWorkerFactory((options: WorkerOptions): Worker => createWorker(options));
}
