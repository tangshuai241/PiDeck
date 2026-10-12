/**
 * 程序检查：格式注册、正文/格式指纹分离、预算与超时、复杂结构一律如实标记。
 *
 * 关键约束：任何「没读到 / 读不完 / 不认识」都必须落 unverified，不得记 passed；
 * 正文相同但包不同必须被识别为「正文没变」，而不是整体相同。
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

function writeDocx(path, { paragraphs, styles }) {
	writeFileSync(
		path,
		buildZip([
			{ name: "[Content_Types].xml", content: "<Types/>" },
			{ name: "word/document.xml", content: buildDocxXml(paragraphs), deflate: true },
			{ name: "word/styles.xml", content: buildStylesXml(styles ?? []), deflate: true },
		]),
	);
}

const HEADING_STYLES = [
	{ styleId: "Heading1", name: "heading 1" },
	{ styleId: "Heading2", name: "heading 2" },
];

function item(output, id) {
	return plain(output.items).find((entry) => entry.id === id);
}

test("docx：结构干净时通过，并给出正文与格式两个独立指纹", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "out.docx");
		writeDocx(path, { paragraphs: [{ styleId: "Heading1", text: "第一章" }, "正文内容"], styles: HEADING_STYLES });
		const service = new DocumentInspectionService();
		const result = await service.inspect({ versionId: "v_1", filePath: path });
		assert.equal(result.status, "passed");
		assert.equal(result.coverage.format, "docx");
		assert.match(result.coverage.textDigest, /^[0-9a-f]{64}$/);
		assert.match(result.coverage.formatDigest, /^[0-9a-f]{64}$/);
		assert.equal(result.coverage.truncated, false);
		assert.deepEqual(plain(await service.outline(path)), ["第一章"]);
		assert.equal(
			result.items.some((entry) => entry.id === "body_content_changed"),
			false,
			"新建文稿不做正文变化判定",
		);
	});
});

test("docx：重复标题、未解析修订与文本框分别记 failed，不虚报通过", async () => {
	await withTempDir(async (root) => {
		const duplicated = join(root, "dup.docx");
		writeDocx(duplicated, { paragraphs: [{ styleId: "Heading1", text: "第一章" }, { styleId: "Heading1", text: "第一章" }, "正文"], styles: HEADING_STYLES });
		const tracked = join(root, "tracked.docx");
		writeDocx(tracked, { paragraphs: ["正文", { kind: "trackedInsert", text: "插入" }], styles: HEADING_STYLES });
		const textBox = join(root, "box.docx");
		writeDocx(textBox, { paragraphs: ["正文", { kind: "textBox", text: "框内文字" }], styles: HEADING_STYLES });
		const service = new DocumentInspectionService();
		assert.equal(item(await service.inspect({ versionId: "v_dup", filePath: duplicated }), "no_duplicate_headings").status, "failed");
		assert.equal(item(await service.inspect({ versionId: "v_tracked", filePath: tracked }), "no_unresolved_tracked_changes").status, "failed");
		assert.equal(item(await service.inspect({ versionId: "v_box", filePath: textBox }), "no_text_boxes").status, "failed");
		assert.equal((await service.inspect({ versionId: "v_dup2", filePath: duplicated })).status, "failed");
	});
});

test("docx：内容相同包不同 → 正文指纹相同、格式指纹不同", async () => {
	await withTempDir(async (root) => {
		const plainPackage = join(root, "a.docx");
		const richerPackage = join(root, "b.docx");
		const paragraphs = [{ styleId: "Heading1", text: "第一章" }, "同一段正文"];
		writeFileSync(
			plainPackage,
			buildZip([
				{ name: "word/document.xml", content: buildDocxXml(paragraphs) },
				{ name: "word/styles.xml", content: buildStylesXml(HEADING_STYLES) },
			]),
		);
		writeFileSync(
			richerPackage,
			buildZip([
				{ name: "word/document.xml", content: buildDocxXml(paragraphs) },
				{ name: "word/styles.xml", content: buildStylesXml(HEADING_STYLES) },
				{ name: "word/comments.xml", content: "<comments/>" },
			]),
		);
		const service = new DocumentInspectionService();
		const first = await service.inspect({ versionId: "v_a", filePath: plainPackage });
		const second = await service.inspect({ versionId: "v_b", filePath: richerPackage });
		assert.equal(first.coverage.textDigest, second.coverage.textDigest, "同一段正文必须得到同一正文指纹");
		assert.notEqual(first.coverage.formatDigest, second.coverage.formatDigest, "包结构不同必须体现在格式指纹上");
	});
});

test("同长度文本变化必须改变正文指纹，并与基稿对比判为已变化", async () => {
	await withTempDir(async (root) => {
		const base = join(root, "base.md");
		const revised = join(root, "revised.md");
		writeFileSync(base, "# 标题\n\n方案甲版本\n", "utf8");
		writeFileSync(revised, "# 标题\n\n方案乙版本\n", "utf8");
		assert.equal(readFileSync(base, "utf8").length, readFileSync(revised, "utf8").length, "样本必须等长");
		const service = new DocumentInspectionService();
		const baseResult = await service.inspect({ versionId: "v_base", filePath: base });
		const revisedResult = await service.inspect({ versionId: "v_rev", filePath: revised, comparedTo: { versionId: "v_base", textDigest: baseResult.coverage.textDigest } });
		assert.notEqual(baseResult.coverage.textDigest, revisedResult.coverage.textDigest);
		assert.equal(item(revisedResult, "body_content_changed").status, "passed");
		assert.equal(revisedResult.coverage.comparedToVersionId, "v_base");
	});
});

test("改稿但正文完全没变时判 failed，并保留版本记录里的失败事实", async () => {
	await withTempDir(async (root) => {
		const path = join(root, "same.md");
		writeFileSync(path, "# 标题\n\n一字不改\n", "utf8");
		const service = new DocumentInspectionService();
		const first = await service.inspect({ versionId: "v_1", filePath: path });
		const second = await service.inspect({ versionId: "v_2", filePath: path, comparedTo: { versionId: "v_1", textDigest: first.coverage.textDigest } });
		assert.equal(item(second, "body_content_changed").status, "failed");
		assert.equal(second.status, "failed");
	});
});

test("Markdown 同义改写：正文相同但块结构不同 → 格式指纹不同", async () => {
	await withTempDir(async (root) => {
		const headed = join(root, "headed.md");
		const quoted = join(root, "quoted.md");
		writeFileSync(headed, "# 段落\n\n内容行\n", "utf8");
		writeFileSync(quoted, "# 段落\n\n> 内容行\n", "utf8");
		const service = new DocumentInspectionService();
		const first = await service.inspect({ versionId: "v_1", filePath: headed });
		const second = await service.inspect({ versionId: "v_2", filePath: quoted });
		assert.equal(first.coverage.format, "markdown");
		assert.notEqual(first.coverage.formatDigest, second.coverage.formatDigest);
	});
});

test("未知格式、超预算与超时都记 unverified，不谎报通过", async () => {
	await withTempDir(async (root) => {
		const pdf = join(root, "report.pdf");
		writeFileSync(pdf, "%PDF-1.7 not really", "utf8");
		const unknown = await new DocumentInspectionService().inspect({ versionId: "v_pdf", filePath: pdf });
		assert.equal(unknown.status, "unverified");
		assert.equal(plain(unknown.items)[0].detail, "unknown_format");

		const markdown = join(root, "big.md");
		writeFileSync(markdown, `# 标题\n\n${"内容".repeat(4000)}\n`, "utf8");
		const overBudget = await new DocumentInspectionService({ byteBudget: 256 }).inspect({ versionId: "v_big", filePath: markdown });
		assert.equal(overBudget.status, "unverified");
		assert.equal(overBudget.coverage.truncated, true);

		const slow = { id: "slow", version: "slow-1", extensions: [".md"], inspect: () => new Promise(() => {}), outline: async () => [] };
		const timedOut = await new DocumentInspectionService({ inspectors: [slow], timeoutMs: 40 }).inspect({ versionId: "v_slow", filePath: markdown });
		assert.equal(timedOut.status, "unverified");
		assert.equal(timedOut.reason, "timeout");
	});
});

test("检查器按扩展名注册；未注册的扩展名不会被别的检查器接管", async () => {
	assert.deepEqual(plain(docxInspector.extensions), [".docx", ".dotx"]);
	assert.deepEqual(plain(markdownInspector.extensions), [".md", ".markdown", ".mdx"]);
	const service = new DocumentInspectionService({ inspectors: [markdownInspector] });
	assert.equal(service.resolve("a.docx"), undefined);
	assert.equal(service.resolve("a.MD")?.id, "markdown", "扩展名匹配必须大小写无关");
});
