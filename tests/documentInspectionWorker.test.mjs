/**
 * 真实 worker 的可终止性：同步忙等的 worker 必须被 2 秒内的时限硬终止。
 *
 * 这一条是「Promise.race 拦不住同步计算」的回归：宿主要真的 `terminate()`，
 * 并且把超时记成 unverified，而不是等它自己跑完。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { DocumentInspectionService } = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentInspectionService.ts`);
const workerUrl = (name) => new URL(`./helpers/${name}`, import.meta.url);

/** 临时目录必须在异步用例结束后才清理，否则断言看到的是已被删掉的文件。 */
async function withTempDir(run) {
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-worker-"));
	try {
		return await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("同步忙等的真实 worker 会在时限内被 terminate，并记 unverified", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "out.md");
		writeFileSync(path, "# 标题\n", "utf8");
		const service = new DocumentInspectionService({
			workerFactory: (options) => new Worker(workerUrl("hangingInspectorWorker.mjs"), options),
			timeoutMs: 300,
		});
		const started = Date.now();
		const result = await service.inspect({ versionId: "v_hang", filePath: path });
		const elapsed = Date.now() - started;
		assert.equal(result.status, "unverified");
		assert.equal(result.reason, "timeout");
		assert.ok(elapsed < 5_000, `必须在时限附近返回，实际 ${elapsed}ms`);
	});
});

test("真实 worker 的消息往返把结果映射成检查结论", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "out.md");
		writeFileSync(path, "# 标题\n", "utf8");
		const service = new DocumentInspectionService({ workerFactory: (options) => new Worker(workerUrl("cannedInspectorWorker.mjs"), options), timeoutMs: 2_000 });
		const result = await service.inspect({ versionId: "v_ok", filePath: path });
		assert.equal(result.status, "passed");
		assert.equal(result.inspectorVersion, "stub-1");
		assert.equal(result.coverage.format, "stub");
	});
});

test("electron-vite 的 ?nodeWorker 会产出独立 worker bundle（存在构建产物时校验）", () => {
	const chunksDirectory = join(ROOT, "out", "main");
	if (!existsSync(chunksDirectory)) {
		// 未构建时跳过：这条断言属于打包验证，不是业务行为。
		return;
	}
	const chunks = readdirSync(chunksDirectory);
	assert.ok(
		chunks.some((name) => name.startsWith("inspectionWorkerEntry-") && name.endsWith(".js")),
		"npm run build:main 必须产出独立的检查 worker bundle（?nodeWorker）",
	);
});
