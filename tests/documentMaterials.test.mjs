/**
 * anydoc 材料转换：固定 argv、按内容与转换器版本失效的缓存、失败如实返回。
 *
 * 只测转换决策与缓存语义；真实 anydoc 进程与真实 Pi 不在单元测试范围内。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
/** 被加载模块在 vm 里有独立原型链：结构比较前先 JSON 归一。 */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const materials = loadTsCommonJs(`${ROOT}/resources/extensions/pi-deck-document-materials.ts`);

/** 内存文件系统 + 可控 anydoc 运行器，避免真实子进程与缓存目录。 */
function createDeps(options = {}) {
	const files = new Map(Object.entries(options.files ?? {}));
	const runs = [];
	return {
		files,
		runs,
		deps: {
			cacheRoot: "/cache",
			run: async (argv, runOptions) => {
				runs.push({ argv, timeoutMs: runOptions.timeoutMs });
				const outcome = options.run ? options.run(argv, files, runs.length) : { code: 0, stdout: "", stderr: "" };
				// 固定 argv 形态是 [node, cli.js, source, "-o", output]，输出路径永远在末位。
				if (outcome.code === 0 && outcome.write !== undefined) files.set(argv[argv.length - 1], outcome.write);
				return outcome;
			},
			fingerprint: async (path) => {
				const text = files.get(path);
				return text === undefined ? undefined : digestOf(text);
			},
			readText: async (path) => files.get(path),
			writeText: async (path, text) => {
				files.set(path, text);
			},
			ensureDirectory: async () => {},
			remove: async (path) => {
				files.delete(path);
			},
			// 解析结果由用例给出：真实解析另有隔离测试，这里只验证「解析不到就失败」。
			resolveAnydocCli: async () => (options.cli === null ? undefined : (options.cli ?? { nodeExecPath: "/usr/bin/node", cliPath: "/npm/node_modules/@firecrawl/anydoc/cli.js", version: "0.2.4" })),
		},
	};
}

function digestOf(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

const DIGEST_A = createHash("sha256").update("case,value\n1,a\n", "utf8").digest("hex");

test("首次转换使用固定 argv 且不经 shell，并把结果写入缓存", async () => {
	const context = createDeps({ files: { "/in/a.docx": "case,value\n1,a\n" }, run: () => ({ code: 0, stdout: "ok", stderr: "", write: "# 转换后的 Markdown\n" }) });
	const result = await materials.convertMaterialWithAnyDoc(context.deps, { sourcePath: "/in/a.docx", digest: DIGEST_A });
	assert.equal(result.status, "converted");
	assert.equal(result.cached, false);
	assert.equal(result.markdown, "# 转换后的 Markdown\n");
	// 固定 argv：命令、输入、-o、输出四段；输出路径只是缓存位置，不含任何用户输入拼接。
	assert.deepEqual(plain(context.runs[0].argv), ["/usr/bin/node", "/npm/node_modules/@firecrawl/anydoc/cli.js", "/in/a.docx", "-o", join("/cache", DIGEST_A, createHash("sha256").update("anydoc-node-cli-2").digest("hex").slice(0, 16), "material.converted.md")]);
	assert.equal(context.runs[0].argv[1].endsWith("cli.js"), true, "argv 必须指向真实 Node CLI，不能是 npm shim");
	assert.equal(context.runs[0].timeoutMs, 120000, "转换时限按方案 120 秒");
	assert.equal(result.converterVersion, "anydoc-node-cli-2");
});

test("同一内容与同一转换器版本命中缓存，不再调用 anydoc", async () => {
	const context = createDeps({ files: { "/in/a.docx": "case,value\n1,a\n" }, run: () => ({ code: 0, stdout: "ok", stderr: "", write: "# 转换后的 Markdown\n" }) });
	await materials.convertMaterialWithAnyDoc(context.deps, { sourcePath: "/in/a.docx", digest: DIGEST_A });
	const second = await materials.convertMaterialWithAnyDoc(context.deps, { sourcePath: "/in/a.docx", digest: DIGEST_A });
	assert.equal(second.cached, true);
	assert.equal(context.runs.length, 1, "缓存命中不得再开子进程");
});

test("转换器版本变化时缓存失效并重新转换", async () => {
	const context = createDeps({ files: { "/in/a.docx": "case,value\n1,a\n" }, run: (_argv, files) => ({ code: 0, stdout: "ok", stderr: "", write: `# 转换 ${files.size}\n` }) });
	await materials.convertMaterialWithAnyDoc(context.deps, { sourcePath: "/in/a.docx", digest: DIGEST_A });
	const newer = await materials.convertMaterialWithAnyDoc(context.deps, { sourcePath: "/in/a.docx", digest: DIGEST_A, converterVersion: "anydoc-node-cli-3" });
	assert.equal(newer.cached, false, "转换器版本变化必须重新转换");
	assert.equal(context.runs.length, 2);
});

test("元数据损坏、空结果与非零退出都如实失败，不写入成功的缓存", async () => {
	const broken = createDeps({ files: { "/in/a.docx": "x" }, run: () => ({ code: 3, stdout: "", stderr: "unsupported format" }) });
	const failed = await materials.convertMaterialWithAnyDoc(broken.deps, { sourcePath: "/in/a.docx", digest: digestOf("x") });
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "unsupported format");
	assert.equal(
		[...broken.files.keys()].some((key) => key.endsWith("material.md")),
		false,
		"失败不得留下可用缓存",
	);

	const empty = createDeps({ files: { "/in/b.docx": "x" }, run: () => ({ code: 0, stdout: "", stderr: "" }) });
	const emptyResult = await materials.convertMaterialWithAnyDoc(empty.deps, { sourcePath: "/in/b.docx", digest: digestOf("x") });
	assert.equal(emptyResult.status, "failed");
	assert.equal(emptyResult.error, "conversion_empty");

	// 缓存元数据与源指纹不一致时必须重新转换，不能复用来源不明的缓存。
	const stale = createDeps({ files: { "/in/c.docx": "x" }, run: () => ({ code: 0, stdout: "", stderr: "", write: "# 新结果\n" }) });
	await materials.convertMaterialWithAnyDoc(stale.deps, { sourcePath: "/in/c.docx", digest: digestOf("x") });
	const metaKey = [...stale.files.keys()].find((key) => key.endsWith("meta.json"));
	stale.files.set(metaKey, "{ broken json");
	const recomputed = await materials.convertMaterialWithAnyDoc(stale.deps, { sourcePath: "/in/c.docx", digest: digestOf("x") });
	assert.equal(recomputed.cached, false);
	assert.equal(stale.runs.length, 2);
});

test("anydoc 运行器挂 error 监听并以非零退出结算，缺命令不会崩进程", async () => {
	const outcome = await materials.runAnyDoc(["definitely-not-a-real-command-xyz", "--version"], { timeoutMs: 5_000 });
	assert.notEqual(outcome.code, 0, "缺命令必须结算为非零退出而不是抛出");
	assert.equal(typeof outcome.stderr, "string");
});

test("本机真实 anydoc CLI 可被解析并以固定 argv 跑通 --version", async () => {
	// 隔离的真实调用：只跑 --version，不转换任何文稿、不联网、不调模型。
	const candidates = materials.anydocCliCandidates();
	const resolved = await materials.resolveAnydocCli({
		run: materials.runAnyDoc,
		exists: async (path) =>
			stat(path).then(
				(info) => info.isFile(),
				() => false,
			),
		candidates,
	});
	if (!resolved) return; // 本机没装 anydoc 时跳过；这是一条环境探针，不是业务行为。
	assert.ok(resolved.cliPath.endsWith("cli.js"), "必须解析到 Node CLI 入口而不是 npm shim");
	assert.match(resolved.version, /^\d/, "必须真的跑通 --version");
	const probe = await materials.runAnyDoc(materials.buildAnydocArgv(resolved, ".", "--version"), { timeoutMs: 30_000 });
	assert.equal(typeof probe.code, "number");
});
