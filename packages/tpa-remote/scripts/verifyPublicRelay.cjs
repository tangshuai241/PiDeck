const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const nacl = require("tweetnacl");

/** Validate the deployed TLS route with synthetic ciphertext, without executing a TPA command. */
async function main() {
	const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, "TPACompanion-private/host-config.json"), "utf8"));
	const sockets = [];
	const timeout = setTimeout(() => { for (const socket of sockets) socket.terminate(); process.exitCode = 1; }, 15_000);
	try {
		const https = config.relay.replace(/^wss:/, "https:");
		const relay = await (await fetch(`${https}/health`, { signal: AbortSignal.timeout(8000) })).json();
		const workbench = await (await fetch("https://workbench.starveiled.cn/api/cloud/health", { signal: AbortSignal.timeout(8000) })).json();
		if (!relay.ok || !workbench.ok) throw new Error("HEALTH_FAILED");
		if (process.argv.includes("--prepare-unpaired-route")) {
			// A UI revocation intentionally invalidates the previous test token. This
			// explicit initial-setup option is forbidden once a desktop has provisioned.
			if (config.enabled || config.phone || existsSync(join(process.env.APPDATA, "PiDeck", "remote-companion.bin"))) throw new Error("DESKTOP_ALREADY_PROVISIONED");
			const rotated = await fetch(`${https}/${config.room}/route`, { method: "PUT", headers: { Authorization: `Bearer ${config.hostToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ phoneHash: createHash("sha256").update(config.phoneToken).digest("hex") }), signal: AbortSignal.timeout(8000) });
			if (!rotated.ok) throw new Error("ROUTE_UPDATE_FAILED");
		}
		const connect = (role, token) => { const socket = new WebSocket(`${config.relay}/${config.room}/${role}`, ["tpa-v1", token]); sockets.push(socket); return socket; };
		const rejected = connect("phone", "0".repeat(64)); const [error] = await once(rejected, "error");
		if (!/401/.test(error.message)) throw new Error("UNAUTHORIZED_NOT_REJECTED");
		const host = connect("host", config.hostToken); await once(host, "open");
		const phone = connect("phone", config.phoneToken); await once(phone, "open");
		const key = randomBytes(32); const nonce = randomBytes(24); const plaintext = Buffer.from("TPA synthetic encrypted transport check");
		const wire = JSON.stringify({ v: 1, nonce: nonce.toString("base64"), box: Buffer.from(nacl.secretbox(plaintext, nonce, key)).toString("base64") });
		const received = new Promise((done) => phone.on("message", (data) => { if (data.toString() === wire) done(data.toString()); }));
		host.send(wire); const packet = JSON.parse(await received);
		const decoded = nacl.secretbox.open(Buffer.from(packet.box, "base64"), Buffer.from(packet.nonce, "base64"), key);
		if (!decoded || !Buffer.from(decoded).equals(plaintext) || wire.includes(plaintext.toString())) throw new Error("CIPHERTEXT_FAILED");
		const report = { checkedAt: new Date().toISOString(), httpsHealth: true, workbenchHealth: true, rejectedUnknownCredential: true, authenticatedWssForwarding: true, ciphertextRoundTrip: true, modelCalls: 0, realTpaCommands: 0, realPhoneTests: 0 };
		writeFileSync(resolve(__dirname, "../../../../../output/TPA/relay-public-verification.json"), JSON.stringify(report, null, 2) + "\n");
		process.stdout.write(JSON.stringify(report) + "\n");
	} finally { clearTimeout(timeout); for (const socket of sockets) socket.terminate(); }
}
void main().catch(() => { process.stderr.write("Public relay verification failed\n"); process.exitCode = 1; });
