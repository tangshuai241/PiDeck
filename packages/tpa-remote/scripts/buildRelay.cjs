const { createRequire } = require("node:module");
const { resolve, join } = require("node:path");
const { readFileSync, writeFileSync, mkdirSync, copyFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const root = resolve(__dirname, "../../..");
const rootRequire = createRequire(join(root, "package.json"));
const output = resolve(process.argv[2] || join(root, "../../output/TPA/relay-0.1.0"));

/** Produce a self-contained immutable relay release; private configuration is separate. */
async function main() {
	mkdirSync(output, { recursive: true });
	await rootRequire("esbuild").build({ entryPoints: [join(__dirname, "../src/relayMain.ts")], outfile: join(output, "relay.cjs"), bundle: true, platform: "node", target: "node22", format: "cjs", minify: false, legalComments: "eof", external: ["bufferutil", "utf-8-validate"] });
	copyFileSync(join(root, "LICENSE"), join(output, "LICENSE"));
	let notices = "TPA Remote relay third-party notices\n\n";
	for (const [name, license] of [["ws", "LICENSE"], ["tweetnacl", "LICENSE"], ["base64-js", "LICENSE"]]) {
		const packagePath = require.resolve(`${name}/package.json`, { paths: [join(__dirname, "..")] });
		const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
		notices += `${name} ${pkg.version} (${pkg.license})\n${readFileSync(join(packagePath, "..", license), "utf8")}\n\n`;
	}
	writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), notices);
	const files = Object.fromEntries(["relay.cjs", "LICENSE", "THIRD_PARTY_NOTICES.txt"].map((name) => [name, createHash("sha256").update(readFileSync(join(output, name))).digest("hex")]));
	writeFileSync(join(output, "manifest.json"), JSON.stringify({ version: "0.1.0", node: ">=22", files }, null, 2) + "\n");
	process.stdout.write(`Built immutable relay with ${Object.keys(files).length} verified files\n`);
}
void main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
