import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = {
		exports: {},
		require: (specifier) => {
			// 本模块只有类型导入，编译后应无运行时 require；出现即测试装载失败。
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/sessionManagerModel.ts"), sandbox, {
		filename: "sessionManagerModel.ts",
	});
	return sandbox.exports;
}

function summary(overrides) {
	return {
		id: overrides.id ?? overrides.filePath ?? "s1",
		filePath: overrides.filePath ?? "",
		name: overrides.name ?? "t",
		preview: "",
		updatedAt: overrides.updatedAt ?? 1,
		messageCount: 1,
		source: overrides.source ?? "pi",
		...overrides,
	};
}

function project(id, path, worktreeParentId) {
	return { id, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, path, ...(worktreeParentId ? { worktreeParentId } : {}) };
}

const {
	isManagerSessionSummary,
	sessionManagerRowKey,
	mergeManagerArchived,
	managerArchivedDshLabel,
	managerArchivedRowKey,
	worktreeFamilyProjects,
	familyRootProject,
	sessionWorkspaceLabel,
	canonicalWorkspacePath,
	filterArchivedPiByFamily,
	filterArchivedDshByFamily,
	archivedPiWorkspaceLabel,
	archivedDshWorkspaceLabel,
} = loadModule();

test("isManagerSessionSummary: DSH 有 host id 才收录；草稿不收录", () => {
	assert.equal(isManagerSessionSummary(summary({ filePath: "a.jsonl", backend: "pi" })), true);
	assert.equal(isManagerSessionSummary(summary({ filePath: "", backend: "pi" })), false);
	assert.equal(isManagerSessionSummary(summary({ backend: "dsh", dshSessionId: "session-x" })), true);
	assert.equal(isManagerSessionSummary(summary({ backend: "dsh" })), false);
});

test("sessionManagerRowKey: 用稳定记录 id，空 filePath 的 DSH 行不冲突", () => {
	assert.equal(sessionManagerRowKey(summary({ id: "uuid-1", filePath: "" })), "uuid-1");
	assert.equal(sessionManagerRowKey(summary({ id: "uuid-2", filePath: "b.jsonl" })), "uuid-2");
});

test("mergeManagerArchived: 空列表返回空数组", () => {
	assert.equal(mergeManagerArchived([], []).length, 0);
});

test("worktreeFamilyProjects: 根项目 = 自己 + 全部子工作区", () => {
	const projects = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root"), project("wt-b", "C:/work/repo-wt-b", "root"), project("other", "D:/other")];
	const family = worktreeFamilyProjects(projects, "root");
	assert.equal(family.map((p) => p.id).join(","), "root,wt-a,wt-b");
	assert.equal(familyRootProject(family).id, "root");
});

test("worktreeFamilyProjects: 从 worktree 子项目打开同样聚合整个家族", () => {
	const projects = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root"), project("wt-b", "C:/work/repo-wt-b", "root")];
	const family = worktreeFamilyProjects(projects, "wt-b");
	assert.equal(family.map((p) => p.id).join(","), "root,wt-a,wt-b");
});

test("worktreeFamilyProjects: 无 worktree 的项目只含自己；未知 id 返回空", () => {
	assert.equal(worktreeFamilyProjects([project("p1", "C:/work/a")], "p1").length, 1);
	assert.equal(worktreeFamilyProjects([project("p1", "C:/work/a")], "missing").length, 0);
});

test("sessionWorkspaceLabel: 主工作区不标记，worktree 显示目录名", () => {
	const family = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root")];
	assert.equal(sessionWorkspaceLabel("root", family), undefined);
	assert.equal(sessionWorkspaceLabel("wt-a", family), "repo-wt-a");
	assert.equal(sessionWorkspaceLabel("unknown", family), undefined);
	assert.equal(sessionWorkspaceLabel(undefined, family), undefined);
});

test("canonicalWorkspacePath: 统一分隔符；native 大小写不敏感，WSL 敏感", () => {
	assert.equal(canonicalWorkspacePath("C:\\Work\\A\\", false), "c:/work/a");
	assert.equal(canonicalWorkspacePath("c:/work/a", false), "c:/work/a");
	assert.equal(canonicalWorkspacePath("/home/Work/A/", true), "/home/Work/A");
	assert.equal(canonicalWorkspacePath("/home/Work/A", true), "/home/Work/A");
});

// ── 归档按家族过滤 ─────────────────────────────────────────────────────────

test("filterArchivedPiByFamily: 按 JSONL cwd 归属；默认 Pi 存储路径、跨家族与无 cwd 不进", () => {
	const family = [project("root", "C:/work/my-project"), project("wt-a", "C:/work/my-project-wt-a", "root")];
	const items = [
		// 默认 Pi 布局在用户目录中；编码目录不应参与项目归属判定。
		{ summary: summary({ id: "p1", wsl: false, projectPath: "C:/work/my-project" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-my-project--/a.jsonl" },
		{ summary: summary({ id: "p2", wsl: false, projectPath: "C:/work/my-project-wt-a" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-my-project-wt-a--/b.jsonl" },
		{ summary: summary({ id: "p3", wsl: false, projectPath: "D:/other" }), originalPath: "C:/Users/u/.pi/agent/sessions/--D--other--/c.jsonl" },
		{ summary: summary({ id: "p4", wsl: false }), originalPath: "C:/work/my-project/.pi/sessions/d.jsonl" }, // 缺少 cwd 时不猜测编码/文件路径
		{ summary: summary({ id: "p5", wsl: false, projectPath: "C:/work/my-project" }) }, // 索引缺失，无法恢复
	];
	const kept = filterArchivedPiByFamily(items, family);
	assert.equal(kept.map((item) => item.summary.id).join(","), "p1,p2");
});

test("filterArchivedPiByFamily: 路径边界不误中（C:/a 不中 C:/ab）", () => {
	const family = [project("root", "C:/work/a")];
	const items = [
		{ summary: summary({ id: "inside", projectPath: "C:/work/a/subdir" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-a-subdir--/x.jsonl" },
		{ summary: summary({ id: "outside", projectPath: "C:/work/ab" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-ab--/x.jsonl" },
	];
	const kept = filterArchivedPiByFamily(items, family);
	assert.equal(kept.map((item) => item.summary.id).join(","), "inside");
});

test("filterArchivedPiByFamily: WSL cwd 按路径形态识别且大小写敏感", () => {
	const family = [project("root", "/home/dev/Work")];
	const items = [
		{ summary: summary({ id: "inside", projectPath: "/home/dev/Work/subdir" }), originalPath: "/home/dev/.pi/agent/sessions/--home-dev-Work-subdir--/x.jsonl" },
		{ summary: summary({ id: "different-case", projectPath: "/home/dev/work" }), originalPath: "/home/dev/.pi/agent/sessions/--home-dev-work--/y.jsonl" },
	];
	const kept = filterArchivedPiByFamily(items, family);
	assert.equal(kept.map((item) => item.summary.id).join(","), "inside");
});

test("filterArchivedDshByFamily: cwd 精确匹配家族成员路径", () => {
	const family = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root")];
	const items = [
		{ dshSessionId: "s1", cwd: "C:/work/repo", archivedAt: 1 },
		{ dshSessionId: "s2", cwd: "C:/work/repo-wt-a", archivedAt: 2 },
		{ dshSessionId: "s3", cwd: "D:/other", archivedAt: 3 },
	];
	const kept = filterArchivedDshByFamily(items, family);
	assert.equal(kept.map((item) => item.dshSessionId).join(","), "s1,s2");
});

// ── 归档行工作区标签 ───────────────────────────────────────────────────────

test("archivedPiWorkspaceLabel: 主工作区不标记，worktree 显示目录名", () => {
	const family = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root")];
	assert.equal(archivedPiWorkspaceLabel({ summary: summary({ id: "p1", projectPath: "C:/work/repo" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-repo--/a.jsonl" }, family), undefined);
	assert.equal(archivedPiWorkspaceLabel({ summary: summary({ id: "p2", projectPath: "C:/work/repo-wt-a" }), originalPath: "C:/Users/u/.pi/agent/sessions/--C--work-repo-wt-a--/b.jsonl" }, family), "repo-wt-a");
});

test("archivedDshWorkspaceLabel: 同上（cwd 归属）", () => {
	const family = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root")];
	assert.equal(archivedDshWorkspaceLabel({ dshSessionId: "s1", cwd: "C:/work/repo", archivedAt: 1 }, family), undefined);
	assert.equal(archivedDshWorkspaceLabel({ dshSessionId: "s2", cwd: "C:/work/repo-wt-a", archivedAt: 1 }, family), "repo-wt-a");
});
