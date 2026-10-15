import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { QuotaAccountConfig, validQuotaInput } = loadTsCommonJs("src/main/config/quotaAccountConfig.ts");
const { AccountUsageService } = loadTsCommonJs("src/main/accountUsage/AccountUsageService.ts", { stubs: { electron: { net: {} } } });
const { parseQuotaWindows } = loadTsCommonJs("src/main/accountUsage/quotaParsers.ts");
const { readQuotaLocalCredential } = loadTsCommonJs("src/main/config/quotaLocalCredentials.ts");
const { primaryQuotaWindow, quotaCountdown } = loadTsCommonJs("src/renderer/src/utils/accountUsageDisplay.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const cipher = { encrypt: (value) => Buffer.from(value).toString("base64"), decrypt: (value) => Buffer.from(value, "base64").toString() };
const input = (name, credential = "test-secret-one") => ({ provider: "opencode-go", name, source: "manual", visible: true, region: "cn", credential });
const usage = (percent) => ({ status: 200, raw: JSON.stringify({ usage: { rolling: { percent, resetsAt: "2030-01-02T00:00:00Z" }, weekly: { percent: 0 } } }) });
async function fixture(t, request = async () => usage(13), readCredential = async () => undefined) {
	const root = await mkdtemp(join(tmpdir(), "tpa-quota-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "quota.json");
	const config = new QuotaAccountConfig(path, cipher);
	await config.write([]);
	return { root, path, config, service: new AccountUsageService(config, request, readCredential) };
}
test("OpenCode Go keeps zero usage and reset times without inventing missing windows", () => {
	const windows = plain(parseQuotaWindows("opencode-go", JSON.parse(usage(0).raw)));
	assert.equal(windows[0].usedPercent, 0);
	assert.equal(windows[0].resetsAt, Date.parse("2030-01-02T00:00:00Z"));
	assert.equal(windows.length, 2);
});
test("Codex labels known five-hour and weekly windows and converts seconds to milliseconds", () => {
	const windows = plain(parseQuotaWindows("codex", { rate_limit: { primary_window: { used_percent: 13, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: { used_percent: 97, limit_window_seconds: 604800 } } }));
	assert.deepEqual(windows, [
		{ key: "rolling", usedPercent: 13, resetsAt: 1800000000000 },
		{ key: "weekly", usedPercent: 97 },
	]);
});
test("GLM percentage-only responses do not turn an unreported count into zero", () => {
	assert.deepEqual(plain(parseQuotaWindows("glm", { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, percentage: 65, nextResetTime: 1800000000000 }] } })), [{ key: "rolling", usedPercent: 65, resetsAt: 1800000000000 }]);
});
test("Grok preserves separate subscription and on-demand windows", () => {
	const windows = plain(parseQuotaWindows("grok", { config: { creditUsagePercent: 2, onDemandCap: { val: "1000" }, onDemandUsed: { val: "500" } } }));
	assert.equal(windows.length, 2);
	assert.equal(windows[0].usedPercent, 2);
	assert.equal(windows[1].usedPercent, 50);
});
test("unknown and malformed quota shapes remain unknown", () => {
	for (const provider of ["codex", "opencode-go", "glm", "grok"]) assert.equal(parseQuotaWindows(provider, { rate_limit: {}, usage: { rolling: { percent: null } } }).length, 0);
});
test("summary selects the tightest remaining quota and countdown never goes negative", () => {
	assert.equal(
		primaryQuotaWindow({
			status: "ready",
			windows: [
				{ key: "weekly", usedPercent: 90 },
				{ key: "rolling", usedPercent: 10 },
			],
		}).key,
		"weekly",
	);
	assert.equal(primaryQuotaWindow({ status: "error", windows: [{ usedPercent: 90 }] }), undefined);
	assert.equal(quotaCountdown(0, 1000), "0m");
	assert.equal(quotaCountdown(undefined, 0), undefined);
	assert.equal(quotaCountdown(86400000 + 3600000, 0), "1d 1h");
});
test("two OpenCode accounts use independent credentials, ids and results", async (t) => {
	const calls = [];
	const { service, path } = await fixture(t, async (_url, init) => {
		calls.push(init.headers.Authorization);
		return usage(init.headers.Authorization.endsWith("one") ? 13 : 97);
	});
	await service.save(input("Go 一号"));
	await service.save(input("Go 二号", "test-secret-two"));
	const snapshot = await service.refresh();
	assert.equal(snapshot.accounts.length, 2);
	assert.notEqual(snapshot.accounts[0].id, snapshot.accounts[1].id);
	assert.equal(snapshot.results[snapshot.accounts[0].id].windows[0].usedPercent, 13);
	assert.equal(snapshot.results[snapshot.accounts[1].id].windows[0].usedPercent, 97);
	assert.deepEqual(calls, ["Bearer test-secret-one", "Bearer test-secret-two"]);
	assert.doesNotMatch(JSON.stringify(snapshot), /test-secret|accountId|secret/);
	assert.doesNotMatch(await readFile(path, "utf8"), /test-secret/);
});
test("concurrent saves do not lose an account", async (t) => {
	const { service } = await fixture(t);
	await Promise.all([service.save(input("One")), service.save(input("Two"))]);
	assert.equal((await service.list()).accounts.length, 2);
});
test("blank credential on edit preserves the saved key and hidden accounts are not polled", async (t) => {
	let calls = 0;
	const { service } = await fixture(t, async () => {
		calls++;
		return usage(1);
	});
	const saved = await service.save(input("One"));
	const account = saved.accounts[0];
	await service.save({ ...account, visible: false, credential: "" });
	await service.refresh();
	assert.equal(calls, 0);
	const refreshed = await service.refresh(account.id);
	assert.equal(calls, 1);
	assert.equal(refreshed.results[account.id].status, "ready");
});
test("replacing credentials invalidates an in-flight result", async (t) => {
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const { service } = await fixture(t, () => {
		started();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const {
		accounts: [account],
	} = await service.save(input("One"));
	const pending = service.refresh(account.id);
	await ready;
	await service.save({ ...account, credential: "replacement" });
	release(usage(97));
	assert.equal((await pending).results[account.id], undefined);
});
test("removing an account invalidates late requests and persists an empty roster", async (t) => {
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const { service } = await fixture(t, () => {
		started();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const {
		accounts: [account],
	} = await service.save(input("One"));
	const pending = service.refresh(account.id);
	await ready;
	await service.remove(account.id);
	release(usage(13));
	const snapshot = await pending;
	assert.equal(snapshot.accounts.length, 0);
	assert.deepEqual(plain(snapshot.results), {});
});
test("unauthorized errors never expose response bodies or credentials", async (t) => {
	const { service } = await fixture(t, async () => ({ status: 401, raw: "secret upstream detail test-secret-one" }));
	await service.save(input("One"));
	const snapshot = await service.refresh();
	assert.equal(Object.values(snapshot.results)[0].error, "unauthorized");
	assert.doesNotMatch(JSON.stringify(snapshot), /test-secret|upstream/);
});
test("unavailable encryption refuses to store a manual credential", async (t) => {
	const { config, path } = await fixture(t);
	const service = new AccountUsageService(
		new QuotaAccountConfig(path, {
			...cipher,
			encrypt() {
				throw new Error("no keyring");
			},
		}),
	);
	assert.equal((await service.save(input("One"))).error, "encryption");
	assert.equal((await config.load()).length, 0);
});
test("corrupt config fails closed without overwriting the file", async (t) => {
	const { path, service } = await fixture(t);
	await writeFile(path, "corrupt original");
	assert.equal((await service.save(input("One"))).error, "storage");
	assert.equal(await readFile(path, "utf8"), "corrupt original");
});
test("boundary rejects invalid identities, providers and header injection", () => {
	assert.equal(validQuotaInput(input("One")), true);
	for (const patch of [{ provider: "unknown" }, { id: "../auth" }, { credential: "key\r\nAuthorization: evil" }, { name: "" }, { visible: "yes" }]) assert.equal(validQuotaInput({ ...input("One"), ...patch }), false);
});
test("local Codex credentials are read without rewriting the native file", async (t) => {
	const { root } = await fixture(t);
	await mkdir(join(root, ".codex"));
	const path = join(root, ".codex", "auth.json");
	const original = JSON.stringify({ tokens: { access_token: "local-token", account_id: "account-a" } });
	await writeFile(path, original);
	const credential = await readQuotaLocalCredential({ provider: "codex" }, root, {});
	assert.deepEqual(plain(credential), { token: "local-token", accountId: "account-a" });
	assert.equal(await readFile(path, "utf8"), original);
});

test("malformed upstream JSON is reported as unsupported instead of a credential failure", async (t) => {
	const { service } = await fixture(t, async () => ({ status: 200, raw: "<html>sign in</html>" }));
	await service.save(input("One"));
	assert.equal(Object.values((await service.refresh()).results)[0].error, "unsupported");
});

test("concurrent refreshes for the same account share one provider request", async (t) => {
	let calls = 0;
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const { service } = await fixture(t, async () => {
		calls++;
		started();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const {
		accounts: [account],
	} = await service.save(input("One"));
	const one = service.refresh(account.id);
	await ready;
	const two = service.refresh(account.id);
	await new Promise((resolve) => setTimeout(resolve, 20));
	release(usage(13));
	await Promise.all([one, two]);
	assert.equal(calls, 1);
});

test("Grok accepts the top-level billing shape and keeps reset periods separate", () => {
	const windows = parseQuotaWindows("grok", { creditUsagePercent: 2, currentPeriod: { end: "2030-01-02T00:00:00Z" }, billingPeriodEnd: "2030-01-30T00:00:00Z", onDemandCap: { val: 100 }, onDemandUsed: { val: 10 } });
	assert.equal(windows[0].resetsAt, Date.parse("2030-01-02T00:00:00Z"));
	assert.equal(windows[1].resetsAt, Date.parse("2030-01-30T00:00:00Z"));
});
