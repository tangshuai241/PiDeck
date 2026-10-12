/**
 * 程序检查：格式注册、正文/格式指纹分离、逐块保留校验、预算与时限。
 *
 * 判定基线（评审修正后）：
 * - 只有能证明的未授权改动才 failed：声明要保留的块缺失或正文被改；
 * - 无法验证的结构（未解析修订、文本框、重复标题）记 unverified，不虚构质量失败；
 * - 正文没变不判失败：仅格式改稿本来就不改正文；
 * - 未知格式、超预算、超时一律 unverified，不虚报通过。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDocxXml, buildStylesXml, buildZip } from "./helpers/minimalZip.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { DocumentInspectionService } = loadTsCommonJs(`${ROOT}/src/main/document-work/DocumentInspectionService.ts`);
const { docxInspector, markdownInspector } = loadTsCommonJs(`${ROOT}/src/main/document-work/documentInspectors.ts`);
const inspectionTaskModule = loadTsCommonJs(`${ROOT}/src/main/document-work/inspectionTask.ts`);

/**
 * 业务测试用的 worker 桩：签名与真实 `Worker` 一致（once/terminate），在事件循环里跑同一份
 * 纯任务逻辑。真实可终止 worker 由 documentInspectionWorker.test.mjs 单独隔离验证。
 */
function inlineWorkerFactory() {
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

/** 每个用例都显式注入 worker 桩：服务不再有进程内回退路径。 */
function makeService(options = {}) {
	return new DocumentInspectionService({ workerFactory: inlineWorkerFactory(), ...options });
}

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 临时目录必须在异步用例结束后才清理，否则断言看到的是已被删掉的文件。 */
async function withTempDir(run) {
	const root = mkdtempSync(join(tmpdir(), "pideck-docwork-inspect-"));
	try {
		return await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 共用的 Markdown 样本：写成函数避免多行字面量在补丁中被展开成真实换行。 */
function markdownBody() {
	return ["# 标题", "", "正文", ""].join("\n");
}

function writeDocx(path, { paragraphs, styles, extra = [] }) {
	writeFileSync(path, buildZip([{ name: "[Content_Types].xml", content: "<Types/>" }, { name: "word/document.xml", content: buildDocxXml(paragraphs), deflate: true }, { name: "word/styles.xml", content: buildStylesXml(styles ?? []), deflate: true }, ...extra]));
}

const HEADING_STYLES = [
	{ styleId: "Heading1", name: "heading 1" },
	{ styleId: "Heading2", name: "heading 2" },
];

function item(output, id) {
	return plain(output.items).find((entry) => entry.id === id);
}

test("docx：结构干净时通过，并给出正文/格式两个指纹与块大纲", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "out.docx");
		writeDocx(path, { paragraphs: [{ styleId: "Heading1", text: "第一章" }, "正文内容"], styles: HEADING_STYLES });
		const service = makeService();
		const result = await service.inspect({ versionId: "v_1", filePath: path });
		assert.equal(result.status, "passed");
		assert.equal(result.coverage.format, "docx");
		assert.match(result.coverage.textDigest, /^[0-9a-f]{64}$/);
		assert.match(result.coverage.formatDigest, /^[0-9a-f]{64}$/);
		assert.deepEqual(
			plain(result.coverage.sections).map((section) => section.heading),
			["第一章"],
		);
		// 新建轮没有基稿，不产出「保留内容」检查项。
		assert.equal(item(result, "preserved_blocks_intact"), undefined);
		assert.deepEqual(plain((await service.analyze(path)).headings), ["第一章"]);
	});
});

test("无法验证的结构记 unverified，不虚构质量失败", async () => {
	await withTempDir(async (root) => {
		const duplicated = join(root, "dup.docx");
		writeDocx(duplicated, { paragraphs: [{ styleId: "Heading1", text: "第一章" }, { styleId: "Heading1", text: "第一章" }, "正文"], styles: HEADING_STYLES });
		const tracked = join(root, "tracked.docx");
		writeDocx(tracked, { paragraphs: ["正文", { kind: "trackedInsert", text: "插入" }], styles: HEADING_STYLES });
		const textBox = join(root, "box.docx");
		writeDocx(textBox, { paragraphs: ["正文", { kind: "textBox", text: "框内文字" }], styles: HEADING_STYLES });
		const service = makeService();
		for (const [file, id] of [
			[duplicated, "no_duplicate_headings"],
			[tracked, "no_unresolved_tracked_changes"],
			[textBox, "no_text_boxes"],
		]) {
			const result = await service.inspect({ versionId: "v_probe", filePath: file });
			assert.equal(item(result, id).status, "unverified", id);
			assert.equal(result.status, "unverified", id);
		}
	});
});

test("正文相同而包不同 → 正文指纹相同、格式指纹不同，且不因正文没变判失败", async () => {
	await withTempDir(async (root) => {
		const plainPackage = join(root, "a.docx");
		const richerPackage = join(root, "b.docx");
		const paragraphs = [{ styleId: "Heading1", text: "第一章" }, "同一段正文"];
		writeDocx(plainPackage, { paragraphs, styles: HEADING_STYLES });
		writeDocx(richerPackage, { paragraphs, styles: HEADING_STYLES, extra: [{ name: "word/comments.xml", content: "<comments/>" }] });
		const service = makeService();
		const base = await service.inspect({ versionId: "v_a", filePath: plainPackage });
		const formatOnly = await service.inspect({ versionId: "v_b", filePath: richerPackage, comparedTo: { versionId: "v_a", textDigest: base.coverage.textDigest, sections: base.coverage.sections } });
		assert.equal(base.coverage.textDigest, formatOnly.coverage.textDigest, "同一段正文必须得到同一正文指纹");
		assert.notEqual(base.coverage.formatDigest, formatOnly.coverage.formatDigest, "包结构不同必须体现在格式指纹上");
		assert.equal(formatOnly.status, "passed", "仅格式改稿不能因为正文没变而判失败");
		assert.equal(formatOnly.coverage.comparedToVersionId, "v_a");
	});
});

test("保留块被改或被删才判 failed，未被触碰时判通过", async () => {
	await withTempDir(async (root) => {
		const base = join(root, "base.md");
		writeFileSync(base, "# 第一章\n\n原始结论\n\n# 第二章\n\n可以改的部分\n", "utf8");
		const intact = join(root, "intact.md");
		writeFileSync(intact, "# 第一章\n\n原始结论\n\n# 第二章\n\n改过的部分\n", "utf8");
		const changed = join(root, "changed.md");
		writeFileSync(changed, "# 第一章\n\n被偷偷改掉的结论\n\n# 第二章\n\n改过的部分\n", "utf8");
		const removed = join(root, "removed.md");
		writeFileSync(removed, "# 第二章\n\n改过的部分\n", "utf8");
		const service = makeService();
		const baseResult = await service.inspect({ versionId: "v_base", filePath: base });
		const comparedTo = { versionId: "v_base", textDigest: baseResult.coverage.textDigest, sections: baseResult.coverage.sections };
		const okResult = await service.inspect({ versionId: "v_ok", filePath: intact, comparedTo, preserve: ["第一章"] });
		assert.equal(item(okResult, "preserved_blocks_intact").status, "passed");
		assert.equal(okResult.status, "passed", "声明要改的块变了不影响结论");

		const violated = await service.inspect({ versionId: "v_bad", filePath: changed, comparedTo, preserve: ["第一章"] });
		assert.equal(item(violated, "preserved_blocks_intact").status, "failed");
		assert.equal(item(violated, "preserved_blocks_intact").detail, "preserved_block_changed");
		assert.equal(violated.status, "failed");

		const missing = await service.inspect({ versionId: "v_gone", filePath: removed, comparedTo, preserve: ["第一章"] });
		assert.equal(item(missing, "preserved_blocks_intact").detail, "preserved_block_missing");
		assert.equal(missing.status, "failed");

		// 声明里没有要保留的块 = 允许自由改写：无法也不该虚构违规。
		const freeform = await service.inspect({ versionId: "v_free", filePath: changed, comparedTo, preserve: [] });
		assert.equal(item(freeform, "preserved_blocks_intact").status, "passed");
		assert.equal(freeform.status, "passed");

		// 基稿没有块大纲时无法逐块比较，必须记未验证而不是通过。
		const noOutline = await service.inspect({ versionId: "v_nooutline", filePath: changed, comparedTo: { versionId: "v_base", textDigest: baseResult.coverage.textDigest }, preserve: ["第一章"] });
		assert.equal(item(noOutline, "preserved_blocks_intact").status, "unverified");
		assert.equal(item(noOutline, "preserved_blocks_intact").detail, "base_outline_missing");
	});
});

test("同长度文本变化必须改变正文指纹并与基稿区分开", async () => {
	await withTempDir(async (root) => {
		const base = join(root, "base.md");
		const revised = join(root, "revised.md");
		writeFileSync(base, "# 标题\n\n方案甲版本\n", "utf8");
		writeFileSync(revised, "# 标题\n\n方案乙版本\n", "utf8");
		assert.equal(readFileSync(base, "utf8").length, readFileSync(revised, "utf8").length, "样本必须等长");
		const service = makeService();
		const baseResult = await service.inspect({ versionId: "v_base", filePath: base });
		const revisedResult = await service.inspect({ versionId: "v_rev", filePath: revised, comparedTo: { versionId: "v_base", textDigest: baseResult.coverage.textDigest, sections: baseResult.coverage.sections } });
		assert.notEqual(baseResult.coverage.textDigest, revisedResult.coverage.textDigest);
		assert.equal(revisedResult.coverage.comparedToVersionId, "v_base");
	});
});

test("Markdown 同义改写：正文相同但块结构不同 → 格式指纹不同", async () => {
	await withTempDir(async (root) => {
		const headed = join(root, "headed.md");
		const quoted = join(root, "quoted.md");
		writeFileSync(headed, "# 段落\n\n内容行\n", "utf8");
		writeFileSync(quoted, "# 段落\n\n> 内容行\n", "utf8");
		const service = makeService();
		const first = await service.inspect({ versionId: "v_1", filePath: headed });
		const second = await service.inspect({ versionId: "v_2", filePath: quoted });
		assert.equal(first.coverage.format, "markdown");
		assert.notEqual(first.coverage.formatDigest, second.coverage.formatDigest);
	});
});

test("未知格式、超预算、超时与损坏包都记 unverified，不谎报通过", async () => {
	await withTempDir(async (root) => {
		const pdf = join(root, "report.pdf");
		writeFileSync(pdf, "%PDF-1.7 not really", "utf8");
		const unknown = await makeService().inspect({ versionId: "v_pdf", filePath: pdf });
		assert.equal(unknown.status, "unverified");
		assert.equal(plain(unknown.items)[0].detail, "unknown_format");

		const markdown = join(root, "big.md");
		writeFileSync(markdown, `# 标题\n\n${"内容".repeat(4000)}\n`, "utf8");
		assert.equal((await makeService({ artifactByteBudget: 256 }).inspect({ versionId: "v_big", filePath: markdown })).status, "unverified");

		// 两级预算：成果本体放得下，但 OOXML 解包总量 / 单部件放不下 → unverified。
		const docx = join(root, "big.docx");
		writeDocx(docx, { paragraphs: [{ styleId: "Heading1", text: "第一章" }, "正文"], styles: HEADING_STYLES });
		assert.equal((await makeService({ unpackByteBudget: 16 }).inspect({ versionId: "v_unpack", filePath: docx })).status, "unverified");
		assert.equal((await makeService({ memberByteBudget: 16 }).inspect({ versionId: "v_member", filePath: docx })).status, "unverified");

		// 结构检查时限：截止时刻已过 → 记 timeout 未验证。
		const expired = await makeService({ timeoutMs: 0 }).inspect({ versionId: "v_slow", filePath: docx });
		assert.equal(expired.status, "unverified");
		assert.equal(item(expired, "within_time_budget").detail, "timeout");

		// 损坏包同样只能未验证。
		const broken = join(root, "broken.docx");
		writeFileSync(broken, Buffer.from("not a zip at all"));
		assert.equal((await makeService().inspect({ versionId: "v_broken", filePath: broken })).status, "unverified");
	});
});

test("拒绝重复部件与实体声明", async () => {
	await withTempDir(async (root) => {
		const duplicated = join(root, "dup.docx");
		writeFileSync(
			duplicated,
			buildZip([
				{ name: "word/document.xml", content: buildDocxXml(["正文"]) },
				{ name: "word/document.xml", content: buildDocxXml(["另一份"]) },
			]),
		);
		assert.equal((await makeService().inspect({ versionId: "v_dup", filePath: duplicated })).status, "unverified");

		const doctype = join(root, "entity.docx");
		writeFileSync(doctype, buildZip([{ name: "word/document.xml", content: `<!DOCTYPE x [<!ENTITY e "boom">]>${buildDocxXml(["正文"])}` }]));
		assert.equal((await makeService().inspect({ versionId: "v_entity", filePath: doctype })).status, "unverified");
	});
});

test("检查器按扩展名注册；未注册的扩展名不会被别的检查器接管", async () => {
	assert.deepEqual(plain(docxInspector.extensions), [".docx", ".dotx"]);
	assert.deepEqual(plain(markdownInspector.extensions), [".md", ".markdown", ".mdx"]);
	assert.equal(inspectionTaskModule.resolveInspector("a.docx", [markdownInspector]), undefined);
	assert.equal(inspectionTaskModule.resolveInspector("a.MD", [markdownInspector]).id, "markdown", "扩展名匹配必须大小写无关");
});

test("worker 不可用时记 unverified 而不是退回主线程解析", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "out.md");
		writeFileSync(path, markdownBody(), "utf8");
		const unavailable = await new DocumentInspectionService().inspect({ versionId: "v_1", filePath: path });
		assert.equal(unavailable.status, "unverified");
		assert.equal(unavailable.reason, "worker_unavailable");
		const crashing = await new DocumentInspectionService({
			workerFactory: () => {
				const listeners = new Map();
				const worker = {
					once(event, callback) {
						listeners.set(event, callback);
						return worker;
					},
					async terminate() {},
				};
				setTimeout(() => listeners.get("error")?.(new Error("boom")), 0);
				return worker;
			},
		}).inspect({ versionId: "v_2", filePath: path });
		assert.equal(crashing.status, "unverified");
		assert.equal(crashing.reason, "worker_crashed");
	});
});
