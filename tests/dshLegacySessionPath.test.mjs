import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 旧 DSH 会话原文件定位的兼容回归（DSH 运行时移除后仅保留只读路径推导）。
 * 事故背景（2026-10 审查 R1）：旧 Windows 宿主 + WSL 项目时，host 用宿主路径
 * `H:\project` 编码会话目录，项目侧 cwd 是 `/mnt/h/project`；只按项目 cwd 推导会
 * 得到 host 从未写过的目录，让「复制会话文件路径」指向不存在的文件。
 */
const { dshSessionFilePath, findDshSessionDir, workspaceDirFor } = loadTsCommonJs("src/main/sessions/dshLegacyPath.ts");

/** 按给定 workspace 编码路径造一个会话目录与日志文件；返回日志文件绝对路径。 */
function stageSession(home, workspacePath, sessionId, logName) {
	const dir = join(home, "sessions", workspaceDirFor(workspacePath), sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, logName), "synthetic legacy session fixture");
	return join(dir, logName);
}

function withTempHome(run) {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-legacy-"));
	try {
		run(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("WSL 项目按宿主路径编码的旧会话仍能定位到真实原文件", () => {
	withTempHome((home) => {
		const actual = stageSession(home, "H:\\project", "synthetic-wsl-session", "session.v3.jsonl.zstd");
		const resolved = dshSessionFilePath(home, "/mnt/h/project", "synthetic-wsl-session");
		assert.equal(resolved, actual, "cwd 编码失配时必须按 sessionId 兜底找到实际 generation 文件");
		assert.equal(existsSync(resolved), true, "复制会话文件路径必须指向真实存在的 host 日志");
		assert.equal(findDshSessionDir(home, "/mnt/h/project", "synthetic-wsl-session"), join(actual, ".."));
	});
});

test("cwd 与落盘编码一致时直接返回实际 generation 文件", () => {
	withTempHome((home) => {
		const dir = join(home, "sessions", workspaceDirFor("C:\\work\\project"), "session-direct");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.jsonl.zstd"), "v0");
		writeFileSync(join(dir, "session.v2.jsonl.zstd"), "v2");
		assert.equal(dshSessionFilePath(home, "C:\\work\\project", "session-direct"), join(dir, "session.v2.jsonl.zstd"));
	});
});

test("尚未落盘的会话返回确定性 v0 规范路径，不伪造已存在文件", () => {
	withTempHome((home) => {
		const resolved = dshSessionFilePath(home, "/mnt/h/project", "not-persisted");
		assert.equal(resolved, join(home, "sessions", workspaceDirFor("/mnt/h/project"), "not-persisted", "session.jsonl.zstd"));
		assert.equal(existsSync(resolved), false);
	});
});
