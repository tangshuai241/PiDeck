/**
 * 业务测试用的检查 worker 桩。
 *
 * 与真实 `Worker` 的接口一致（once/terminate），在事件循环里跑同一份纯任务逻辑，
 * 因此服务层的并发闸门、结果映射和聚合逻辑都被真实执行，只有「进程隔离」被替换。
 * 真实可终止 worker 由 documentInspectionWorker.test.mjs 用挂在测试夹具上验证。
 */
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const ROOT = process.cwd();
const inspectionTaskModule = loadTsCommonJs(`${ROOT}/src/main/document-work/inspectionTask.ts`);

export function createInlineInspectionWorkerFactory() {
	return (options) => {
		const listeners = new Map();
		const worker = {
			once(event, callback) {
				listeners.set(event, callback);
				return worker;
			},
			async terminate() {},
		};
		setTimeout(() => {
			void inspectionTaskModule.runInspectionTask(options.workerData).then((output) => listeners.get("message")?.(output));
		}, 0);
		return worker;
	};
}
