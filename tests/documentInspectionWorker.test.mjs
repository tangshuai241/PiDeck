/**
 * 程序检查：后台可终止 worker + 预算 + 未覆盖结构。
 *
 * 覆盖审查修正项 5：解析与比较必须在**可终止的 worker** 里跑，2 秒硬截止能真的
 * 打断（同步死循环也会被 terminate），未覆盖结构一律 unverified，同长度格式变化
 * 必须有真实哈希证据。这里用的是生产 worker 与生产 core（不是替身）。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { makeDocx, makeZip } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentInspectionService } = loadTsCommonJs("src/main/document-work/DocumentInspectionService.ts");
const { resolveInspectionWorkerPaths } = loadTsCommonJs("src/main/document-work/documentWorkAssembly.ts", { stubs: { electron: {}, "../ipc/documentWorkIpc": { registerDocumentWorkIpc: () => undefined } } });

const WORKER_DIR = join(process.cwd(), "resources", "document-work");
const WHOLE = { allow: [], preserve: [], wholeDocument: true };

function service(files, options = {}) {
	return new DocumentInspectionService({
		read: (path, maxBytes) => {
			const entry = files.get(path);
			if (entry === undefined) return undefined;
			return entry.byteLength > maxBytes ? undefined : entry;
		},
		resolveWorkerPaths: () => resolveInspectionWorkerPaths([WORKER_DIR]),
		timeoutMs: options.timeoutMs ?? 5000,
		...(options.testDelayMs === undefined ? {} : { testDelayMs: options.testDelayMs }),
	});
}

function channelsOf(inspection) {
	return Object.fromEntries(inspection.channels.map((channel) => [channel.channel, channel]));
}

test("生产 worker 可用，正文相同但 ZIP 字节不同时 text 通过、format 给出真实哈希证据", async () => {
	const files = new Map([
		["C:/base.docx", makeDocx([{ text: "Title", headingLevel: 1 }, { text: "body" }], { styles: "<w:styles><a/></w:styles>" })],
		["C:/next.docx", makeDocx([{ text: "Title", headingLevel: 1 }, { text: "body" }], { styles: "<w:styles><b/></w:styles>" })],
	]);
	const instance = service(files);
	const result = await instance.inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/next.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(result.ok, true);
	assert.equal(result.value.status, "passed");
	const channels = channelsOf(result.value);
	assert.equal(channels.text.status, "passed");
	assert.equal(channels.format.status, "passed");
	assert.match(channels.format.coverage, /documentFormatHash=[0-9a-f]{12}->[0-9a-f]{12}/, "格式通道必须给出双方的真实哈希");
	assert.match(channels.format.coverage, /changedParts=1/);
	assert.equal(instance.runningWorkers(), 0, "跑完必须回收 worker");
});

test("同长度、纯格式变化（加粗）能看见：text 通过但 format 报告逐块格式指纹变化", async () => {
	const base = makeDocx([{ text: "Section", headingLevel: 1 }, { text: "same length text" }]);
	const bold = makeDocx([
		{ text: "Section", headingLevel: 1 },
		{ text: "same length text", runs: "<w:rPr><w:b/></w:rPr>" },
	]);
	const files = new Map([
		["C:/base.docx", base],
		["C:/next.docx", bold],
	]);
	const result = await service(files).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/next.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	const channels = channelsOf(result.value);
	assert.equal(channels.text.status, "passed", "文字没变，正文通道必须通过");
	assert.match(channels.format.coverage, /formatOnlyBlocks=1/, "纯格式变化必须被格式通道的逐块指纹看见");
	assert.notEqual(channels.format.coverage.match(/documentFormatHash=(\w+)/)?.[1], undefined);
});

test("未覆盖结构一律 unverified：页眉页脚、编号、表格、修订、文本框、重复标题", async () => {
	const base = makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }]);
	const cases = {
		headerFooter: makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { parts: { "word/header1.xml": "<w:hdr><w:p><w:r><w:t>hdr</w:t></w:r></w:p></w:hdr>" } }),
		numbering: makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "item" }], { extraBody: '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>1.</w:t></w:r></w:p>' }),
		tables: makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { extraBody: "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" }),
		revisions: makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { extraBody: "<w:ins><w:r><w:t>added</w:t></w:r></w:ins>" }),
		textBoxes: makeDocx([{ text: "Alpha", headingLevel: 1 }, { text: "body" }], { extraBody: "<w:txbxContent>floating</w:txbxContent>" }),
		duplicateHeadings: makeDocx([
			{ text: "Alpha", headingLevel: 1 },
			{ text: "Alpha", headingLevel: 1 },
		]),
	};
	for (const [label, candidate] of Object.entries(cases)) {
		const files = new Map([
			["C:/base.docx", base],
			["C:/next.docx", candidate],
		]);
		const result = await service(files).inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/next.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
		assert.equal(result.value.status, "unverified", `${label} 必须记未验证`);
		assert.notEqual(result.value.status, "passed", `${label} 不得整体通过`);
	}
});

test("异常 ZIP / XML 实体 / 超预算 / 未知格式都记未验证，且不误报通过", async () => {
	const files = new Map([
		["C:/broken.docx", Buffer.from("not a zip at all", "utf8")],
		["C:/entity.docx", makeZip({ "word/document.xml": '<!DOCTYPE r [<!ENTITY x "boom">]><w:document><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>' })],
		["C:/doc.pdf", Buffer.from("%PDF-1.7", "utf8")],
		["C:/base.docx", makeDocx([{ text: "Alpha" }])],
	]);
	const instance = service(files);
	const broken = await instance.inspect({ candidate: { absolutePath: "C:/broken.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(broken.value.status, "unverified");
	const entity = await instance.inspect({ candidate: { absolutePath: "C:/entity.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	assert.equal(entity.value.status, "unverified");
	assert.match(entity.value.reason ?? "", /entities/);
	const pdf = await instance.inspect({ candidate: { absolutePath: "C:/doc.pdf", relativePath: "work/versions/v0002/a.pdf" }, scope: WHOLE });
	assert.equal(pdf.value.status, "unverified");
	const overBudget = await instance.inspect({ candidate: { absolutePath: "C:/doc.pdf", relativePath: "work/versions/v0002/a.pdf", existenceOnly: true }, scope: WHOLE });
	assert.equal(overBudget.value.status, "unverified");
	assert.match(overBudget.value.reason ?? "", /byte budget/);
});

test("2 秒硬截止真的 terminate：同步忙等也能被打断，并回收 worker", async () => {
	const files = new Map([
		["C:/base.docx", makeDocx([{ text: "Alpha" }])],
		["C:/next.docx", makeDocx([{ text: "Beta" }])],
	]);
	const instance = service(files, { timeoutMs: 150, testDelayMs: 3000 });
	const startedAt = Date.now();
	const result = await instance.inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/next.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	const elapsed = Date.now() - startedAt;
	assert.equal(result.value.status, "unverified");
	assert.match(result.value.reason ?? "", /did not finish within 150ms/);
	assert.ok(elapsed < 2500, `必须在超时附近返回而不是等忙等结束（实际 ${elapsed}ms）`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(instance.runningWorkers(), 0, "超时后 worker 必须已被终止");
});

test("shutdown 终止在跑的 worker（退出清理路径）", async () => {
	const files = new Map([
		["C:/base.docx", makeDocx([{ text: "Alpha" }])],
		["C:/next.docx", makeDocx([{ text: "Beta" }])],
	]);
	const instance = service(files, { timeoutMs: 5000, testDelayMs: 2000 });
	const pending = instance.inspect({ base: { absolutePath: "C:/base.docx", relativePath: "work/versions/v0001/a.docx" }, candidate: { absolutePath: "C:/next.docx", relativePath: "work/versions/v0002/a.docx" }, scope: WHOLE });
	await new Promise((resolve) => setTimeout(resolve, 80));
	await instance.shutdown();
	const result = await pending;
	assert.equal(result.value.status, "unverified");
	assert.equal(instance.runningWorkers(), 0);
});

test("worker 不可用时记未验证，不静默降级成主线程同步解析", async () => {
	const instance = new DocumentInspectionService({
		read: () => makeDocx([{ text: "Alpha" }]),
		resolveWorkerPaths: () => undefined,
	});
	const result = await instance.inspect({ candidate: { absolutePath: "C:/a.docx", relativePath: "work/versions/v0001/a.docx" }, scope: WHOLE });
	assert.equal(result.value.status, "unverified");
	assert.match(result.value.reason ?? "", /not available/);
});
