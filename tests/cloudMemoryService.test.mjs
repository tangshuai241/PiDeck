/**
 * CloudMemoryService + CloudMemoryStore 单测（N04 核心行为）。
 *
 * 覆盖 dispatch 要求：认证成功后保存、失败/配置改变/账号切换不落旧结果、凭据不回显、
 * secureStorage 不可用、人格哈希/CAS 缓存与离线回退、开关只改 enabledBuiltInExtensions。
 *
 * 用 tmpdir 真实落盘（验证原子写与文件形状），fetch/时钟/加密全部注入，不联网。
 */
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const pathsModule = loadTsCommonJs("src/main/cloudMemory/cloudMemoryPaths.ts");
const storeModule = loadTsCommonJs("src/main/cloudMemory/cloudMemoryStore.ts");
const serviceModule = loadTsCommonJs("src/main/cloudMemory/CloudMemoryService.ts");
const validation = loadTsCommonJs("src/main/cloudMemory/cloudMemoryValidation.ts");

const BASE_URL = "https://memory.example.com";
const FIXED_NOW = () => new Date("2026-10-13T08:00:00.000Z");

function personaPayload(overrides = {}) {
	const text = overrides.text ?? "默认人格：简洁、直接";
	const raw = overrides.raw ?? text;
	const enabled = overrides.enabled ?? true;
	return {
		text,
		original_text: raw,
		enabled,
		revision: validation.personaRevisionOf(text, enabled),
		raw_revision: validation.personaRawRevisionOf(raw, enabled),
		updated_at: "2026-10-12T12:00:00.000Z",
		...overrides,
	};
}

function createClient(overrides = {}) {
	const counters = { logins: 0, whoami: 0 };
	function createClientState() {
		return { validToken: null };
	}
	const state = createClientState();
	const client = {
		login: async (_origin, account) => {
			counters.logins += 1;
			state.validToken = `token-${account}-${counters.logins}`;
			return { ok: true, session: { token: state.validToken, account, scopes: ["memory"] } };
		},
		// 默认按「会话有效性」判定：登录签发的令牌有效，其余（含被 invalidateSession 作废的旧令牌）401
		whoami: async (_origin, token) => (token === state.validToken ? { ok: true, payload: { kind: "user", username: String(token).split("-")[1] ?? "alice", scopes: ["memory"] } } : { ok: false, error: { code: "unauthorized", message: "会话已失效" } }),
		logout: async () => {
			state.validToken = null;
			return { ok: true };
		},
		persona: async () => ({ ok: true, payload: personaPayload() }),
		...overrides,
		counters,
		/** 模拟会话过期：之后已签发的令牌一律不再被认可。 */
		invalidateSession: () => {
			state.validToken = null;
		},
	};
	return client;
}

function createHarness(options = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pideck-cloud-memory-"));
	const paths = pathsModule.resolveCloudMemoryPaths(dir);
	const rawStore = new storeModule.CloudMemoryStore({
		filePath: paths.connectionFile,
		isEncryptionAvailable: () => options.encryption !== false,
		protect: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
		unprotect: (buffer) => {
			const text = Buffer.from(buffer).toString("utf8");
			if (!text.startsWith("enc:")) throw new Error("tampered ciphertext");
			return text.slice(4);
		},
		log: () => {},
	});
	// 真实 await 竞态用：写盘人为拉长（测试不得靠假同步掩盖异步窗口）
	const store = options.slowWriteMs
		? {
				read: () => rawStore.read(),
				write: async (next) => {
					await delay(options.slowWriteMs);
					return rawStore.write(next);
				},
				readSecret: (settings, kind) => rawStore.readSecret(settings, kind),
				protectSecret: (plainText) => rawStore.protectSecret(plainText),
				isSecureStorageAvailable: () => rawStore.isSecureStorageAvailable(),
			}
		: rawStore;
	const client = options.client ?? createClient();
	const calls = { extensionSwitch: [], statusChanged: 0 };
	let extensionEnabled = false;
	const service = new serviceModule.CloudMemoryService({
		paths,
		store,
		client,
		isPiExtensionEnabled: () => extensionEnabled,
		setPiExtensionEnabled: async (value) => {
			extensionEnabled = value;
			calls.extensionSwitch.push(value);
		},
		now: FIXED_NOW,
		log: () => {},
		onStatusChanged: () => {
			calls.statusChanged += 1;
		},
		// 后台刷新周期放短，便于断言 dispose/去重；断言的测试自己控制节奏
		...(options.personaRefreshIntervalMs ? { personaRefreshIntervalMs: options.personaRefreshIntervalMs } : {}),
	});
	return {
		dir,
		paths,
		store,
		service,
		client,
		calls,
		connect: (overrides = {}) => service.connect({ baseUrl: BASE_URL, account: "alice", password: "s3cret", syncMode: "personal", rememberSignIn: true, ...overrides }),
	};
}

/** 每个用例结束必须释放：service 可能带后台刷新定时器，不清会拖住测试进程。 */
function cleanup(harness) {
	harness.service.dispose();
	rmSync(harness.dir, { recursive: true, force: true });
}

test("连接成功：原子保存连接状态，配置/令牌文件按契约投影，扩展开关由用户操作触发", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	const result = await h.connect();
	assert.equal(result.ok, true);

	// 连接状态里没有明文密码（注入的 protect 只是包装，明文不得出现）
	const connection = readFileSync(h.paths.connectionFile, "utf8");
	assert.equal(connection.includes("s3cret"), false);
	const saved = JSON.parse(connection);
	assert.equal(saved.enabled, true);
	assert.equal(saved.account, "alice");
	assert.equal(saved.cloudInstanceId, validation.cloudInstanceIdFromOrigin(BASE_URL));
	assert.equal(saved.rememberSignIn, true);

	// 配置快照：既有字段 + 本次新增字段，全部绝对路径且落在 cloud-memory 内
	const config = JSON.parse(readFileSync(h.paths.configFile, "utf8"));
	assert.equal(config.enabled, true);
	assert.equal(config.mode, "personal");
	assert.equal(config.baseUrl, BASE_URL);
	assert.equal(config.account, "alice");
	assert.equal(config.cloudInstanceId, saved.cloudInstanceId);
	assert.equal(config.authFile, h.paths.authFile);
	assert.equal(config.logFile, h.paths.logFile);
	assert.equal(config.stateDir, h.paths.dataDir);
	assert.equal(config.personaCacheFile, h.paths.personaCacheFile);
	assert.equal(config.syncEnabled, true);
	for (const value of [config.authFile, config.logFile, config.stateDir, config.personaCacheFile]) assert.equal(value.startsWith(h.dir), true, `${value} 必须在 cloud-memory 目录内`);

	// 令牌文件带 account/cloudInstanceId 绑定（工具侧核对与 config 一致，防旧 config A 配新 token B）
	const auth = JSON.parse(readFileSync(h.paths.authFile, "utf8"));
	assert.equal(typeof auth.token, "string");
	assert.equal(auth.account, "alice");
	assert.equal(auth.cloudInstanceId, config.cloudInstanceId);
	assert.equal(auth.account, config.account);

	// 用户连接 = 用户操作：登记内置扩展（默认关闭的 opt-in）
	assert.deepEqual(h.calls.extensionSwitch, [true]);

	// 渲染层可见状态不含密码/令牌
	const status = await h.service.getStatus();
	assert.equal(status.state, "connected");
	assert.equal(status.credentialStored, true);
	const serialized = JSON.stringify(status);
	assert.equal(serialized.includes("s3cret"), false);
	assert.equal(serialized.includes("token-alice"), false);
});

test("登录失败：不写任何投影文件，也不动扩展开关", async (t) => {
	const h = createHarness({ client: createClient({ login: async () => ({ ok: false, error: { code: "unauthorized", message: "账号或密码不正确" } }) }) });
	t.after(() => cleanup(h));

	const result = await h.connect();
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "unauthorized");
	assert.equal(existsSync(h.paths.configFile), false);
	assert.equal(existsSync(h.paths.authFile), false);
	assert.equal(existsSync(h.paths.connectionFile), false);
	assert.deepEqual(h.calls.extensionSwitch, []);
});

test("whoami 账号不一致：中止保存（不落盘、不登记扩展）", async (t) => {
	const h = createHarness({ client: createClient({ whoami: async () => ({ ok: true, payload: { kind: "user", username: "bob", scopes: ["memory"] } }) }) });
	t.after(() => cleanup(h));

	const result = await h.connect();
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "principalMismatch");
	assert.equal(existsSync(h.paths.configFile), false);
	assert.deepEqual(h.calls.extensionSwitch, []);
});

test("safeStorage 不可用：拒绝保存凭据，不回退明文、不写连接文件", async (t) => {
	const h = createHarness({ encryption: false });
	t.after(() => cleanup(h));

	const result = await h.connect();
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "secureStorageUnavailable");
	assert.equal(existsSync(h.paths.connectionFile), false);
	assert.equal(existsSync(h.paths.authFile), false);
	const status = await h.service.getStatus();
	assert.equal(status.secureStorageAvailable, false);
	assert.equal(status.credentialStored, false);
});

test("配置 epoch 变化：在飞连接结果作废，不写入旧账号", async (t) => {
	let releaseLogin;
	const h = createHarness({
		client: createClient({
			login: () =>
				new Promise((resolve) => {
					releaseLogin = () => resolve({ ok: true, session: { token: "token-alice-1", account: "alice", scopes: ["memory"] } });
				}),
		}),
	});
	t.after(() => cleanup(h));

	const pending = h.connect();
	await Promise.resolve();
	await h.service.logout();
	releaseLogin();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internalError");
	assert.equal(existsSync(h.paths.configFile), false);
	const saved = JSON.parse(readFileSync(h.paths.connectionFile, "utf8"));
	assert.equal(saved.account, null);
});

test("账号切换：清掉旧账号的人格缓存，不把旧稿留给新账号", async (t) => {
	let currentAccount = "alice";
	const h = createHarness({
		client: createClient({
			login: async (_origin, account) => ({ ok: true, session: { token: `token-${account}`, account, scopes: ["memory"] } }),
			whoami: async () => ({ ok: true, payload: { kind: "user", username: currentAccount, scopes: ["memory"] } }),
		}),
	});
	t.after(() => cleanup(h));

	await h.connect();
	await h.service.refreshPersona({ force: true });
	assert.equal(existsSync(h.paths.personaCacheFile), true);
	assert.equal((await h.service.getStatus()).persona.account, "alice");

	currentAccount = "bob";
	const switched = await h.connect({ account: "bob", password: "other" });
	assert.equal(switched.ok, true);
	assert.equal(existsSync(h.paths.personaCacheFile), false);
	const status = await h.service.getStatus();
	assert.equal(status.account, "bob");
	assert.equal(status.persona, null);
});

test("人格刷新：哈希校验通过才写缓存，下一次读取为非离线（stale=false）", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	await h.connect();
	await h.service.refreshPersona({ force: true });
	const status = await h.service.getStatus();
	assert.ok(status.persona);
	assert.equal(status.persona.stale, false);
	assert.equal(status.persona.revision, validation.personaRevisionOf("默认人格：简洁、直接", true));
	const cached = JSON.parse(readFileSync(h.paths.personaCacheFile, "utf8"));
	assert.equal(cached.account, "alice");
	assert.equal(cached.cloudInstanceId, validation.cloudInstanceIdFromOrigin(BASE_URL));
	assert.equal(cached.fetched_at, "2026-10-13T08:00:00.000Z");
	assert.equal(typeof cached.raw_revision, "string");
});

test("人格哈希不符：拒绝写缓存并保留本地状态", async (t) => {
	const h = createHarness({ client: createClient({ persona: async () => ({ ok: true, payload: { ...personaPayload(), text: "被篡改的正文" } }) }) });
	t.after(() => cleanup(h));

	await h.connect();
	await h.service.refreshPersona({ force: true });
	const status = await h.service.getStatus();
	assert.equal(status.persona, null);
	assert.equal(existsSync(h.paths.personaCacheFile), false);
	assert.equal(status.lastError.code, "personaUnverified");
});

test("离线回退：新进程读缓存显示最近已确认稿并标 stale，状态为 error", async (t) => {
	const first = createHarness();
	await first.connect();
	await first.service.refreshPersona({ force: true });
	assert.equal(existsSync(first.paths.personaCacheFile), true);

	const offline = createHarness({
		dir: first.dir,
		client: createClient({
			whoami: async () => ({ ok: false, error: { code: "offline", message: "云端不可达" } }),
			persona: async () => ({ ok: false, error: { code: "offline", message: "云端不可达" } }),
		}),
	});
	t.after(() => {
		offline.service.dispose();
		cleanup(first);
	});
	await offline.service.initialize();
	await offline.service.refreshPersona({ force: true });
	const status = await offline.service.getStatus();
	assert.equal(status.state, "error");
	assert.equal(status.lastError.code, "offline");
	assert.ok(status.persona);
	assert.equal(status.persona.stale, true);
	assert.equal(status.persona.text, "默认人格：简洁、直接");
});

test("会话过期：只用已授权记住的密码重登，成功后刷新令牌文件，且不重复重登", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	await h.connect();
	// 等连接触发的后台刷新落地：否则它的重登会和本用例的计数断言竞态（非行为差异）
	await delay(20);
	assert.equal(h.client.counters.logins, 1);

	// 模拟云端会话过期：已签发令牌全部作废，只有重登拿到的新令牌可用
	h.client.invalidateSession();
	await h.service.refreshPersona({ force: true });
	assert.equal((await h.service.getStatus()).state, "connected");
	assert.equal(h.client.counters.logins, 2, "会话失效后按记住的密码重登一次");
	assert.notEqual(JSON.parse(readFileSync(h.paths.authFile, "utf8")).token, "token-alice-1", "重登后必须刷新令牌文件");

	// 已有有效会话：再刷新不得额外重登（重登只发生在认证失效时）
	await delay(20);
	const loginsAfterRecovery = h.client.counters.logins;
	await h.service.refreshPersona({ force: true });
	await delay(20);
	assert.equal(h.client.counters.logins, loginsAfterRecovery);
});

test("登出：撤销本地会话、删除令牌与人格缓存，保留地址账号", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	await h.connect();
	await h.service.refreshPersona({ force: true });
	const status = await h.service.logout();
	assert.equal(existsSync(h.paths.authFile), false);
	assert.equal(existsSync(h.paths.personaCacheFile), false);
	assert.equal(status.account, "alice");
	assert.equal(status.credentialStored, false);
	// 地址与账号仍保留：登出后的诚实状态是「需要重新连接」而不是「从未配置」
	assert.equal(status.state, "needsReconnect");
});

test("总开关：默认关闭；开启/关闭只经注入的设置写入入口，并提示需要新会话", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	const initial = await h.service.getStatus();
	assert.equal(initial.enabled, false);
	assert.equal(initial.state, "disabled");

	const enabled = await h.service.setEnabled(true);
	assert.equal(enabled.enabled, true);
	assert.equal(enabled.restartRequired, true);
	assert.deepEqual(h.calls.extensionSwitch, [true]);

	await h.service.setEnabled(false);
	assert.deepEqual(h.calls.extensionSwitch, [true, false]);
});

test("后台刷新：定时器按周期跑，dispose 后停止；并发刷新共享同一请求（去重）", async (t) => {
	let personaCalls = 0;
	const h = createHarness({
		personaRefreshIntervalMs: 20,
		client: createClient({
			persona: async () => {
				personaCalls += 1;
				return { ok: true, payload: personaPayload() };
			},
		}),
	});
	t.after(() => cleanup(h));

	await h.connect();
	await h.service.refreshPersona({ force: true });
	const baseCalls = personaCalls;

	// 去重：两次并发强制刷新只发一次请求，且拿到同一个结果
	const [first, second] = await Promise.all([h.service.refreshPersona({ force: true }), h.service.refreshPersona({ force: true })]);
	assert.equal(first, second);
	assert.equal(personaCalls, baseCalls + 1);

	// 定时器：等待若干周期后必须自己再刷（不需要界面 / 状态查询触发）
	await delay(70);
	const afterTimer = personaCalls;
	assert.ok(afterTimer > baseCalls + 1, "后台定时器必须按周期刷新人格版本");

	// dispose：停止定时器并拒绝后续触发
	h.service.dispose();
	await delay(70);
	assert.equal(personaCalls, afterTimer, "dispose 后不得再有后台刷新");
});

test("并发 connect → logout：晚到的登录结果作废；logout 不等网络撤销就清本地凭据", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));

	await h.connect();
	// 让后续登录永远挂起、撤销请求永远不返回（模拟登录慢 + 云端离线）
	let releaseLogin = () => undefined;
	let revokeCalls = 0;
	h.client.login = (_origin, account) =>
		new Promise((resolve) => {
			releaseLogin = () => resolve({ ok: true, session: { token: `token-${account}`, account, scopes: ["memory"] } });
		});
	h.client.logout = () => {
		revokeCalls += 1;
		return new Promise(() => undefined);
	};

	const pending = h.connect({ account: "bob", password: "bob-pw" });
	await delay(0);
	// logout 必须先完成本地清理并返回（若它 await 撤销，这个 await 会永远挂住）
	const status = await h.service.logout();
	assert.equal(revokeCalls, 1, "本地清理后仍要 best-effort 撤销服务端会话");
	assert.equal(status.credentialStored, false);
	assert.equal(existsSync(h.paths.authFile), false);

	releaseLogin();
	const late = await pending;
	assert.equal(late.ok, false);
	assert.equal(late.error.code, "internalError");
	const saved = JSON.parse(readFileSync(h.paths.connectionFile, "utf8"));
	assert.equal(saved.account, "alice", "晚到的登录结果不得把 bob 写进去；登出保留原账号便于重新登录");
	assert.equal(saved.protectedToken, undefined, "登出后不得留下会话令牌");
});

test("投影写失败：connect 如实返回失败，不声称 connected", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));
	// 用目录占住令牌文件路径，让原子 rename 必然失败
	mkdirSync(h.paths.authFile, { recursive: true });

	const result = await h.connect();
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internalError");
	// 令牌先写、配置后写：令牌写失败时不能留下「已启用」的配置
	assert.equal(existsSync(h.paths.configFile), false);
	const status = await h.service.getStatus();
	assert.notEqual(status.state, "connected");
	assert.equal(status.lastError?.code, "internalError");
});

test("人格版本：切账号后旧账号在飞的刷新结果不覆盖新版本", async (t) => {
	let currentAccount = "alice";
	let releaseSlowPersona = () => undefined;
	const h = createHarness({
		client: createClient({
			login: async (_origin, account) => ({ ok: true, session: { token: `token-${account}`, account, scopes: ["memory"] } }),
			whoami: async () => ({ ok: true, payload: { kind: "user", username: currentAccount, scopes: ["memory"] } }),
			persona: async () => ({ ok: true, payload: personaPayload({ text: "alice 的人格" }) }),
		}),
	});
	t.after(() => cleanup(h));

	await h.connect();
	// 让 alice 的刷新挂在网上（慢请求）
	h.client.persona = () =>
		new Promise((resolve) => {
			releaseSlowPersona = () => resolve({ ok: true, payload: personaPayload({ text: "alice 的旧版本" }) });
		});
	const slow = h.service.refreshPersona({ force: true });
	await delay(0);

	// 切到 bob：意图 epoch 立刻变化，bob 自己的刷新用正常响应
	currentAccount = "bob";
	h.client.persona = async () => ({ ok: true, payload: personaPayload({ text: "bob 的人格" }) });
	await h.connect({ account: "bob", password: "bob-pw" });
	await h.service.refreshPersona({ force: true });

	// 旧请求此刻才返回：必须被丢弃，不能覆盖 bob 的版本
	releaseSlowPersona();
	await slow;
	const status = await h.service.getStatus();
	assert.equal(status.persona?.text, "bob 的人格");
	const cached = JSON.parse(readFileSync(h.paths.personaCacheFile, "utf8"));
	assert.equal(cached.text, "bob 的人格");
	assert.equal(cached.account, "bob");
});

test("写失败：登出不得伪称完成（lastError=error、不发撤销、不静默丢凭据）", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));
	await h.connect();
	let revokeCalls = 0;
	h.client.logout = async () => {
		revokeCalls += 1;
		return { ok: true };
	};
	// 让连接状态文件无法原子替换（目录占位）
	rmSync(h.paths.connectionFile, { force: true });
	mkdirSync(h.paths.connectionFile, { recursive: true });

	const status = await h.service.logout();
	assert.equal(status.lastError?.code, "internalError");
	assert.equal(status.state, "error", "写失败必须显示 error");
	assert.equal(revokeCalls, 0, "本地没清干净就不去撤销（避免留下半套状态）");
	assert.equal(existsSync(h.paths.authFile), true, "凭据不能被静默丢掉");
});

test("写失败：setEnabled 持久化失败不 apply 扩展开关", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));
	rmSync(h.paths.connectionFile, { force: true });
	mkdirSync(h.paths.connectionFile, { recursive: true });

	const status = await h.service.setEnabled(true);
	assert.equal(status.enabled, false, "落盘失败不得声称已启用");
	assert.equal(status.lastError?.code, "internalError");
	assert.equal(status.state, "error");
	assert.deepEqual(h.calls.extensionSwitch, [], "持久化失败不得登记内置扩展");
});

test("自动重登：令牌落盘失败不声称会话可用", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));
	await h.connect();
	// 等连接触发的后台刷新落地，避免它把本次强制刷新去重掉（非行为差异）
	await delay(20);
	const tokenBefore = JSON.parse(readFileSync(h.paths.authFile, "utf8")).token;
	h.client.invalidateSession();
	rmSync(h.paths.connectionFile, { force: true });
	mkdirSync(h.paths.connectionFile, { recursive: true });

	await h.service.refreshPersona({ force: true });
	const status = await h.service.getStatus();
	assert.equal(status.state, "error");
	assert.equal(status.lastError?.code, "internalError");
	assert.equal(JSON.parse(readFileSync(h.paths.authFile, "utf8")).token, tokenBefore, "落盘失败时不得刷新令牌投影");
});

test("真实异步竞态：慢写盘期间切意图，旧任务既不覆盖新状态也不报用户可见错", async (t) => {
	const h = createHarness({ slowWriteMs: 30 });
	t.after(() => cleanup(h));
	await h.connect();

	// bob 的 commit 已在队列里慢写盘（真实 await 窗口），此时用户登出
	const pending = h.connect({ account: "bob", password: "bob-pw" });
	await delay(5);
	const logoutStatus = await h.service.logout();
	const late = await pending;

	assert.equal(late.ok, false);
	assert.equal(late.error.code, "internalError", "过期结果按「结果作废」处理");
	assert.equal(logoutStatus.lastError, null, "登出本身成功：过期任务不得污染 lastError");
	const saved = JSON.parse(readFileSync(h.paths.connectionFile, "utf8"));
	assert.equal(saved.account, "alice", "旧任务不得把 bob 留在磁盘上");
	assert.equal(saved.protectedToken, undefined);
	assert.equal(existsSync(h.paths.authFile), false);
});

test("原生状态：采纳即推送状态变化，未采纳不推送（设置页开着也能自己刷新）", async (t) => {
	const h = createHarness();
	t.after(() => cleanup(h));
	await h.connect();
	await delay(20);
	const before = h.calls.statusChanged;
	const binding = { agentId: "a1", sessionId: "pi-session-1", deckSessionId: "deck-1", runtimeGeneration: 1 };
	const payload = {
		schema: "pi-deck-cloud-memory-status",
		version: 1,
		kind: "sync",
		status: "ok",
		at: new Date().toISOString(),
		sessionId: "pi-session-1",
		account: "alice",
		cloudInstanceId: validation.cloudInstanceIdFromOrigin(BASE_URL),
		deviceId: "dev-1",
		pendingCount: 2,
		state: "idle",
	};
	assert.equal(h.service.ingestNativeStatus(binding, payload), true);
	assert.equal(h.calls.statusChanged, before + 1, "采纳原生状态后必须推送变化");
	assert.equal(h.service.getNativeSummary()?.pendingCount, 2);
	assert.equal(h.service.ingestNativeStatus(binding, { schema: "other" }), false);
	assert.equal(h.calls.statusChanged, before + 1, "未采纳不得推送");
});
