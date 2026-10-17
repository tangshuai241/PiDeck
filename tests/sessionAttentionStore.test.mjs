import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionAttentionStore } = loadTsCommonJs("src/main/sessions/attention/SessionAttentionStore.ts");

async function withStore(run) {
	const dir = await mkdtemp(join(tmpdir(), "tpa-attention-"));
	const file = join(dir, "session-attention.json");
	try {
		return await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("完成结果按轮次身份保存：成功/失败/停止分别记录，停止直接视为已读", async () => {
	await withStore(async (file) => {
		const store = new SessionAttentionStore({ getFilePath: () => file });
		await store.load();

		const succeeded = store.beginRun("s1", 100);
		assert.equal(store.finishRun("s1", succeeded, "succeeded", 200)?.completion?.outcome, "succeeded");
		assert.equal(store.get("s1")?.handledCompletionId, undefined, "成功结果默认未读");

		const failed = store.beginRun("s1", 300);
		assert.equal(store.finishRun("s1", failed, "failed", 400)?.completion?.outcome, "failed");
		assert.equal(store.get("s1")?.completion?.id, failed, "最近结果替换为新结果");

		const aborted = store.beginRun("s1", 500);
		const entry = store.finishRun("s1", aborted, "aborted", 600);
		assert.equal(entry?.completion?.outcome, "aborted");
		assert.equal(entry?.handledCompletionId, aborted, "主动停止不产生新的完成未读");
	});
});

test("已读确认绑定具体结果：旧结果的迟到确认不清除新结果未读", async () => {
	await withStore(async (file) => {
		const store = new SessionAttentionStore({ getFilePath: () => file });
		await store.load();
		const first = store.beginRun("s1", 100);
		store.finishRun("s1", first, "succeeded", 200);
		store.acknowledge("s1", first);
		assert.equal(store.get("s1")?.handledCompletionId, first);

		const second = store.beginRun("s1", 300);
		store.finishRun("s1", second, "succeeded", 400);
		store.acknowledge("s1", first);
		assert.equal(store.get("s1")?.handledCompletionId, first, "旧结果确认不覆盖新结果");
		assert.notEqual(store.get("s1")?.handledCompletionId, store.get("s1")?.completion?.id);
	});
});

test("重启恢复：执行未结束的轮次表达为中断；已有结果与已读记录原样恢复", async () => {
	await withStore(async (file) => {
		const store = new SessionAttentionStore({ getFilePath: () => file });
		await store.load();
		const finished = store.beginRun("done", 100);
		store.finishRun("done", finished, "failed", 200);
		store.acknowledge("done", finished);
		const interrupted = store.beginRun("running", 300);
		await store.flush();

		const reopened = new SessionAttentionStore({ getFilePath: () => file, now: () => 900 });
		await reopened.load();
		assert.equal(reopened.get("done")?.completion?.outcome, "failed");
		assert.equal(reopened.get("done")?.handledCompletionId, finished);
		assert.equal(reopened.get("running")?.completion?.outcome, "interrupted");
		assert.equal(reopened.get("running")?.completion?.id, interrupted, "中断结果沿用该轮身份");
		assert.equal(reopened.get("running")?.handledCompletionId, undefined, "中断结果保持未读");
		assert.equal(reopened.get("never-run"), undefined, "老会话没有记录时保持空");
	});
});

test("状态文件损坏时从空状态开始，不阻断会话使用", async () => {
	await withStore(async (file) => {
		await writeFile(file, "{not-json");
		const store = new SessionAttentionStore({ getFilePath: () => file });
		await store.load();
		assert.equal(store.get("s1"), undefined);
		const runId = store.beginRun("s1", 100);
		await store.flush();
		assert.match(await readFile(file, "utf8"), new RegExp(runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
});
