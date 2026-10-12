// 收到任务就回一个固定结果的真实 worker：验证消息往返与结果映射这条路径。
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {});
parentPort?.postMessage({
	ok: true,
	kind: "inspect",
	inspectorId: "stub",
	inspectorVersion: "stub-1",
	output: {
		items: [{ id: "package_readable", status: "passed" }],
		coverage: { format: "stub", bytesRead: 1, bytesTotal: 1, textDigest: "a".repeat(64), formatDigest: "b".repeat(64), truncated: false },
		headings: [],
	},
});
