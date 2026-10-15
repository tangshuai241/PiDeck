import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../scripts/install-git-hooks.mjs", import.meta.url));

/** A temporary repository proves installation policy without contacting any remote. */
function installInFixture(enable, skip = "") {
	const cwd = mkdtempSync(join(tmpdir(), "tpa-hook-policy-"));
	const env = { ...process.env, PI_DECK_ENABLE_ATOMGIT: enable, PI_DECK_SKIP_ATOMGIT: skip, GIT_TERMINAL_PROMPT: "0" };
	function run(command, args) {
		const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 15_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}
	try {
		run("git", ["init", "--quiet"]);
		mkdirSync(join(cwd, ".githooks"));
		writeFileSync(join(cwd, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n");
		run(process.execPath, [installer, "--strict"]);
		return { remotes: run("git", ["remote"]), hooksPath: run("git", ["config", "--local", "--get", "core.hooksPath"]) };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("installing TPA hooks does not silently register the original author's mirror", () => {
	const result = installInFixture("");
	assert.equal(result.hooksPath, ".githooks");
	assert.equal(result.remotes, "");
});

test("mirror registration requires explicit opt-in and the skip switch wins", () => {
	assert.equal(installInFixture("1").remotes, "atomgit");
	assert.equal(installInFixture("1", "1").remotes, "");
});
