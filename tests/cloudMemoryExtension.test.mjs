// pi-deck-cloud-memory 扩展入口（pi-deck-cloud-memory.ts）的行为测试（N03 按需两级工具）。
//
// createTsSandbox 注入假 fs / 假 homedir / 可控 monotonic clock / 假 fetch：
// 不产生真实网络与真实文件写入。重点覆盖：普通回合零云端请求（本地配置/人格缓存仍读）、只有 execute 才发请求、
// 两级工具都是 direct 且可直接调用、取消返回真实状态、partial 与权限行为、
// 256KiB 与安全条数上界、观察记录（tool/turn）与日志轮换。
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱里产出的对象原型与测试 realm 不同，deepStrictEqual 会因原型不等而失败；比较前转成纯 JSON。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function assertPlain(actual, expected, message) {
	assert.deepEqual(plain(actual), expected, message);
}

const policy = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-policy.ts");
const HOME = join("C:", "fake-home");

function textResponse(status, text, headers = {}) {
	return {
		status,
		headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
		text: async () => text,
	};
}

function jsonResponse(status, body) {
	return textResponse(status, JSON.stringify(body));
}

/** 内存文件系统：key 全部 resolve 成绝对路径，阻断「相对路径意外写进项目目录」的可能。 */
function createFakeFs() {
	const files = new Map();
	const calls = { appendFile: [], rename: [], rm: [], mkdir: [] };
	const key = (filePath) => resolve(String(filePath));
	const api = {
		existsSync: (filePath) => files.has(key(filePath)),
		statSync: (filePath) => {
			const content = files.get(key(filePath));
			if (content === undefined) throw new Error("ENOENT");
			return { size: Buffer.byteLength(content, "utf8") };
		},
		readFileSync: (filePath) => {
			const content = files.get(key(filePath));
			if (content === undefined) throw new Error("ENOENT");
			return content;
		},
		mkdirSync: (filePath) => calls.mkdir.push(key(filePath)),
		appendFileSync: (filePath, content) => {
			const fileKey = key(filePath);
			calls.appendFile.push({ path: fileKey, content });
			files.set(fileKey, (files.get(fileKey) ?? "") + content);
		},
		renameSync: (from, to) => {
			const fromKey = key(from);
			const toKey = key(to);
			calls.rename.push({ from: fromKey, to: toKey });
			const content = files.get(fromKey);
			if (content === undefined) throw new Error("ENOENT");
			files.delete(fromKey);
			files.set(toKey, content);
		},
		rmSync: (filePath) => {
			calls.rm.push(key(filePath));
			files.delete(key(filePath));
		},
	};
	return {
		files,
		calls,
		api,
		key,
		write: (filePath, content) => files.set(key(filePath), content),
		read: (filePath) => files.get(key(filePath)) ?? null,
		lines: (filePath) => {
			const content = files.get(key(filePath));
			if (!content) return [];
			return content
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
	};
}

function loadExtension(options = {}) {
	const home = options.home ?? HOME;
	const agentDir = options.agentDir ?? join(home, ".pi", "agent");
	const env = { ...(options.env ?? {}) };
	if (options.agentDir) env.PI_CODING_AGENT_DIR = options.agentDir;
	const fs = createFakeFs();
	for (const [filePath, content] of Object.entries(options.files ?? {})) fs.write(filePath, content);
	const handlers = new Map();
	const tools = new Map();
	const appended = [];
	const sentMessages = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
	};
	const fetchCalls = [];
	let clock = 1000;
	let fetchImpl = options.fetchImpl ?? (async () => jsonResponse(200, { ok: true, available: true, items: [] }));
	// 采集状态走 node:fs/promises 的原子写；测试用同一份内存文件表，避免真实磁盘写入。
	const files = fs.files;
	const promisesApi = {
		readFile: async (filePath) => {
			const content = files.get(key(filePath));
			if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return content;
		},
		stat: async (filePath) => {
			const content = files.get(key(filePath));
			if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return { size: Buffer.byteLength(content, "utf8") };
		},
		open: async (filePath, mode) => {
			const fileKey = key(filePath);
			if (mode === "r") {
				// 有界读端口用 FileHandle：stat + read（与 node:fs/promises 同形）。
				if (!files.has(fileKey)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				const content = Buffer.from(files.get(fileKey), "utf8");
				return {
					stat: async () => ({ size: content.byteLength }),
					read: async (buffer, offset, length) => {
						const slice = content.subarray(0, Math.min(length, content.byteLength));
						slice.copy(buffer, offset);
						return { bytesRead: slice.byteLength };
					},
					close: async () => {},
				};
			}
			return {
				writeFile: async (content) => {
					files.set(fileKey, String(content));
				},
				sync: async () => {},
				close: async () => {},
			};
		},
		writeFile: async (filePath, content) => {
			files.set(key(filePath), String(content));
		},
		rename: async (from, to) => {
			const content = files.get(key(from));
			files.set(key(to), content);
			files.delete(key(from));
		},
		mkdir: async () => {},
		link: async (from, to) => {
			if (files.has(key(to))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
			files.set(key(to), files.get(key(from)));
		},
		unlink: async (filePath) => {
			if (files.has(key(filePath))) files.delete(key(filePath));
			else throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		readdir: async (dir) => {
			const prefix = `${key(dir)}${sep}`;
			return [...files.keys()].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
		},
	};
	const key = fs.key;
	const timers = [];
	const timeouts = [];
	const sandbox = createTsSandbox({
		stubs: {
			"node:fs": fs.api,
			"node:fs/promises": promisesApi,
			"node:os": { homedir: () => home },
			"node:perf_hooks": { performance: { now: () => clock } },
			// 心跳走 setInterval（fireTimers 手动触发）；D 的 sender 用 setTimeout（测试里不真跑）。
			"node:timers": {
				setInterval: (handler) => {
					timers.push(handler);
					return { unref: () => {} };
				},
				clearInterval: (handle) => {
					if (handle) handle.stopped = true;
				},
				setTimeout: (handler) => {
					timeouts.push(handler);
					return { unref: () => {} };
				},
				clearTimeout: () => {},
			},
			...(options.extraStubs ?? {}),
		},
		globals: {
			process: { env, pid: 4242 },
			fetch: (url, init) => {
				fetchCalls.push({ url, init });
				return fetchImpl(url, init);
			},
		},
	});
	const extension = sandbox("resources/extensions/pi-deck-cloud-memory.ts");
	extension.default(pi);
	return {
		handlers,
		tools,
		appended,
		sentMessages,
		timers,
		fireTimers: () => {
			for (const timer of timers) if (typeof timer === "function") timer();
		},
		pendingTimeouts: () => timeouts.length,
		fs,
		fetchCalls,
		advance: (ms) => {
			clock += ms;
		},
		now: () => clock,
		setFetch: (impl) => {
			fetchImpl = impl;
		},
		paths: {
			config: join(agentDir, "pi-deck-cloud-memory.json"),
			auth: join(agentDir, "auth.json"),
			log: join(agentDir, "pi-deck-cloud-memory.log.jsonl"),
		},
	};
}

function validConfig(ext, overrides = {}) {
	return { baseUrl: "https://memory.example", authFile: ext.paths.auth, logFile: ext.paths.log, mode: "personal", enabled: true, ...overrides };
}

/** 采集游标文件路径含随机 device 段：按前缀查找，不写死设备 id。 */
function findCaptureCursor(ext, accountInstance = "acct_1--inst-1") {
	const marker = `${sep}_local${sep}capture${sep}${accountInstance}--`;
	return [...ext.fs.files.keys()].find((file) => file.includes(marker) && file.endsWith(`${sep}cursor-session-1.json`)) ?? null;
}

/** 写入 auth：C 的 auth.json 带 account/cloudInstanceId 绑定；旧只读配置可只写 token。 */
function writeAuth(ext, binding = {}) {
	const body = binding.account && binding.cloudInstanceId ? { token: "session-token-abc", account: binding.account, cloudInstanceId: binding.cloudInstanceId } : { token: "session-token-abc" };
	ext.fs.write(ext.paths.auth, JSON.stringify(body));
}

/** 写入合法配置与 token，返回可用的扩展实例。 */
function loadPersonalExtension(options = {}) {
	const ext = loadExtension(options);
	writeAuth(ext);
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext)));
	return ext;
}

function makeCtx({ sessionId = "session-1" } = {}) {
	return { sessionManager: { getSessionId: () => sessionId } };
}

function runTool(ext, name, args, ctx = makeCtx(), signal = undefined) {
	const tool = ext.tools.get(name);
	assert.ok(tool, `工具 ${name} 必须已注册`);
	return tool.execute("tool-call-1", args, signal, undefined, ctx);
}

function runHandler(ext, name, event, ctx = makeCtx()) {
	const handler = ext.handlers.get(name);
	assert.ok(handler, `handler ${name} 必须已注册`);
	return handler(event, ctx);
}

function textOf(result) {
	return result.content.map((part) => part.text).join("\n");
}

const OK_ITEM = {
	id: "mem-1",
	text: "用户说过喜欢在周五复盘",
	source_id: "src_1",
	scope: "personal",
	mentioned_at: "2026-10-01T00:00:00Z",
	preview_truncated: true,
	sources: [{ source_id: "src_1", role: "user", occurred_at: "2026-09-30T12:00:00Z", revision: 2 }],
};

test("普通回合零云端请求：无工具调用就不联网、不写观测日志（本地配置/人格缓存读取不算网络）", async () => {
	const ext = loadPersonalExtension();
	assert.equal(ext.handlers.has("context"), true, "只注册状态控制消息过滤器（不是注入路径）");
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "帮我改个函数" });
	await runHandler(ext, "before_provider_request", { type: "before_provider_request", payload: {} });
	await runHandler(ext, "message_update", { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "好的" } });
	await runHandler(ext, "message_end", { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 5 } } });
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: false });

	assert.equal(ext.fetchCalls.length, 0, "普通回合不得发任何云端请求（persona/配置是本地读，不是网络）");
	assert.equal(ext.fs.lines(ext.paths.log).length, 0, "没有工具调用就不写观察日志");
});

test("配置缺失：只有工具调用才报 unconfigured（每 session 仅一次状态行），且不发网络", async () => {
	const ext = loadExtension();
	const first = await runTool(ext, "search_memory", { query: "上次说的偏好" });
	assert.equal(first.isError, true);
	assert.match(textOf(first), /状态: unconfigured（config_missing）/);
	assert.equal(first.details.status, "error");
	assert.equal(ext.fetchCalls.length, 0, "配置缺失不得联网");

	await runTool(ext, "get_memory_source", { source_id: "src_1" });
	const records = ext.fs.lines(ext.paths.log);
	assert.equal(records.filter((record) => record.kind === "status").length, 1, "同一 session 状态行只记一次");
	assert.equal(records.filter((record) => record.kind === "tool").length, 2, "每次调用各记一条 tool 记录");
	assert.equal(records[0].status, "unconfigured");
	assert.equal(records[0].reason, "config_missing");
	assert.equal(records[0].toolMs, null);
});

test("两级工具都是 direct（未设 exposure）：模型可直接调用，无需 tool_search/codemode", () => {
	const ext = loadPersonalExtension();
	assertPlain([...ext.tools.keys()].sort(), ["get_memory_source", "search_memory"]);
	for (const name of ext.tools.keys()) {
		const tool = ext.tools.get(name);
		assert.equal(tool.exposure, undefined, `${name} 不得设 exposure（缺省即 direct）`);
		assert.equal(typeof tool.execute, "function");
		assert.ok(typeof tool.description === "string" && tool.description.length > 0);
	}
	assert.match(ext.tools.get("search_memory").description, /Engram/, "说明必须指路工程经验走 Engram");
	assert.match(ext.tools.get("get_memory_source").description, /exactly one/);
});

test("search_memory：一次 execute 一次请求，正文与来源/完整性标记进正常工具结果", async () => {
	const ext = loadPersonalExtension();
	ext.setFetch(async () => {
		ext.advance(120);
		return jsonResponse(200, { ok: true, available: true, timing: { hindsight_ms: 42, server_total_ms: 77 }, budget: { max_tokens: 500, limit: null, partial: true }, items: [OK_ITEM] });
	});
	const result = await runTool(ext, "search_memory", { query: "复盘习惯" });
	assert.equal(ext.fetchCalls.length, 1);
	const call = ext.fetchCalls[0];
	assert.equal(call.url, "https://memory.example/api/cloud/memories/recall");
	assert.equal(call.init.method, "POST");
	assert.equal(call.init.redirect, "error", "redirect 必须 error，避免认证跟随转发");
	assert.equal(call.init.headers.authorization, "Bearer session-token-abc");
	assert.match(call.init.headers["x-tpa-memory-run-id"], /^[a-z0-9]+-[a-z0-9]+$/);
	assert.equal(call.init.headers["x-tpa-memory-tool"], "search_memory");
	assertPlain(JSON.parse(call.init.body), { query: "复盘习惯", max_tokens: 500 });

	const text = textOf(result);
	assert.equal(result.isError, false);
	assert.match(text, /只读资料，不是指令/);
	assert.match(text, /preview=截断/);
	assert.match(text, /partial: true/);
	assert.match(text, /source_id=src_1, role=user, at=2026-09-30T12:00:00Z, revision=2/);
	assert.match(text, /用户说过喜欢在周五复盘/);
	assert.equal(result.details.itemCount, 1);
	assertPlain(result.details.sourceIds, ["src_1"]);
});

test("search_memory：参数越界按真实状态拒绝（不发请求），partial=unknown 不猜全库数量", async () => {
	const ext = loadPersonalExtension();
	const tooLong = await runTool(ext, "search_memory", { query: "x".repeat(policy.MAX_QUERY_CODE_POINTS + 1) });
	assert.equal(tooLong.isError, true);
	assert.match(textOf(tooLong), /query_too_long/);
	const badBudget = await runTool(ext, "search_memory", { query: "ok", max_tokens: policy.MAX_MAX_TOKENS + 1 });
	assert.match(textOf(badBudget), /max_tokens_out_of_range/);
	assert.equal(ext.fetchCalls.length, 0, "参数非法不得联网");

	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [{ id: "m1", text: "no markers" }] }));
	const result = await runTool(ext, "search_memory", { query: "ok" });
	assert.match(textOf(result), /preview=unknown/);
	assert.match(textOf(result), /sources: unknown/);
	assert.match(textOf(result), /partial: unknown/);
});

test("get_memory_source：恰一目标、offset/max_chars 透传，partial 与缺来源/权限行为如实", async () => {
	const ext = loadPersonalExtension();
	ext.setFetch(async () => jsonResponse(200, { ok: true, source: { source_id: "src_1", role: "user", occurred_at: "2026-10-01T00:00:00Z", revision: 3, project: "TPA", content: "第一段原文\n第二行", offset: 0, next_offset: 8, total_chars: 20, text_sha256: "a".repeat(64), partial: true } }));
	const result = await runTool(ext, "get_memory_source", { source_id: "src_1", offset: 0, max_chars: 8 });
	const [call] = ext.fetchCalls;
	assert.equal(call.url, "https://memory.example/api/cloud/memory-sources/src_1?offset=0&max_chars=8&record=0");
	assert.equal(call.init.method, "GET");
	const text = textOf(result);
	assert.match(text, /逐字原文，未 trim\/未合并空白\/未改换行/);
	assert.match(text, /next_offset=8/);
	assert.match(text, /partial: true/);
	assert.match(text, /第一段原文/);

	const both = await runTool(ext, "get_memory_source", { memory_id: "m1", source_id: "s1" });
	assert.equal(both.isError, true);
	assert.match(textOf(both), /source_target_ambiguous/);
	const none = await runTool(ext, "get_memory_source", {});
	assert.match(textOf(none), /source_target_required/);

	ext.setFetch(async () => jsonResponse(404, { ok: false, error: "not_found" }));
	const missing = await runTool(ext, "get_memory_source", { memory_id: "m1" });
	assert.equal(missing.isError, false, "不存在/无权是真实状态，不是工具故障");
	assert.match(textOf(missing), /状态: not_found/);
	assert.equal(missing.details.status, "not_found");

	ext.setFetch(async () => jsonResponse(401, { ok: false, error: "unauthorized" }));
	const unauthorized = await runTool(ext, "get_memory_source", { memory_id: "m1" });
	assert.match(textOf(unauthorized), /状态: auth_required/);
	assert.equal(unauthorized.details.status, "auth_required");

	ext.setFetch(async () => jsonResponse(200, { ok: true, available: false, items: [] }));
	const unavailable = await runTool(ext, "search_memory", { query: "ok" });
	assert.match(textOf(unavailable), /状态: unavailable/);
	assert.equal(unavailable.details.status, "unavailable");
});

test("get_memory_source 续读：offset>0 必须带 base_sha256（本地先拦），record 选中同一条，409 不拼接两个版本", async () => {
	const ext = loadPersonalExtension();
	ext.setFetch(async () =>
		jsonResponse(200, {
			ok: true,
			source: {
				source_id: "src_2",
				content: "第二段",
				offset: 8,
				next_offset: 16,
				total_chars: 24,
				text_sha256: "seg2",
				base_sha256: "b".repeat(64),
				partial: true,
				record_index: 1,
				included: true,
				records: [
					{ source_id: "src_1", role: "user", text_sha256: "b".repeat(64) },
					{ source_id: "src_2", role: "assistant", text_sha256: "c" },
				],
			},
		}),
	);

	const missing = await runTool(ext, "get_memory_source", { memory_id: "m1", offset: 800 });
	assert.equal(missing.isError, true);
	assert.match(textOf(missing), /base_sha256_required_for_offset/);
	assert.equal(ext.fetchCalls.length, 0, "缺少续读哈希时不得发请求");

	const hash = "b".repeat(64);
	const continued = await runTool(ext, "get_memory_source", { memory_id: "m1", offset: 800, record: 1, base_sha256: hash });
	assert.equal(ext.fetchCalls.length, 1);
	assert.match(ext.fetchCalls[0].url, new RegExp(`offset=800&max_chars=8000&record=1&base_sha256=${hash}$`));
	const text = textOf(continued);
	assert.match(text, /record: selected=1（请求 record=1） included=true/);
	assert.match(text, /records: .*\*\[1\] source_id=src_2/);
	assert.match(text, /续读: 保持 record=1/);

	ext.setFetch(async () => jsonResponse(409, { ok: false, error: "revision_conflict" }));
	const conflicted = await runTool(ext, "get_memory_source", { memory_id: "m1", offset: 800, base_sha256: hash });
	assert.equal(conflicted.isError, true);
	assert.match(textOf(conflicted), /来源版本冲突/);
	assert.match(textOf(conflicted), /从 offset=0 重读/);
	assert.equal(ext.fetchCalls.length, 2, "冲突只请求一次，不自动重试");
});

test("取消：已中止的 signal 不请求；在飞中止返回 aborted 且不重试", async () => {
	const ext = loadPersonalExtension();
	const controller = new AbortController();
	controller.abort();
	const preAborted = await runTool(ext, "search_memory", { query: "ok" }, makeCtx(), controller.signal);
	assert.equal(ext.fetchCalls.length, 0, "已中止不得发起请求");
	assert.equal(preAborted.isError, true);
	assert.match(textOf(preAborted), /状态: aborted/);

	let fetchStarted = () => {};
	const started = new Promise((resolve) => {
		fetchStarted = resolve;
	});
	ext.setFetch(
		(url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				fetchStarted();
			}),
	);
	const inflightController = new AbortController();
	const inflight = runTool(ext, "get_memory_source", { source_id: "src_1" }, makeCtx(), inflightController.signal);
	await started;
	inflightController.abort();
	const result = await inflight;
	assert.equal(ext.fetchCalls.length, 1, "在飞请求只发一次，不重试");
	assert.match(textOf(result), /请求已取消/);
	assert.equal(result.details.status, "aborted");
});

test("上界：256KiB 回包与安全条数 50 都是真实失败，不静默降级", async () => {
	const ext = loadPersonalExtension();
	ext.setFetch(async () => textResponse(200, "{}", { "content-length": String(256 * 1024 + 1) }));
	const huge = await runTool(ext, "search_memory", { query: "ok" });
	assert.equal(huge.isError, true);
	assert.match(textOf(huge), /response_too_large/);

	const items = Array.from({ length: 51 }, (_, index) => ({ id: `m${index}`, text: `t${index}` }));
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items }));
	const tooMany = await runTool(ext, "search_memory", { query: "ok" });
	assert.match(textOf(tooMany), /too_many_items/);
});

test("观察记录：一次工具调用写 tool + turn 记录（server_timing/toolMs/请求数/用量），摘要进原生时间线", async () => {
	const ext = loadPersonalExtension();
	ext.setFetch(async () => {
		ext.advance(120);
		return jsonResponse(200, { ok: true, available: true, timing: { hindsight_ms: 42, server_total_ms: 77 }, budget: { max_tokens: 500, limit: null, partial: true }, items: [OK_ITEM] });
	});
	const ctx = makeCtx();
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "复盘习惯" }, ctx);
	ext.advance(30);
	await runTool(ext, "search_memory", { query: "复盘习惯" }, ctx);
	await runHandler(ext, "before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
	await runHandler(ext, "message_update", { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "看到" } }, ctx);
	await runHandler(ext, "message_end", { type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 20 } } }, ctx);
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	const records = ext.fs.lines(ext.paths.log);
	assert.equal(records.length, 2, "一次调用 = tool + turn 两条记录");
	const [toolRecord, turnRecord] = records;
	assert.equal(toolRecord.kind, "tool");
	assert.equal(toolRecord.tool, "search_memory");
	assert.equal(toolRecord.status, "ok");
	assert.equal(toolRecord.serverTiming.hindsight_ms, 42);
	assert.equal(toolRecord.itemCount, 1);
	assert.equal(toolRecord.partial, true);
	assertPlain(toolRecord.sourceIds, ["src_1"]);
	assert.equal(toolRecord.toolMs, 120);
	assert.equal(turnRecord.kind, "turn");
	assert.equal(turnRecord.toolCallCount, 1);
	assert.equal(turnRecord.requestCount, 1);
	assert.equal(turnRecord.firstTextMs, 150, "首字相对回合起点 30+120ms");
	assert.equal(turnRecord.turnMs, 150);
	assertPlain(turnRecord.usage, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	assert.equal(ext.appended.length, 1, "turn 摘要进原生 appendEntry");
	assert.equal(ext.appended[0].customType, policy.TIMING_ENTRY_TYPE);
	assert.ok(!JSON.stringify(records).includes("用户说过喜欢"), "记录绝不包含记忆正文");
});

test("PI_CODING_AGENT_DIR：配置/日志走独立 profile 目录", async () => {
	const profile = join("D:", "pi-profile", "agent");
	const ext = loadPersonalExtension({ agentDir: profile });
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));
	await runTool(ext, "search_memory", { query: "profile" });
	assert.equal(ext.fs.lines(ext.paths.log).length, 1);

	const missing = loadExtension({ agentDir: profile });
	await runTool(missing, "search_memory", { query: "profile" });
	assert.equal(missing.fs.lines(missing.paths.log)[0].status, "unconfigured");
});

test("日志到达上限：轮换到 .1，增长有界", async () => {
	const ext = loadPersonalExtension();
	ext.fs.write(ext.paths.log, "x".repeat(policy.MAX_LOG_BYTES));
	await runTool(ext, "search_memory", { query: "rotate" });
	assert.ok(
		ext.fs.calls.rename.some((call) => call.from === ext.paths.log && call.to === `${ext.paths.log}.1`),
		"达到上限必须轮换",
	);
	assert.equal(ext.fs.read(`${ext.paths.log}.1`).length, policy.MAX_LOG_BYTES, "旧内容进备份");
	assert.equal(ext.fs.lines(ext.paths.log).length, 1, "新记录写进主文件");
});

// ---------------------------------------------------------------------------
// N05：N04 env 衔接 / 人格缓存 / profile 变更保护 / 采集接线
// ---------------------------------------------------------------------------

const personaModule = loadTsCommonJs("resources/extensions/pi-deck-cloud-memory-persona.ts");
const DEFAULT_PERSONA_FILE = join(HOME, ".pi", "agent", "cloud-memory", "persona-cache.json");

function personaCacheFile({ text, account, cloudInstanceId, enabled = true, originalText = text }) {
	return {
		version: 1,
		account,
		cloudInstanceId,
		text,
		original_text: originalText,
		enabled,
		revision: personaModule.personaRevision(text, enabled),
		raw_revision: personaModule.personaRawRevision(originalText, enabled),
		updated_at: "2026-10-13T00:00:00.000Z",
		fetched_at: "2026-10-13T00:10:00.000Z",
	};
}

async function waitFor(predicate, tries = 200) {
	for (let index = 0; index < tries; index += 1) {
		if (predicate()) return;
		await new Promise((resolveTick) => setImmediate(resolveTick));
	}
	throw new Error("waitFor 超时");
}

/** 会话假体：只用 Pi public 读法（getSessionId/getCwd/getLeafId/getBranch/buildSessionProjection）。 */
function makeSession({ sessionId = "session-1", cwd = join("E:", "A PI", "personal", "TPA") } = {}) {
	const entries = [];
	let leafId = null;
	const snapshotProjection = () => ({ entries: entries.map((entry) => ({ sourceEntry: entry, messages: [entry.message] })), messages: entries.map((entry) => entry.message), thinkingLevel: "off", model: null });
	return {
		entries,
		add(input) {
			const message = input.role === "assistant" ? { role: "assistant", content: [{ type: "text", text: input.text }], stopReason: input.stopReason ?? "stop" } : { role: "user", content: [{ type: "text", text: input.text }] };
			entries.push({ id: input.id, parentId: input.parentId ?? leafId, type: "message", timestamp: input.occurredAt ?? "2026-10-13T00:00:00.000Z", message });
			leafId = input.id;
			return input.id;
		},
		ctx: {
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => cwd,
				getLeafId: () => leafId,
				getBranch: () => [...entries],
				getEntries: () => entries,
				buildSessionProjection: snapshotProjection,
			},
		},
	};
}

test("N04 env：PIDECK_CLOUD_MEMORY_CONFIG/_DATA_DIR 显式 profile 优先，路径仍校验允许根", async () => {
	const dataDir = join("D:", "pideck-data", "cloud-memory");
	const configFile = join(dataDir, "config.json");
	const authFile = join(dataDir, "auth.json");
	const logFile = join(dataDir, "log.jsonl");
	const ext = loadExtension({ env: { PIDECK_CLOUD_MEMORY_CONFIG: configFile, PIDECK_CLOUD_MEMORY_DATA_DIR: dataDir } });
	ext.fs.write(authFile, JSON.stringify({ token: "env-token" }));
	ext.fs.write(configFile, JSON.stringify({ enabled: true, mode: "personal", baseUrl: "https://memory.example", authFile, logFile }));
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));

	const result = await runTool(ext, "search_memory", { query: "env 显式配置" });
	assert.equal(result.isError, false);
	assert.equal(ext.fetchCalls.length, 1, "必须采用显式 env 配置文件");
	assert.equal(ext.fetchCalls[0].init.headers.authorization, "Bearer env-token");
	assert.equal(ext.fs.lines(logFile).length, 1, "观测日志也走显式 profile");
	assert.equal(ext.fs.lines(ext.paths.log).length, 0, "不得往默认 agent 位置写");
});

test("N04 env 越界/相对路径：记问题并回退默认 agent 目录，不越权读文件", async () => {
	const ext = loadPersonalExtension({ env: { PIDECK_CLOUD_MEMORY_CONFIG: join("D:", "outside", "config.json"), PIDECK_CLOUD_MEMORY_DATA_DIR: "relative-data" } });
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));
	const result = await runTool(ext, "search_memory", { query: "fallback" });
	assert.equal(result.isError, false, "非法 env 不得阻断默认位置的配置");
	assert.equal(ext.fetchCalls.length, 1);
});

test("人格：每用户回合固定缓存版本，只追加不替换系统提示，revision 进回合记录", async () => {
	const ext = loadPersonalExtension();
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { account: "acct_1", cloudInstanceId: "inst-1" })));
	writeAuth(ext, { account: "acct_1", cloudInstanceId: "inst-1" });
	const firstText = "用户偏好直接、少客套。";
	const firstRevision = personaModule.personaRevision(firstText, true);
	ext.fs.write(DEFAULT_PERSONA_FILE, JSON.stringify(personaCacheFile({ text: firstText, account: "acct_1", cloudInstanceId: "inst-1" })));
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));

	const ctx = makeCtx();
	const event = { type: "before_agent_start", prompt: "p", systemPromptOptions: { appendSystemPrompt: "项目规则：不许删文件" } };
	await runHandler(ext, "before_agent_start", event, ctx);
	console.log("DEBUG persona", JSON.stringify(ext.sentMessages.map((m) => m.message.details)), JSON.stringify(event.systemPromptOptions));
	assert.match(event.systemPromptOptions.appendSystemPrompt, /项目规则：不许删文件/, "系统提示与项目规则必须保留");
	assert.match(event.systemPromptOptions.appendSystemPrompt, new RegExp(firstText));
	assert.match(event.systemPromptOptions.appendSystemPrompt, new RegExp(firstRevision));

	// 回合内缓存换代：本回合仍必须用旧版本（snapshot 固定）。
	ext.fs.write(DEFAULT_PERSONA_FILE, JSON.stringify(personaCacheFile({ text: "改后正文。", account: "acct_1", cloudInstanceId: "inst-1" })));
	await runTool(ext, "search_memory", { query: "x" }, ctx);
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
	const turnRecord = ext.fs.lines(ext.paths.log).find((entry) => entry.kind === "turn");
	assert.ok(turnRecord, "有工具调用的回合必须写 turn 记录");
	assert.equal(turnRecord.personaRevision, firstRevision, "同回合固定同一人格版本");

	const next = { type: "before_agent_start", prompt: "p2", systemPromptOptions: {} };
	await runHandler(ext, "before_agent_start", next, ctx);
	assert.match(next.systemPromptOptions.appendSystemPrompt, /改后正文。/, "下一回合使用新版本");
	assert.equal(next.systemPromptOptions.appendSystemPrompt.includes(firstText), false);
});

test("人格：账号/实例不匹配或缓存缺失时回默认规则，不注入未验证文本", async () => {
	const ext = loadPersonalExtension();
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { account: "acct_1", cloudInstanceId: "inst-1" })));
	writeAuth(ext, { account: "acct_1", cloudInstanceId: "inst-1" });
	ext.fs.write(DEFAULT_PERSONA_FILE, JSON.stringify(personaCacheFile({ text: "别的账号的人格", account: "acct_2", cloudInstanceId: "inst-1" })));
	const event = { type: "before_agent_start", prompt: "p", systemPromptOptions: {} };
	await runHandler(ext, "before_agent_start", event, makeCtx());
	assert.equal(event.systemPromptOptions.appendSystemPrompt, undefined, "不匹配不得注入");
	const statuses = ext.sentMessages.filter(({ message }) => message.details?.kind === "persona");
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].message.details.reason, "account_mismatch");
	assert.equal(statuses[0].message.display, false);
	assert.equal(statuses[0].options.triggerTurn, false);
});

test("profile 变更保护：工具结果返回前核对有效 profile，旧档案内容不得进入当前回合", async () => {
	const ext = loadPersonalExtension();
	const ctx = makeCtx();
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "p", systemPromptOptions: {} }, ctx);
	let release = null;
	ext.setFetch(
		async () =>
			new Promise((resolveRelease) => {
				release = () => resolveRelease(jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));
			}),
	);
	const pending = runTool(ext, "search_memory", { query: "旧档案" }, ctx);
	await waitFor(() => typeof release === "function");
	// N04 writer 切账号会整份重写配置与 auth 绑定；旧 runtime 不得把旧档案结果带进新回合。
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { account: "acct_2", cloudInstanceId: "inst-2" })));
	writeAuth(ext, { account: "acct_2", cloudInstanceId: "inst-2" });
	release();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /profile_changed/);
	assert.equal(textOf(result).includes("用户说过喜欢在周五复盘"), false, "旧档案结果必须丢弃");
	const statuses = ext.sentMessages.filter(({ message }) => message.details?.kind === "profile");
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].message.details.needsNewSession, true, "明确 needs_new_session，不静默换账号");
});

test("采集接线：启用同步后 turn_end 对账（public API），经 D 的 identity/outbox 登记，状态走原生 customMessage", async () => {
	const dataDir = join("D:", "pideck-data", "cloud-memory");
	const configFile = join(dataDir, "config.json");
	const registered = [];
	const created = [];
	const identityStub = {
		normalizeSyncTextBlocks: (content) => (Array.isArray(content) ? content.filter((block) => block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) : []),
		createSyncRecord: (input) => {
			created.push(input);
			return { kind: input.kind, identity: input.identity, role: input.role, textBlocks: input.content, visibility: input.visibility ?? "visible", sourceId: `src_${input.identity.entryId}_${input.identity.revision}`, revision: input.identity.revision };
		},
		advanceSyncRevision: (record, change) => {
			created.push({ change });
			const revision = record.identity.revision + 1;
			return { ...record, identity: { ...record.identity, revision }, revision, visibility: change.visibility ?? record.visibility, kind: change.kind };
		},
		parseSyncRecord: (value) => (value && typeof value === "object" ? value : null),
	};
	const outboxStub = {
		createSyncOutbox: () => ({
			open: async (scope) => ({
				scope,
				register: async (record) => {
					registered.push(record);
					return { status: "queued", sourceId: record.sourceId, existing: "none", entry: null };
				},
			}),
		}),
	};
	const ext = loadExtension({
		env: { PIDECK_CLOUD_MEMORY_CONFIG: configFile, PIDECK_CLOUD_MEMORY_DATA_DIR: dataDir },
		extraStubs: { "./pi-deck-cloud-memory-sync-identity": identityStub, "./pi-deck-cloud-memory-sync-outbox": outboxStub },
	});
	ext.fs.write(join(dataDir, "auth.json"), JSON.stringify({ token: "sync-token", account: "acct_1", cloudInstanceId: "inst-1" }));
	ext.fs.write(
		configFile,
		JSON.stringify({ enabled: true, mode: "personal", baseUrl: "https://memory.example", authFile: join(dataDir, "auth.json"), logFile: join(dataDir, "log.jsonl"), account: "acct_1", cloudInstanceId: "inst-1", stateDir: dataDir, personaCacheFile: join(dataDir, "persona-cache.json"), syncEnabled: true }),
	);

	const session = makeSession();
	session.add({ id: "e-base", role: "user", text: "启用前的历史" });
	await runHandler(ext, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "p", systemPromptOptions: {} }, session.ctx);

	session.add({ id: "e-user", role: "user", text: "用户原话\n第二行" });
	session.add({ id: "e-asst", role: "assistant", text: "助手可见回答" });
	await runHandler(ext, "turn_end", { type: "turn_end" }, session.ctx);

	assert.equal(registered.length, 2, "只采基线之后的新增条目");
	assert.equal(created.length, 2);
	assert.equal(created[0].identity.accountId, "acct_1");
	assert.equal(created[0].identity.sessionId, "session-1");
	assert.equal(created[0].identity.entryId, "e-user");
	assert.equal(created[0].content[0].text, "用户原话\n第二行", "逐字采集");
	assert.equal(created[0].project, "TPA", "保留项目标签");
	assert.equal(created[1].parentSourceId, registered[0].sourceId, "父条目关系绑定上一来源");
	assert.equal(registered[1].role, "assistant");

	const stateFile = findCaptureCursor(ext);
	assert.ok(ext.fs.read(stateFile), "事件游标立即落盘");
	assert.match(ext.fs.read(join(dataDir, "_local", "device.json")), /"deviceId"/, "设备 id 原子创建在 stateDir 内");
	assert.ok(stateFile, "游标路径必须含 account--instance--device");

	const captureStatuses = ext.sentMessages.filter(({ message }) => message.details?.kind === "capture");
	assert.ok(captureStatuses.length >= 1, "状态经原生 customMessage 上报");
	// 采集成功会把 sender 拉起来（这里用桩队列，sender 起不来也只是 sync 状态报错，不影响采集与回答）。
	const syncStatuses = ext.sentMessages.filter(({ message }) => message.details?.kind === "sync");
	assert.ok(syncStatuses.length >= 1, "采集接线必须经过 sender 宿主（status 走 kind=sync）");
	const SYNC_STATES = ["idle", "sending", "retrying", "disabled", "auth_blocked", "scope_mismatch", "owner_blocked", "oversized", "stopped"];
	for (const { message } of syncStatuses) {
		const state = message.details.state;
		assert.ok(state === null || SYNC_STATES.includes(state), `sync state 必须在固定枚举内: ${String(state)}`);
	}
	assert.equal(captureStatuses[0].message.display, false);
	assert.equal(captureStatuses[0].options.triggerTurn, false);
	assert.equal(
		captureStatuses.some(({ message }) => message.details.lineagePartial === true),
		true,
		"已有历史标 lineage_partial",
	);

	// 取消的部分回答同回合结算：completion=incomplete 且内容仍逐字保留。
	session.add({ id: "e-abort", role: "assistant", text: "被取消的半句", stopReason: "aborted" });
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: true }, session.ctx);
	const aborted = created.find((input) => input.identity && input.identity.entryId === "e-abort");
	assert.ok(aborted, "取消的部分回答必须登记");
	assert.equal(aborted.completion, "incomplete");

	// 扩展自己发的 custom 控制条目（状态）不得进原话，否则会把状态当用户/助手内容回传。
	const before = registered.length;
	session.entries.push({ id: "e-status", parentId: "e-abort", type: "custom_message", timestamp: "2026-10-13T00:00:02.000Z", customType: "pi-deck-cloud-memory-status", display: false, content: "云端记忆状态: capture/registered" });
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: false }, session.ctx);
	assert.equal(registered.length, before, "custom/状态条目不进原话");
});

/** 可复用的 identity/outbox 桩：只验证接线与字段映射，不触真实 fs/crypto。 */
function makeSyncStubs(registered, created) {
	return {
		identity: {
			normalizeSyncTextBlocks: (content) => (Array.isArray(content) ? content.filter((block) => block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) : []),
			createSyncRecord: (input) => {
				created.push(input);
				return { kind: input.kind, identity: input.identity, role: input.role, textBlocks: input.content, visibility: input.visibility ?? "visible", sourceId: `src_${input.identity.entryId}_${input.identity.revision}`, revision: input.identity.revision };
			},
			advanceSyncRevision: (record, change) => {
				created.push({ change });
				const revision = record.identity.revision + 1;
				return { ...record, identity: { ...record.identity, revision }, revision, visibility: change.visibility ?? record.visibility, kind: change.kind };
			},
			parseSyncRecord: (value) => (value && typeof value === "object" ? value : null),
		},
		outbox: {
			createSyncOutbox: () => ({
				// 桩队列要具备 D 的 SyncQueue 形状：scope 字段（sender 会核对绑定）+ 计数/列举。
				open: async (scope) => ({
					accountId: scope.accountId,
					cloudInstanceId: scope.cloudInstanceId,
					deviceId: scope.deviceId,
					dir: scope.stateDir ?? "",
					scope,
					register: async (record) => {
						registered.push(record);
						return { status: "queued", sourceId: record.sourceId, existing: "none", entry: null };
					},
					listPending: async () => ({ entries: [], invalid: [] }),
					countPending: async () => ({ count: 0, bytes: 0 }),
					getAuthState: async () => ({ blocked: false, reason: null }),
				}),
			}),
		},
	};
}

test("开关中途打开：以当前回合起点建基线，历史不回补、本回合新增照采", async () => {
	const dataDir = join("D:", "pideck-data", "cloud-memory");
	const configFile = join(dataDir, "config.json");
	const registered = [];
	const created = [];
	const stubs = makeSyncStubs(registered, created);
	const ext = loadExtension({
		env: { PIDECK_CLOUD_MEMORY_CONFIG: configFile, PIDECK_CLOUD_MEMORY_DATA_DIR: dataDir },
		extraStubs: { "./pi-deck-cloud-memory-sync-identity": stubs.identity, "./pi-deck-cloud-memory-sync-outbox": stubs.outbox },
	});
	ext.fs.write(join(dataDir, "auth.json"), JSON.stringify({ token: "sync-token", account: "acct_1", cloudInstanceId: "inst-1" }));
	const baseConfig = { enabled: true, mode: "personal", baseUrl: "https://memory.example", authFile: join(dataDir, "auth.json"), logFile: join(dataDir, "log.jsonl"), account: "acct_1", cloudInstanceId: "inst-1", stateDir: dataDir, personaCacheFile: join(dataDir, "persona-cache.json") };
	ext.fs.write(configFile, JSON.stringify({ ...baseConfig, syncEnabled: false }));

	const session = makeSession();
	session.add({ id: "e-base", role: "user", text: "开关前的历史" });
	await runHandler(ext, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
	assert.equal(findCaptureCursor(ext), null, "未开启同步不得建采集状态");

	// 用户中途打开开关：N04 writer 重写配置快照。
	ext.fs.write(configFile, JSON.stringify({ ...baseConfig, syncEnabled: true }));
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "p", systemPromptOptions: {} }, session.ctx);
	session.add({ id: "e-user", role: "user", text: "开关后的新问题" });
	session.add({ id: "e-asst", role: "assistant", text: "开关后的回答" });
	await runHandler(ext, "turn_end", { type: "turn_end" }, session.ctx);

	assert.deepEqual(
		registered.map((record) => record.identity.entryId),
		["e-user", "e-asst"],
		"只采开关之后的新增条目，历史不回补",
	);
	const state = JSON.parse(ext.fs.read(findCaptureCursor(ext)));
	assert.equal(state.baselineEntryId, "e-base", "基线落在本回合起点，而不是回合结束时的叶");
});

// ---------------------------------------------------------------------------
// N05 审阅修正：状态控制消息过滤 / 请求前 profile guard
// ---------------------------------------------------------------------------

test("状态控制消息不进模型上下文：只过滤本扩展 customType，工具结果与其它扩展消息保持", async () => {
	const ext = loadPersonalExtension();
	const ctx = makeCtx();
	const ownStatus = { role: "custom", customType: "pi-deck-cloud-memory-status", content: "", display: false, timestamp: 1 };
	const otherExtension = { role: "custom", customType: "pi-deck-other-extension", content: "别的扩展消息", display: false, timestamp: 2 };
	const memoryToolResult = { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "云端记忆工具结果" }], timestamp: 3 };
	const user = { role: "user", content: "问题", timestamp: 4 };

	const filtered = await runHandler(ext, "context", { type: "context", messages: [ownStatus, otherExtension, memoryToolResult, user] }, ctx);
	assert.equal(filtered.messages.length, 3, "只剔除本扩展的状态控制消息");
	assert.equal(filtered.messages.includes(ownStatus), false);
	assert.equal(filtered.messages.includes(otherExtension), true, "其它扩展消息保持");
	assert.equal(filtered.messages.includes(memoryToolResult), true, "记忆工具结果必须留在上下文");
	assert.equal(filtered.messages.includes(user), true);
	assert.equal(ext.fetchCalls.length, 0, "过滤不产生任何网络");

	const untouched = await runHandler(ext, "context", { type: "context", messages: [otherExtension, user] }, ctx);
	assert.equal(untouched, undefined, "没有控制消息时不改上下文（返回 undefined）");
});

test("profile guard：请求前发现档案变化就不发请求（旧 runtime 不换账号查询）", async () => {
	const ext = loadPersonalExtension();
	const ctx = makeCtx();
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "p", systemPromptOptions: {} }, ctx);

	// 回合开始后切账号 + 换 baseUrl（配置与 auth 一起换，保证 profile 本身有效）。
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { baseUrl: "https://memory2.example", account: "acct_2", cloudInstanceId: "inst-2" })));
	writeAuth(ext, { account: "acct_2", cloudInstanceId: "inst-2" });
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));

	const result = await runTool(ext, "search_memory", { query: "旧回合" }, ctx);
	assert.equal(ext.fetchCalls.length, 0, "请求前 guard 必须拦住旧档案查询");
	assert.equal(result.isError, true);
	assert.match(textOf(result), /profile_changed/);
	assert.equal(textOf(result).includes("用户说过喜欢在周五复盘"), false);
});

// ---------------------------------------------------------------------------
// N05 最终审阅：同 session 换账号封禁 / sync 状态独立 owner / 状态控制消息过滤
// ---------------------------------------------------------------------------

test("同 Pi session 换账号：该 session 封禁（不应用人格、不查记忆、不采集），只报 needs_new_session", async () => {
	const ext = loadPersonalExtension();
	writeAuth(ext, { account: "acct_1", cloudInstanceId: "inst-1" });
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { account: "acct_1", cloudInstanceId: "inst-1" })));
	const cursor = join(HOME, ".pi", "agent", "cloud-memory", "persona-cache.json");
	ext.fs.write(cursor, JSON.stringify(personaCacheFile({ text: "第一账号的人格", account: "acct_1", cloudInstanceId: "inst-1" })));
	ext.setFetch(async () => jsonResponse(200, { ok: true, available: true, items: [OK_ITEM] }));
	const ctx = makeCtx();

	// 第一个用户回合：正常工作并锁定 owner。
	const first = { type: "before_agent_start", prompt: "p1", systemPromptOptions: {} };
	await runHandler(ext, "before_agent_start", first, ctx);
	assert.match(first.systemPromptOptions.appendSystemPrompt, /第一账号的人格/, "首回合按锁定 owner 应用人格");
	await runTool(ext, "search_memory", { query: "第一次" }, ctx);
	assert.equal(ext.fetchCalls.length, 1);

	// 同一 session 的第二回合换账号（桌面重写 config + auth）。
	ext.fs.write(ext.paths.config, JSON.stringify(validConfig(ext, { account: "acct_2", cloudInstanceId: "inst-2" })));
	writeAuth(ext, { account: "acct_2", cloudInstanceId: "inst-2" });
	ext.fs.write(cursor, JSON.stringify(personaCacheFile({ text: "第二账号的人格", account: "acct_2", cloudInstanceId: "inst-2" })));
	const second = { type: "before_agent_start", prompt: "p2", systemPromptOptions: {} };
	await runHandler(ext, "before_agent_start", second, ctx);
	assert.equal(second.systemPromptOptions.appendSystemPrompt, undefined, "换账号后不得再应用新账号人格");
	assert.equal(
		ext.sentMessages.some(({ message }) => message.details?.kind === "profile" && message.details.needsNewSession === true),
		true,
		"必须明确 needs_new_session",
	);

	const blocked = await runTool(ext, "search_memory", { query: "第二账号" }, ctx);
	assert.equal(ext.fetchCalls.length, 1, "被封禁的回合不得发任何请求（旧 runtime 不换 token 查新账号）");
	assert.equal(blocked.isError, true);
	assert.match(textOf(blocked), /needs_new_session/);
});

test("sync 状态用独立 sender owner/session：回合清空后心跳仍带正确账号与会话", async () => {
	const dataDir = join("D:", "pideck-data", "cloud-memory");
	const configFile = join(dataDir, "config.json");
	const registered = [];
	const created = [];
	const stubs = makeSyncStubs(registered, created);
	const ext = loadExtension({
		env: { PIDECK_CLOUD_MEMORY_CONFIG: configFile, PIDECK_CLOUD_MEMORY_DATA_DIR: dataDir },
		extraStubs: { "./pi-deck-cloud-memory-sync-identity": stubs.identity, "./pi-deck-cloud-memory-sync-outbox": stubs.outbox },
	});
	ext.fs.write(join(dataDir, "auth.json"), JSON.stringify({ token: "sync-token", account: "acct_1", cloudInstanceId: "inst-1" }));
	ext.fs.write(
		configFile,
		JSON.stringify({ enabled: true, mode: "personal", baseUrl: "https://memory.example", authFile: join(dataDir, "auth.json"), logFile: join(dataDir, "log.jsonl"), account: "acct_1", cloudInstanceId: "inst-1", stateDir: dataDir, personaCacheFile: join(dataDir, "persona-cache.json"), syncEnabled: true }),
	);

	const session = makeSession();
	session.add({ id: "e-base", role: "user", text: "历史" });
	await runHandler(ext, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
	await runHandler(ext, "before_agent_start", { type: "before_agent_start", prompt: "p", systemPromptOptions: {} }, session.ctx);
	session.add({ id: "e-user", role: "user", text: "新问题" });
	await runHandler(ext, "turn_end", { type: "turn_end" }, session.ctx);
	await runHandler(ext, "agent_settled", { type: "agent_settled", aborted: false }, session.ctx);

	const before = ext.sentMessages.length;
	ext.fireTimers();
	const heartbeats = ext.sentMessages.slice(before).filter(({ message }) => message.details?.kind === "sync" && message.details.state !== undefined);
	assert.ok(heartbeats.length >= 1, "sender 心跳必须发 kind=sync 状态");
	assert.equal(heartbeats[0].message.details.account, "acct_1", "状态带 sender 自己的账号（不依赖已清空的 turn）");
	assert.equal(heartbeats[0].message.details.sessionId, "session-1", "状态带 sender 自己的 session");
	assert.equal(typeof heartbeats[0].message.details.pendingCount, "number");

	// 退出：心跳必须被清掉（stop 配对），之后不再上报。
	await runHandler(ext, "session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);
	const after = ext.sentMessages.length;
	ext.fireTimers();
	assert.equal(ext.sentMessages.length, after, "shutdown 之后不得再有心跳/状态");
});
