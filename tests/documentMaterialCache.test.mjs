/**
 * 材料登记与转换缓存：materialId 与缓存路径校验、固定 argv 不经过 shell、
 * 缓存命中/失效、转换中原件变化、失败不写"已读"。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryFs } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentMaterialCache, buildMaterialCommand } = loadTsCommonJs("src/main/document-work/DocumentMaterialCache.ts");

const MATERIAL = "work/materials/report.docx";
const CONVERTER_VERSION = "anydoc-v1";

function setup(options = {}) {
	const memory = createMemoryFs({ dirs: ["C:/out/work/materials", "C:/userData/materials"], files: { [`C:/out/${MATERIAL}`]: options.material ?? "docx-bytes" } });
	const commands = [];
	const cache = new DocumentMaterialCache({
		fs: memory.fs,
		cacheRootPath: "C:/userData/materials",
		converterVersion: options.converterVersion ?? CONVERTER_VERSION,
		maxSourceBytes: 1024,
		timeoutMs: 1000,
		now: () => 111,
		resolveExecutable: () => (options.noExecutable ? undefined : (options.executable ?? "anydoc")),
		runConversion: async (command) => {
			commands.push(command);
			if (options.fail) return { code: 3, stdout: "", stderr: "boom" };
			if (options.timeout) return { failure: "the converter timed out" };
			if (options.mutateSource) memory.write(`C:/out/${MATERIAL}`, "changed-during-conversion");
			if (!options.noOutput) memory.write(command.args[2], "converted markdown");
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	return { memory, cache, commands };
}

test("固定 argv：数组形式、不做 shell 拼接", () => {
	const command = buildMaterialCommand({ executable: "anydoc", inputAbsolutePath: "C:/out/a b.docx", outputAbsolutePath: "C:/out/out.md", timeoutMs: 1234 });
	assert.deepEqual([...command.args], ["C:/out/a b.docx", "-o", "C:/out/out.md"]);
	assert.equal(command.file, "anydoc");
	assert.equal(command.timeoutMs, 1234);
	// 参数里没有 shell 元字符包装，也没有字符串拼接。
	assert.equal(
		command.args.some((value) => /[;&|`$]/.test(value)),
		false,
	);
});

test("首次转换写缓存，原件未变时命中缓存且不再调用转换器", async () => {
	const { cache, commands, memory } = setup();
	const first = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(first.ok, true);
	assert.equal(first.value.cacheHit, false);
	assert.equal(first.value.markdown, "converted markdown");
	assert.equal(commands.length, 1);
	assert.ok(memory.fs.exists(`C:/userData/materials/${first.value.sourceSha256.slice(0, 2)}/${first.value.sourceSha256}/mat_1.meta.json`));
	const second = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(second.ok, true);
	assert.equal(second.value.cacheHit, true);
	assert.equal(commands.length, 1, "命中缓存时不得再跑转换器");
});

test("转换器版本变化导致缓存失效", async () => {
	const { memory, commands } = setup();
	const first = setup({ material: "docx-bytes" });
	const result = await first.cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(result.ok, true);
	const upgraded = new DocumentMaterialCache({
		fs: first.memory.fs,
		cacheRootPath: "C:/userData/materials",
		converterVersion: "anydoc-v2",
		maxSourceBytes: 1024,
		timeoutMs: 1000,
		resolveExecutable: () => "anydoc",
		runConversion: async (command) => {
			commands.push(command);
			first.memory.write(command.args[2], "converted markdown");
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const again = await upgraded.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(again.ok, true);
	assert.equal(again.value.cacheHit, false);
	assert.equal(commands.length, 1);
	void memory;
});

test("缓存被外部改写时按未命中处理", async () => {
	const { cache, commands, memory } = setup();
	const first = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(first.ok, true);
	const dir = `C:/userData/materials/${first.value.sourceSha256.slice(0, 2)}/${first.value.sourceSha256}`;
	memory.write(`${dir}/mat_1.md`, "tampered content");
	const second = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(second.ok, true);
	assert.equal(second.value.cacheHit, false);
	assert.equal(commands.length, 2);
});

test("原件在转换中变化：拒绝结果，不写缓存也不写已读", async () => {
	const { cache, memory } = setup({ mutateSource: true });
	const result = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_CHANGED");
	// 缓存目录里不能留下 meta（否则下一次会被误当成已读）。
	const entries = memory.fs.listDir("C:/userData/materials");
	assert.equal(
		entries.some((name) => name.includes("mat_1.meta.json")),
		false,
	);
});

test("转换器非零退出或超时都是失败，不产缓存", async () => {
	for (const options of [{ fail: true }, { timeout: true }, { noOutput: true }]) {
		const { cache, memory } = setup(options);
		const result = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
		assert.equal(result.ok, false, JSON.stringify(options));
		const shards = memory.fs.listDir("C:/userData/materials");
		for (const shard of shards) {
			for (const name of memory.fs.listDir(`C:/userData/materials/${shard}`)) assert.equal(name.includes(".meta.json"), false, name);
		}
	}
});

test("纯文本材料直接返回，不调用转换器也不写缓存", async () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work/materials"], files: { "C:/out/work/materials/notes.md": "# notes\n" } });
	const commands = [];
	const cache = new DocumentMaterialCache({
		fs: memory.fs,
		cacheRootPath: "C:/userData/materials",
		maxSourceBytes: 1024,
		timeoutMs: 1000,
		resolveExecutable: () => "anydoc",
		runConversion: async (command) => {
			commands.push(command);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	const result = await cache.convert({ materialId: "mat_2", sourceAbsolutePath: "C:/out/work/materials/notes.md", relativePath: "work/materials/notes.md" });
	assert.equal(result.ok, true);
	assert.equal(result.value.markdown, "# notes\n");
	assert.equal(commands.length, 0);
});

test("materialId 与源路径边界校验", async () => {
	const { cache } = setup();
	const badId = await cache.convert({ materialId: "../escape", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(badId.ok, false);
	assert.equal(badId.error.code, "INVALID_INPUT");
	const missing = cache.resolveSource("C:/out", "../outside.docx");
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "PATH_DENIED");
	const overBudget = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(overBudget.ok, true);
	const tooBig = createMemoryFs({ dirs: ["C:/out/work/materials"], files: { "C:/out/work/materials/big.pdf": "x".repeat(4096) } });
	const strict = new DocumentMaterialCache({ fs: tooBig.fs, cacheRootPath: "C:/userData/materials", maxSourceBytes: 1024, timeoutMs: 1000, resolveExecutable: () => "anydoc" });
	const rejected = await strict.convert({ materialId: "mat_3", sourceAbsolutePath: "C:/out/work/materials/big.pdf", relativePath: "work/materials/big.pdf" });
	assert.equal(rejected.ok, false);
});

test("转换器缺失时如实报错，不假装转换成功", async () => {
	const { cache } = setup({ noExecutable: true });
	const result = await cache.convert({ materialId: "mat_1", sourceAbsolutePath: "C:/out/work/materials/report.docx", relativePath: MATERIAL });
	assert.equal(result.ok, false);
	assert.match(result.error.detail ?? "", /not available/);
});
