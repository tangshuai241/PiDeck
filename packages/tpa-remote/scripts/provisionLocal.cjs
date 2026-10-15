const { randomBytes, createHash } = require("node:crypto");
const { mkdirSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const nacl = require("tweetnacl");

/** Keep private provisioning outside the repository and every distributable artifact. */
function main() {
	if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw new Error("WINDOWS_PRIVATE_PROFILE_REQUIRED");
	const directory = join(process.env.LOCALAPPDATA, "TPACompanion-private");
	mkdirSync(directory, { recursive: true });
	execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" });
	const hostFile = join(directory, "host-config.json"); const relayFile = join(directory, "relay-config.json");
	if (existsSync(hostFile) || existsSync(relayFile)) { process.stdout.write("Existing private provisioning preserved\n"); return; }
	const pair = nacl.box.keyPair.fromSecretKey(randomBytes(32)); const room = randomBytes(16).toString("hex");
	const hostToken = randomBytes(32).toString("hex"); const phoneToken = randomBytes(32).toString("hex");
	const host = { version: 1, enabled: false, relay: "wss://workbench.starveiled.cn/tpa-relay/v1", room, hostToken, phoneToken, hostPublicKey: Buffer.from(pair.publicKey).toString("base64"), hostSecretKey: Buffer.from(pair.secretKey).toString("base64") };
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	writeFileSync(hostFile, JSON.stringify(host), { flag: "wx", mode: 0o600 });
	writeFileSync(relayFile, JSON.stringify({ bind: "172.18.0.1", port: 4791, rooms: [{ id: room, hostHash: hash(hostToken), phoneHash: hash(phoneToken) }] }), { flag: "wx", mode: 0o600 });
	process.stdout.write("Private provisioning created with user-only permissions; remote access remains disabled\n");
}
try { main(); } catch { process.stderr.write("Private provisioning failed\n"); process.exitCode = 1; }
