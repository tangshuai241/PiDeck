import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Exercise the real generator in an isolated tree, including a Windows read/write file handle. */
test("prompt synchronization can overwrite a template without deleting an open destination", async () => {
	const root = mkdtempSync(join(tmpdir(), "tpa-prompt-copy-lock-"));
	const scripts = join(root, "scripts"),
		sources = join(root, "docs", "pi-prompt-templates"),
		output = join(root, "resources", "prompts");
	for (const dir of [scripts, sources, output]) mkdirSync(dir, { recursive: true });
	const script = join(scripts, "generate-content-manifests.mjs"),
		destination = join(output, "demo.md");
	writeFileSync(script, readFileSync("scripts/generate-content-manifests.mjs"));
	writeFileSync(join(sources, "demo.md"), "new template content\n");
	writeFileSync(destination, "previous template\n");
	let locker;
	let exited;
	try {
		if (process.platform === "win32") {
			const literal = destination.replaceAll("'", "''");
			const command = "$file = [System.IO.File]::Open('" + literal + "', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }";
			locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			exited = new Promise((resolve) => locker.once("exit", resolve));
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("file-lock setup timed out")), 10_000);
				locker.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				locker.stdout.on("data", (chunk) => {
					if (chunk.toString().includes("LOCKED")) {
						clearTimeout(timeout);
						resolve();
					}
				});
				locker.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error("file-lock helper exited: " + code));
				});
			});
		}
		execFileSync(process.execPath, [script, "--domain", "prompts"], { cwd: root, timeout: 10_000, stdio: "pipe" });
		assert.equal(readFileSync(destination, "utf8"), "new template content\n");
		const manifest = JSON.parse(readFileSync(join(output, "prompts-manifest.json"), "utf8"));
		assert.equal(manifest.fileCount, 1);
		assert.equal(manifest.files[0].name, "demo.md");
	} finally {
		if (locker) {
			locker.stdin.end("release\n");
			const timeout = setTimeout(() => locker.kill(), 3000);
			await exited;
			clearTimeout(timeout);
		}
		assert.ok(root.startsWith(join(tmpdir(), "tpa-prompt-copy-lock-")));
		rmSync(root, { recursive: true, force: true });
	}
});
