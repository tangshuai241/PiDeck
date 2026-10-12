/**
 * 成果归档的字节层：复制中变化、目标不覆盖、符号链接逃逸、超预算只留证据、
 * 失败保留原件与输入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryFs } from "./helpers/documentWorkFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DocumentArtifactStore } = loadTsCommonJs("src/main/document-work/DocumentArtifactStore.ts");
const { resolveWithinRoot, isInsideRoot } = loadTsCommonJs("src/main/document-work/DocumentPathGuard.ts");

function storeFor(fs) {
	return new DocumentArtifactStore({ fs, outputRootPath: "C:/out", snapshotRootPath: "C:/userData/snapshots", maxArtifactBytes: 1024 });
}

test("复制中源文件变化返回 BASE_CHANGED，不报告归档完成", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work"], files: { "C:/out/work/a.docx": "first" } });
	let reads = 0;
	const original = memory.fs.readFile;
	memory.fs.readFile = (path) => {
		reads++;
		// 第 3 次读取（复制后的复查）看到不同字节，模拟复制过程中被改写。
		if (String(path).endsWith("a.docx") && reads >= 3) return Buffer.from("mutated", "utf8");
		return original(path);
	};
	const store = storeFor(memory.fs);
	const result = store.copyVerified({ sourceAbsolutePath: "C:/out/work/a.docx", destinationAbsolutePath: "C:/out/work/versions/v0001/a.docx" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_CHANGED");
});

test("期望指纹不符时拒绝归档（复制前就发现源已变）", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work"], files: { "C:/out/work/a.docx": "content" } });
	const store = storeFor(memory.fs);
	const result = store.copyVerified({ sourceAbsolutePath: "C:/out/work/a.docx", destinationAbsolutePath: "C:/out/work/versions/v0001/a.docx", expectedSha256: "b".repeat(64) });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "BASE_CHANGED");
});

test("版本目录排他创建：目标已存在就换下一个序号，绝不覆盖", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work/versions/v0001"] });
	const store = storeFor(memory.fs);
	const first = store.allocateVersionDir("work", 1);
	assert.equal(first.ok, true);
	assert.equal(first.value.ordinal, 2, "v0001 已存在时必须让位");
	assert.equal(first.value.relativeDir, "work/versions/v0002");
	const second = store.allocateVersionDir("work", 1);
	assert.equal(second.value.ordinal, 3);
});

test("保留目标文件检查：同版本目录里已有同名文件时拒绝写入", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work/versions/v0001"], files: { "C:/out/work/versions/v0001/a.docx": "old" } });
	const store = storeFor(memory.fs);
	const reserved = store.reserveDestination("C:/out/work/versions/v0001", "a.docx");
	assert.equal(reserved.ok, false);
	assert.match(reserved.error.detail ?? "", /refusing to overwrite/);
});

test("junction/符号链接逃逸被真实路径校验挡住", () => {
	const memory = createMemoryFs({
		dirs: ["C:/out"],
		files: { "C:/outside/secret.docx": "outside" },
		links: { "C:/out/work": "C:/outside" },
	});
	// 目标路径"看起来"在成果根内，但真实路径指向根外。
	const escaped = resolveWithinRoot(memory.fs, "C:/out", "work/secret.docx");
	assert.equal(escaped.ok, false);
	assert.equal(escaped.error.code, "PATH_DENIED");
	// 上层包含判定本身也要对（防止被别处误用）。
	assert.equal(isInsideRoot("C:/out", "C:/outside"), false);
	assert.equal(isInsideRoot("C:/out", "C:/out/work"), true);
});

test("超预算文件只登记存在证据，不复制字节", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work"], files: { "C:/out/work/huge.docx": "x".repeat(2048) } });
	const store = new DocumentArtifactStore({ fs: memory.fs, outputRootPath: "C:/out", snapshotRootPath: "C:/userData/snapshots", maxArtifactBytes: 1024 });
	const evidence = store.evidence("C:/out/work/huge.docx", "work/staging/p1/huge.docx");
	assert.equal(evidence.ok, true);
	assert.equal(evidence.value.existenceOnly, true);
	assert.equal(evidence.value.bytes, 2048);
});

test("写入失败保留源文件与 staging，也不留下半截版本文件", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work/staging/p1"], files: { "C:/out/work/staging/p1/a.docx": "content" } });
	memory.faults.copyFailures.add("C:/out/work/versions/v0001/a.docx");
	const store = storeFor(memory.fs);
	const result = store.copyVerified({ sourceAbsolutePath: "C:/out/work/staging/p1/a.docx", destinationAbsolutePath: "C:/out/work/versions/v0001/a.docx" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "IO_ERROR");
	assert.equal(memory.fs.exists("C:/out/work/staging/p1/a.docx"), true, "输入保留");
	assert.equal(memory.fs.exists("C:/out/work/versions/v0001/a.docx"), false, "不留下半截目标");
});

test("原始字节快照写到 TPA 管理目录，复制前后指纹一致", () => {
	const memory = createMemoryFs({ dirs: ["C:/out/work/versions/v0001", "C:/userData/snapshots/work"], files: { "C:/out/work/versions/v0001/a.docx": "archived" } });
	const store = storeFor(memory.fs);
	const snapshot = store.snapshot("work", "v0001", "C:/out/work/versions/v0001/a.docx", "a.docx");
	assert.equal(snapshot.ok, true);
	assert.equal(snapshot.value.relativePath, "work/snapshots/v0001/a.docx");
	assert.equal(memory.fs.readFile("C:/userData/snapshots/work/snapshots/v0001/a.docx").toString("utf8"), "archived");
});

test("路径校验：不安全相对路径直接拒绝，不做'尽量修好'", () => {
	const memory = createMemoryFs({ dirs: ["C:/out"] });
	for (const candidate of ["../escape.docx", "/abs.docx", "a/../../b.docx", "a\\b.docx", ""]) {
		const resolved = resolveWithinRoot(memory.fs, "C:/out", candidate);
		assert.equal(resolved.ok, false, candidate);
	}
});
