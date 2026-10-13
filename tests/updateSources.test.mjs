import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
/**
 * updateSources 更新源（GitHub 官方 + 镜像代理 + 自定义）纯函数单测。
 * 守护 URL 拼接、枚举归一化与自定义前缀校验规则；镜像清单与主进程 feedUrl
 * 生成共用一个 shared 源，此处同时验证两端入口一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 用 TypeScript transpileModule 加载 TS 源码（项目测试惯例，见 updateServiceE2E.test.mjs）。 */
function loadTsModule(filePath, deps) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (name) =>
				deps[name] ??
				(() => {
					throw new Error(`unexpected require: ${name}`);
				})(),
			console,
			URL, // vm 沙箱默认无 URL 全局，normalizeCustomMirrorHost 依赖它校验协议
		},
		{ filename: filePath },
	);
	return module.exports;
}

// shared/updateSources.ts 无 import，直接加载；main/update/updateSources.ts 依赖它。
const shared = loadTsModule("src/shared/updateSources.ts", {});
const mainModule = loadTsModule("src/main/update/updateSources.ts", {
	"../../shared/updateSources": shared,
	"../../shared/types/settings": { UpdateSourceId: undefined }, // 仅类型导入，运行时无碍
});

const { normalizeUpdateSource, updateSourceFeedUrl, updateSourceLatestReleaseUrl } = mainModule;
const { gitHubLatestDownloadBase, atomGitFeedUrl, atomGitLatestReleaseApiUrl, normalizeCustomMirrorHost } = shared;

test("normalizeUpdateSource: 已知 id 原样保留", () => {
	assert.equal(normalizeUpdateSource("atomgit"), "atomgit");
	assert.equal(normalizeUpdateSource("github"), "github");
});

test("normalizeUpdateSource: 未知/非字符串回退 atomgit（默认首选）", () => {
	assert.equal(normalizeUpdateSource("ghfast"), "atomgit");
	assert.equal(normalizeUpdateSource("custom"), "atomgit");
	assert.equal(normalizeUpdateSource("hacked-source"), "atomgit");
	assert.equal(normalizeUpdateSource(undefined), "atomgit");
	assert.equal(normalizeUpdateSource(null), "atomgit");
	assert.equal(normalizeUpdateSource(42), "atomgit");
	assert.equal(normalizeUpdateSource(""), "atomgit");
});

test("updateSourceFeedUrl: github 源返回 null（走内置 app-update.yml 通道）", () => {
	assert.equal(updateSourceFeedUrl("github", null), null);
	assert.equal(updateSourceFeedUrl("github", "https://custom.example.com"), null);
});

test("updateSourceFeedUrl: 应用不使用上游 AtomGit 安装包；运行时资源仍可用原镜像", () => {
	assert.equal(updateSourceFeedUrl("atomgit"), null);
	assert.equal(atomGitFeedUrl(), "https://atomgit.com/ayuayue/PiDeck/releases/download/latest");
	assert.equal(gitHubLatestDownloadBase(), "https://github.com/ayuayue/PiDeck/releases/latest/download");
});

test("updateSourceLatestReleaseUrl: macOS 应用检查使用 fork，资源镜像仍独立保留", () => {
	assert.equal(updateSourceLatestReleaseUrl("atomgit"), null);
	assert.equal(atomGitLatestReleaseApiUrl(), "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest");
	assert.equal(updateSourceLatestReleaseUrl("github"), null);
});

test("normalizeCustomMirrorHost: trim/去尾斜杠/协议校验", () => {
	assert.equal(normalizeCustomMirrorHost("  https://a.com  "), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("https://a.com///"), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("https://a.com"), "https://a.com");
	assert.equal(normalizeCustomMirrorHost("http://a.com"), "http://a.com");
	assert.equal(normalizeCustomMirrorHost("a.com"), null); // 缺协议
	assert.equal(normalizeCustomMirrorHost("ftp://a.com"), null); // 非 http(s)
	assert.equal(normalizeCustomMirrorHost(""), null);
	assert.equal(normalizeCustomMirrorHost("   "), null);
	assert.equal(normalizeCustomMirrorHost(null), null);
	assert.equal(normalizeCustomMirrorHost(undefined), null);
});

test("application publish metadata and update fallback point to the user's fork", () => {
	const { UPDATE_REPO_OWNER, UPDATE_REPO, RELEASES_URL } = loadTsCommonJs("src/main/update/releaseRepo.ts");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(UPDATE_REPO_OWNER, "tangshuai241");
	assert.equal(UPDATE_REPO, "PiDeck");
	assert.equal(RELEASES_URL, "https://github.com/tangshuai241/PiDeck/releases");
	assert.equal(pkg.build.publish.owner, UPDATE_REPO_OWNER);
	assert.equal(pkg.build.publish.repo, UPDATE_REPO);
});
