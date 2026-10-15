const { readdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const app = resolve(__dirname, "..");
const seen = new Set(); const entries = [];

/** Retain installed dependency license and NOTICE files verbatim in the APK. */
function visit(directory) {
	if (!existsSync(directory)) return;
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (!item.isDirectory() || item.name.startsWith(".")) continue;
		const folder = join(directory, item.name);
		if (item.name.startsWith("@")) { visit(folder); continue; }
		const file = join(folder, "package.json"); if (!existsSync(file)) continue;
		const pkg = JSON.parse(readFileSync(file, "utf8")); const identity = `${pkg.name}@${pkg.version}`;
		if (!seen.has(identity)) {
			seen.add(identity);
			const notices = readdirSync(folder).filter((name) => /^(licen[sc]e|notice|copying)(\.|$)/i.test(name));
			let text = `${identity}\nDeclared license: ${typeof pkg.license === "string" ? pkg.license : "See package notices"}\n`;
			for (const name of notices) { try { text += `\n${name}\n${readFileSync(join(folder, name), "utf8")}\n`; } catch { /* Directories with similar names contain no root notice file. */ } }
			entries.push(text);
		}
		visit(join(folder, "node_modules"));
	}
}
visit(join(app, "node_modules"));
visit(resolve(app, "../../packages/tpa-remote/node_modules"));
const own = readFileSync(resolve(app, "../../LICENSE"), "utf8");
const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
const text = `TPA 随身助理 ${version}\n\n${own}\n\nThird-party notices (including installed build dependencies)\n\n${entries.sort().join("\n\n")}`;
writeFileSync(join(app, "assets/third-party-notices.json"), JSON.stringify({ text }) + "\n");
process.stdout.write(`Retained ${entries.length} dependency notices (${Buffer.byteLength(text)} bytes)\n`);
