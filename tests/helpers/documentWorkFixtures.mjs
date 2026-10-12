/**
 * 文稿域测试夹具：内存文件系统、假运行时端口、合成文稿与合成 OOXML。
 *
 * 三条约定（与仓库测试标准一致）：
 * - 不依赖真实网络/模型/Electron/Pi 进程：运行时端口全是注入的假实现；
 * - 文件行为用内存 fs 模拟（含符号链接），需要真实字节时再用临时目录；
 * - 夹具构造完整对象（不用 `as` 强转绕过类型），生产类型变化会在这里红灯。
 *
 * 身份约定：稳定会话 id（catalog）与原生 Pi 会话 id 默认**不同**，
 * 因为真实新草稿就是这样；任何"两者相等才通过"的实现都会在这里暴露。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STABLE_SESSION = "session_17afa0c2";
export const NATIVE_SESSION = "pi-native-9c41-4d0b";
export const WORK_ID = "work_1";
export const ATTEMPT_ID = "attempt_1";
export const PREPARATION_ID = "prep_1";
export const DIGEST = "digest-1";

/** 内存文件系统：支持目录、文件、符号链接；`faults` 用来注入写入/复制失败。 */
export function createMemoryFs(seed = {}) {
	const files = new Map();
	const dirs = new Set(["/"]);
	const links = new Map();
	const faults = { writeFailures: new Set(), copyFailures: new Set(), renameFailures: new Set(), exclusiveFailures: new Set() };
	const normalize = (path) =>
		path
			.replace(/\\/g, "/")
			.replace(/\/{2,}/g, "/")
			.replace(/\/$/, "") || "/";

	function parentOf(path) {
		const normalized = normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	function ensureParents(path) {
		const parent = parentOf(path);
		if (parent === "/" || dirs.has(parent)) return;
		ensureParents(parent);
		dirs.add(parent);
	}

	const fs = {
		realpath: (path) => {
			const normalized = normalize(path);
			const target = links.get(normalized);
			if (target) return fs.realpath(target);
			if (!dirs.has(normalized) && !files.has(normalized)) throw new Error(`ENOENT: ${normalized}`);
			return normalized;
		},
		stat: (path) => {
			const normalized = normalize(path);
			const linked = links.get(normalized);
			if (linked) return fs.stat(linked);
			if (files.has(normalized)) {
				const data = files.get(normalized);
				return { isFile: () => true, isDirectory: () => false, size: data.byteLength ?? data.length ?? 0, mtimeMs: 0 };
			}
			if (dirs.has(normalized)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
			return undefined;
		},
		readFile: (path) => {
			const normalized = normalize(path);
			const linked = links.get(normalized);
			if (linked) return fs.readFile(linked);
			return files.get(normalized);
		},
		exists: (path) => {
			const normalized = normalize(path);
			if (links.has(normalized)) return fs.exists(links.get(normalized));
			return files.has(normalized) || dirs.has(normalized);
		},
		mkdirExclusive: (path) => {
			const normalized = normalize(path);
			if (faults.exclusiveFailures.has(normalized)) return false;
			if (dirs.has(normalized) || files.has(normalized)) return false;
			ensureParents(normalized);
			dirs.add(normalized);
			return true;
		},
		mkdirRecursive: (path) => {
			const normalized = normalize(path);
			ensureParents(normalized);
			dirs.add(normalized);
		},
		copyFile: (source, destination) => {
			const from = normalize(source);
			const to = normalize(destination);
			if (faults.copyFailures.has(to)) throw new Error(`EACCES: ${to}`);
			const data = fs.readFile(from);
			if (data === undefined) throw new Error(`ENOENT: ${from}`);
			ensureParents(to);
			files.set(to, Buffer.from(data));
		},
		remove: (path) => {
			const normalized = normalize(path);
			files.delete(normalized);
			dirs.delete(normalized);
		},
		writeFile: (path, data) => {
			const normalized = normalize(path);
			if (faults.writeFailures.has(normalized)) throw new Error(`EACCES: ${normalized}`);
			ensureParents(normalized);
			files.set(normalized, Buffer.from(data));
		},
		listDir: (path) => {
			const normalized = normalize(path);
			const prefix = normalized === "/" ? "/" : `${normalized}/`;
			const names = new Set();
			for (const key of [...files.keys(), ...dirs.keys()]) {
				if (!key.startsWith(prefix) || key === normalized) continue;
				const rest = key.slice(prefix.length);
				names.add(rest.split("/")[0]);
			}
			return [...names];
		},
	};

	for (const [path, value] of Object.entries(seed.files ?? {})) fs.writeFile(path, Buffer.from(value, "utf8"));
	for (const path of seed.dirs ?? []) fs.mkdirRecursive(path);
	for (const [path, target] of Object.entries(seed.links ?? {})) links.set(normalize(path), normalize(target));

	return { fs, files, dirs, links, faults, write: (path, value) => fs.writeFile(path, Buffer.from(value, "utf8")) };
}

/** 假工作存储：可注入写入失败，用来验证原子写入与恢复。 */
export function createMemoryWorkFs(faults = {}) {
	const files = new Map();
	const failure = { write: faults.write ?? new Set(), rename: faults.rename ?? new Set() };
	// 与内存 path fs 同一套分隔符归一化：Windows 上 join 产生反斜杠，直接当 Map 键会
	// 让"同一个文件"有两个键，测试与故障注入都会对不上。
	const normalize = (path) =>
		path
			.replace(/\\/g, "/")
			.replace(/\/{2,}/g, "/")
			.replace(/\/$/, "") || "/";
	return {
		files,
		faults: failure,
		readFile: (path) => files.get(normalize(path))?.toString("utf8"),
		writeFile: (path, content) => {
			const key = normalize(path);
			if (failure.write.has(key)) throw new Error(`EACCES: ${key}`);
			files.set(key, Buffer.from(content, "utf8"));
		},
		rename: (from, to) => {
			const source = normalize(from);
			const target = normalize(to);
			if (failure.rename.has(source) || failure.rename.has(target)) throw new Error(`EPERM: ${source} -> ${target}`);
			const content = files.get(source);
			if (content === undefined) throw new Error(`ENOENT: ${source}`);
			files.set(target, content);
			files.delete(source);
		},
		removeFile: (path) => {
			files.delete(normalize(path));
		},
		exists: (path) => files.has(normalize(path)),
		mkdirp: () => undefined,
	};
}

export function createTempDir(prefix = "pideck-document-work-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 假运行时端口：记录所有调用，便于断言"未知分发不再调用 RPC"。
 *
 * `target` 默认带 `piSessionId`（原生身份）与 `projectRoot`；两者都是真实装配会提供的。
 */
export function createFakeRuntime(options = {}) {
	const calls = [];
	const history = options.history ?? { bindings: [], reports: [], intents: [] };
	const target = options.target ?? { sessionId: STABLE_SESSION, agentId: "agent-1", runtimeGeneration: 1, piSessionId: NATIVE_SESSION, projectRoot: "C:/project" };
	const port = {
		async resolveRuntime(sessionId) {
			calls.push({ kind: "resolveRuntime", sessionId });
			// 返回副本：真实协调器每次给新的快照对象，服务侧必须靠字段比较而不是对象身份。
			if (options.target === null || sessionId !== target.sessionId) return undefined;
			return { ...target };
		},
		readRuntimeBinding(agentId) {
			return options.target === null || agentId !== target.agentId ? undefined : { sessionId: target.sessionId, runtimeGeneration: target.runtimeGeneration };
		},
		async readAlignment() {
			calls.push({ kind: "readAlignment" });
			return options.alignment;
		},
		async readUserTurn(input) {
			calls.push({ kind: "readUserTurn", turnId: input.turnId });
			return options.turns?.[input.turnId];
		},
		async runtimeFlags() {
			return { busy: options.busy === true, queued: options.queued === true };
		},
		async sendControl(input) {
			calls.push({ kind: "sendControl", message: input.message, requestId: input.requestId });
			return options.rejectSend ? { accepted: false, error: "busy" } : { accepted: true };
		},
		async abort() {
			calls.push({ kind: "abort" });
		},
		async readHistory() {
			return history;
		},
	};
	return { calls, history, target, port };
}

/** 假事件源：手动投递 pi 事件，模拟 message_end / agent_end / agent_settled。 */
export function createFakeEventSource() {
	const listeners = new Set();
	const settled = new Set();
	return {
		source: {
			addLocalEventListener(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onAgentSettled(listener) {
				settled.add(listener);
				return () => settled.delete(listener);
			},
		},
		emit(agentId, event) {
			for (const listener of [...listeners]) listener(agentId, event);
		},
		settle(agentId, title = "session") {
			for (const listener of [...settled]) listener({ agentId, title });
		},
		listenerCount: () => listeners.size + settled.size,
	};
}

export function bindingState(overrides = {}) {
	return {
		schemaVersion: 1,
		sessionId: STABLE_SESSION,
		nativeSessionId: NATIVE_SESSION,
		workId: WORK_ID,
		attemptId: ATTEMPT_ID,
		preparationId: PREPARATION_ID,
		digest: DIGEST,
		phase: "bound",
		...overrides,
	};
}

export function documentWorkStateMessage(state, report, message = {}) {
	return {
		role: "custom",
		customType: "tpa-document-work-state",
		display: false,
		details: { documentWork: state, ...(report ? { report } : {}) },
		...message,
	};
}

export function revisionIntentMessage(intent) {
	return { role: "custom", customType: "tpa-document-work-intent", display: false, details: { intent } };
}

export function revisionIntent(overrides = {}) {
	return {
		schemaVersion: 1,
		sessionId: STABLE_SESSION,
		nativeSessionId: NATIVE_SESSION,
		workId: WORK_ID,
		sourceTurnId: "turn_1",
		instructionDigest: "0".repeat(64),
		summary: "please rewrite section two",
		...overrides,
	};
}

/** 一轮用户消息的权威快照（默认是最新用户轮次）。 */
export function userTurn(text, overrides = {}) {
	const digest = createHashHex(text.trim());
	return { entryId: "turn_1", role: "user", text, textDigest: digest, isLatestUserTurn: true, ...overrides };
}

export function candidateReport(overrides = {}) {
	return {
		schemaVersion: 1,
		workId: WORK_ID,
		attemptId: ATTEMPT_ID,
		preparationId: PREPARATION_ID,
		digest: DIGEST,
		reportId: "report_1",
		artifacts: [`${WORK_ID}/staging/${PREPARATION_ID}/deliverable.docx`],
		editableSources: [`${WORK_ID}/staging/${PREPARATION_ID}/source.md`],
		summary: "first draft",
		risks: [],
		...overrides,
	};
}

/** 与生产一致的 sha256（十六进制小写）。 */
export function createHashHex(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 极小的 CRC32（ZIP 头用）；表驱动会占篇幅，这里直接按位算。 */
function crc32(data) {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 构造 stored（不压缩）ZIP：检查器用例需要真实容器字节，
 * 且需要精确控制部件名/数量/大小（解压炸弹、重复部件、超大部件等场景）。
 */
export function makeZip(parts) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [name, value] of Object.entries(parts)) {
		const nameBuffer = Buffer.from(name, "utf8");
		const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc32(data), 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(nameBuffer.length, 26);
		const record = Buffer.concat([header, nameBuffer, data]);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt32LE(crc32(data), 16);
		cd.writeUInt32LE(data.length, 20);
		cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(nameBuffer.length, 28);
		cd.writeUInt32LE(offset, 42);
		local.push(record);
		central.push(Buffer.concat([cd, nameBuffer]));
		offset += record.length;
	}
	const centralBuffer = Buffer.concat(central);
	const localBuffer = Buffer.concat(local);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(central.length, 8);
	eocd.writeUInt16LE(central.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(localBuffer.length, 16);
	return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

/** 最小但结构完整的 docx：document.xml 里放指定段落。 */
export function makeDocx(paragraphs, options = {}) {
	const body = paragraphs
		.map((paragraph) => {
			const style = paragraph.headingLevel ? `<w:pPr><w:pStyle w:val="Heading${paragraph.headingLevel}"/></w:pPr>` : "";
			return `<w:p>${style}${paragraph.runs ?? ""}<w:r><w:t>${paragraph.text}</w:t></w:r></w:p>`;
		})
		.join("");
	const parts = {
		"[Content_Types].xml": "<Types/>",
		"word/document.xml": `<?xml version="1.0"?><w:document><w:body>${body}${options.extraBody ?? ""}</w:body></w:document>`,
		"word/styles.xml": options.styles ?? "<w:styles/>",
	};
	for (const [name, value] of Object.entries(options.parts ?? {})) parts[name] = value;
	return makeZip(parts);
}

export { crc32 };
