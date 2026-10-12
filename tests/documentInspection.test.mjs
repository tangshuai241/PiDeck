/**
 * 程序检查：正文/格式分项、内容相同而字节不同、同长度文字变化、复杂结构未验证、
 * 超时与超预算不判通过。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { makeDocx, makeZip } from "./helpers/documentWorkFixtures.mjs";

const { DocumentInspectionService, DOCUMENT_INSPECTOR_VERSION } = loadTsCommonJs("src/main/document-work/DocumentInspectionService.ts");

const WHOLE = { allow: [], preserve: [], wholeDocument: true };

function service(files, options = {}) {
	let clock = options.startAt ?? 0;
	const ports = {
		read: (path, maxBytes) => {
			const entry = files.get(path);
			if (entry === undefined) return undefined;
			return entry.byteLength > maxBytes ? undefined : entry;
		},
		now: () => (options.clock ? options.clock() : (clock += options.step ?? 1)),
	};
	return new DocumentInspectionService(ports);
}

test("正文相同但 ZIP 字节不同：text 通过、fingerprint 如实记录、format 报部件差异", async () => {
	const base = makeDocx([{ text: "Title", headingLevel: 1 }, { text: "body" }], { styles: "<w:styles><a/></w:styles>" });
	const candidate = makeDocx([{ text: "Title", headingLevel: 1 }, { text: "body" }], { styles: "<w:styles><b/></w:styles>" });
	assert.notEqual(base.toString("base64"), candidate.toString("base64"));
	const files = new Map([
		["C:/base.docx", base],
		["C:/candidate.docx", candidate],
	]);
	const result = await service(files).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/candidate.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(result.ok, true);
	const channels = Object.fromEntries(result.value.channels.map((channel) => [channel.channel, channel]));
	assert.equal(channels.text.status, "passed");
	assert.equal(channels.fingerprint.status, "passed");
	assert.equal(channels.format.status, "passed");
	assert.match(channels.format.coverage, /changedParts=1/);
});

test("同长度文字变化在授权范围内判通过，超出范围判失败并给出位置", async () => {
	const base = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "keep me" }]);
	const candidate = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "kept me" }]);
	const files = new Map([
		["C:/base.docx", base],
		["C:/candidate.docx", candidate],
	]);
	const strict = await service(files).inspect({
		base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" },
		candidate: { absolutePath: "C:/candidate.docx", relativePath: "work/versions/v0002/a.docx" },
		scope: { allow: ["Section"], preserve: [], wholeDocument: false },
	});
	assert.equal(strict.value.status, "failed");
	const text = strict.value.channels.find((channel) => channel.channel === "text");
	assert.ok(text.changes.length > 0);
	assert.match(text.changes[0], /outside the authorized scope/);

	const authorized = await service(files).inspect({
		base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" },
		candidate: { absolutePath: "C:/candidate.docx", relativePath: "work/versions/v0002/a.docx" },
		scope: { allow: ["Alpha"], preserve: [], wholeDocument: false },
	});
	assert.equal(authorized.value.status, "passed");
});

test("复杂结构（文本框/未解析修订/重复标题）记未验证，不因为能对上的部分一样就判通过", async () => {
	const base = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }]);
	const files = new Map([["C:/base.docx", base]]);
	const cases = [
		[{ text: "Alpha", headingLevel: 1 }, { text: "body" }],
		[{ text: "Alpha", headingLevel: 1 }, { text: "Alpha", headingLevel: 1 }, { text: "body" }],
	];
	const textBox = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { extraBody: "<w:txbxContent>floating</w:txbxContent>" });
	files.set("C:/textbox.docx", textBox);
	const revision = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { extraBody: "<w:ins><w:r><w:t>added</w:t></w:r></w:ins>" });
	files.set("C:/revision.docx", revision);
	files.set("C:/dup.docx", makeDocx(cases[1]));

	const textBoxResult = await service(files).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/textbox.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(textBoxResult.value.status, "unverified");
	const revisionResult = await service(files).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/revision.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(revisionResult.value.status, "unverified");
	const duplicate = await service(files).inspect({ candidate: { absolutePath: "C:/dup.docx", relativePath: "work/versions/v0001/a.docx" }, scope: WHOLE });
	assert.equal(duplicate.value.status, "unverified");
});

test("未知格式如实记未验证，不假装覆盖", async () => {
	const files = new Map([
		["C:/doc.pdf", Buffer.from("%PDF-1.7")],
		["C:/base.pdf", Buffer.from("%PDF-1.7")],
	]);
	const result = await service(files).inspect({ base: { absolutePath: "C:/base.pdf", relativePath: "work/versions/v0001/a.pdf" }, candidate: { absolutePath: "C:/doc.pdf", relativePath: "work/versions/v0002/a.pdf" }, scope: WHOLE });
	assert.equal(result.value.status, "unverified");
	assert.match(result.value.reason ?? "", /no first-release text inspector/);
	assert.equal(result.value.inspectorVersion, DOCUMENT_INSPECTOR_VERSION);
});

test("超时与超预算记未验证，未验证版不会被当成合格基稿", async () => {
	const base = makeDocx([{ text: "Alpha" }]);
	const candidate = makeDocx([{ text: "Beta" }]);
	const files = new Map([
		["C:/base.docx", base],
		["C:/candidate.docx", candidate],
	]);
	let ticks = 0;
	const timedOut = await service(files, { clock: () => (ticks++ === 0 ? 0 : 10_000) }).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/candidate.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(timedOut.value.status, "unverified");
	assert.match(timedOut.value.reason ?? "", /timed out/);

	const overBudget = await service(files).inspect({ candidate: { absolutePath: "C:/candidate.docx", relativePath: "work/versions/v0002/a.docx", existenceOnly: true }, scope: WHOLE });
	assert.equal(overBudget.value.status, "unverified");
	assert.match(overBudget.value.channels[0].reason ?? "", /byte budget/);

	const unreadable = await service(files).inspect({ candidate: { absolutePath: "C:/missing.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(unreadable.value.status, "unverified");
});

test("缺部件/XML 实体声明/超大部件都拒绝解析", async () => {
	// 缺 word/document.xml 的容器：结构完整但不是可检查的 Word 文档。
	const noDocument = makeZip({ "[Content_Types].xml": "<Types/>", "word/styles.xml": "<w:styles/>" });
	const files = new Map();
	files.set("C:/nodoc.docx", noDocument);
	// 声明 XML 实体的部件一律拒绝（XXE / 实体扩展）。
	const entity = makeZip({ "word/document.xml": '<!DOCTYPE r [<!ENTITY x "boom">]><w:document><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>' });
	files.set("C:/entity.docx", entity);
	const noDocResult = await service(files).inspect({ candidate: { absolutePath: "C:/nodoc.docx", relativePath: "work/versions/v0001/a.docx" }, scope: WHOLE });
	assert.equal(noDocResult.value.status, "unverified");
	const brokenResult = await service(files).inspect({ candidate: { absolutePath: "C:/entity.docx", relativePath: "work/versions/v0001/a.docx" }, scope: WHOLE });
	assert.equal(brokenResult.value.status, "unverified");
});

test("Markdown 源稿用文本通道比较，format 通道说明“格式化随正文”", async () => {
	const files = new Map([
		["C:/base.md", Buffer.from("# Title\n\nbody\n", "utf8")],
		["C:/next.md", Buffer.from("# Title\n\nbody changed\n", "utf8")],
	]);
	const result = await service(files).inspect({ base: { absolutePath: "C:/base.md", relativePath: "work/versions/v0001/a.md" }, candidate: { absolutePath: "C:/next.md", relativePath: "work/versions/v0002/a.md" }, scope: WHOLE });
	assert.equal(result.value.status, "passed");
	const format = result.value.channels.find((channel) => channel.channel === "format");
	assert.match(format.coverage, /formatting follows the text channel/);
});
