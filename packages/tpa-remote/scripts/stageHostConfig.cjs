const { existsSync, copyFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

/** Stage a disabled one-time inbox for the packaged desktop; preserve every existing setting. */
function main() {
	if (process.platform !== "win32" || !process.env.APPDATA || !process.env.LOCALAPPDATA) throw new Error("WINDOWS_PROFILE_REQUIRED");
	const directory = join(process.env.APPDATA, "PiDeck");
	const source = join(process.env.LOCALAPPDATA, "TPACompanion-private", "host-config.json");
	const settings = join(directory, "remote-companion.bin"); const inbox = `${settings}.provision.json`;
	if (!existsSync(join(directory, "session-catalog.json"))) throw new Error("DESKTOP_PROFILE_NOT_FOUND");
	if (existsSync(settings) || existsSync(inbox)) { process.stdout.write("Existing desktop provisioning preserved\n"); return; }
	const config = JSON.parse(readFileSync(source, "utf8")); if (config.enabled !== false || config.phone || config.invite) throw new Error("DISABLED_PROVISIONING_REQUIRED");
	copyFileSync(source, inbox);
	execFileSync("icacls.exe", [inbox, "/inheritance:r", "/grant:r", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: "ignore" });
	process.stdout.write("Disabled one-time inbox staged for the existing packaged desktop profile\n");
}
try { main(); } catch { process.stderr.write("Desktop provisioning staging failed\n"); process.exitCode = 1; }
