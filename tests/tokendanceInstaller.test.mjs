import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 加载真实 TS 依赖图（installer 经 providerCompat 复用 pi 侧写盘策略）
const installer = loadTsCommonJs("src/main/config/tokendanceInstaller.ts");

/** 目录 store 替身：getModels/refresh 返回固定目录（免真实网络）；refresh 默认成功。 */
function makeCatalog(models = [{ id: "glm-4.7" }, { id: "deepseek-v4-flash", contextWindow: 128000 }]) {
	let refreshCount = 0;
	return {
		getModels: async () => ({ models, fromCache: false, at: 1700000000000 }),
		refresh: async () => {
			refreshCount += 1;
			return { models, fromCache: false, at: 1700000000000 };
		},
		_refreshCount: () => refreshCount,
	};
}

/** 按 id 取模型行：保存列表已按名称排序，断言不再依赖入参顺序。 */
function byId(models, id) {
	const found = models.find((model) => model.id === id);
	assert.ok(found, `model ${id} missing from ${JSON.stringify(models.map((m) => m.id))}`);
	return found;
}

/** ConfigManager 替身：内存版 models.json（save 后可从 _dump 读回断言）。 */
function makeConfigManager(initialProviders = {}) {
	let providers = { ...initialProviders };
	return {
		getModelsConfig: async () => ({ parsed: { providers } }),
		getAuthConfig: async () => ({ parsed: {} }),
		saveModelsConfig: async (next) => {
			providers = { ...(next?.providers ?? {}) };
			return { valid: true };
		},
		_dump: () => providers,
	};
}

test("一键安装：pi models.json 写入 provider（baseUrl/归因头/模型）", async () => {
	const configManager = makeConfigManager();
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: makeCatalog() }, {});
	assert.equal(result.ok, true);
	assert.equal(result.modelCount, 2);
	assert.equal(result.piSaved, true);

	const provider = configManager._dump()["tokendance"];
	assert.equal(provider.baseUrl, "https://tokendance.space/gateway/v1");
	assert.equal(provider.api, "openai-completions");
	// 请求维度归因：X-App-URL 覆盖 Key 上的 app_url
	assert.equal(provider.headers["X-App-URL"], "https://pideck.caoayu.top/");
	assert.equal(provider.models.length, 2);
	// 保存顺序与模型下拉列表一致（按名称/id 正序）：deepseek-v4-flash 排在 glm-4.7 之前
	assert.deepEqual(
		provider.models.map((m) => m.id),
		["deepseek-v4-flash", "glm-4.7"],
	);
	assert.equal(byId(provider.models, "deepseek-v4-flash").contextWindow, 128000);
});

test("传入 apiKey：写入 pi provider.apiKey（与 ModelsTab 编辑器一致）", async () => {
	const configManager = makeConfigManager();
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: makeCatalog() }, { apiKey: "sk-test-123" });
	assert.equal(result.ok, true);
	assert.equal(configManager._dump()["tokendance"].apiKey, "sk-test-123");
});

test("幂等：models.json 已有 tokendance 条目时保留既有 apiKey，仅更新模型/端点", async () => {
	const configManager = makeConfigManager({
		tokendance: { apiKey: "sk-old", models: [], baseUrl: "https://old.example/v1" },
	});
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: makeCatalog() }, {});
	assert.equal(result.ok, true);
	const provider = configManager._dump()["tokendance"];
	assert.equal(provider.apiKey, "sk-old", "用户已有 Key 不应被覆盖");
	assert.equal(provider.baseUrl, "https://tokendance.space/gateway/v1");
	assert.equal(provider.models.length, 2);
});

test("目录为空：返回 ok=false，不写任何配置", async () => {
	const configManager = makeConfigManager();
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: makeCatalog([]) }, {});
	assert.equal(result.ok, false);
	assert.equal(result.piSaved, false);
	assert.equal(Object.keys(configManager._dump()).length, 0);
});

test("写盘失败：返回 ok=false 且带错误原因", async () => {
	const configManager = makeConfigManager();
	configManager.saveModelsConfig = async () => ({ valid: false, error: "disk full" });
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: makeCatalog() }, {});
	assert.equal(result.ok, false);
	assert.equal(result.piSaved, false);
	assert.equal(result.error, "disk full");
});

test("contextWindow 非正整数（0）不写入：pi 报 invalid contextWindow 会拒绝整个 provider", async () => {
	const configManager = makeConfigManager();
	const result = await installer.installTokendanceProvider(
		{
			configManager,
			tokendanceCatalog: makeCatalog([
				{ id: "seedream-5.0-lite", contextWindow: 0 },
				{ id: "glm-4.7", contextWindow: 200000 },
			]),
		},
		{},
	);
	assert.equal(result.ok, true);
	// 排序后位置会变（glm 排在 seedream 前），按 id 取行断言字段而非依赖下标
	const savedModels = configManager._dump()["tokendance"].models;
	assert.equal(byId(savedModels, "seedream-5.0-lite").contextWindow, undefined);
	assert.equal(byId(savedModels, "glm-4.7").contextWindow, 200000);
});

test("安装前强制 refresh 目录（旧缓存可能含坏数据；refresh 失败降级 getModels）", async () => {
	const configManager = makeConfigManager();
	const catalog = makeCatalog();
	const result = await installer.installTokendanceProvider({ configManager, tokendanceCatalog: catalog }, {});
	assert.equal(result.ok, true);
	assert.equal(catalog._refreshCount(), 1);
});

test("catalogLookup：目录命中时补 maxTokens/reasoning/input/thinkingLevelMap，未命中不写", async () => {
	const configManager = makeConfigManager();
	const result = await installer.installTokendanceProvider(
		{
			configManager,
			tokendanceCatalog: makeCatalog([{ id: "glm-4.7", name: "Z.ai: GLM 4.7", contextWindow: 200000 }, { id: "qq-custom-model" }]),
			catalogLookup: (modelId) => {
				if (modelId === "glm-4.7") {
					return {
						id: "glm-4.7",
						provider: "zai",
						maxTokens: 131072,
						reasoning: true,
						input: ["text"],
						thinkingLevelMap: { off: "off", high: "high" },
					};
				}
				return undefined;
			},
		},
		{},
	);
	assert.equal(result.ok, true);
	const saved = configManager._dump()["tokendance"].models;
	const hit = byId(saved, "glm-4.7");
	const miss = byId(saved, "qq-custom-model");
	// 目录权威：contextWindow 用 TokenDance 实报值，即使 catalog 不同也以平台为准
	assert.equal(hit.contextWindow, 200000);
	assert.equal(hit.maxTokens, 131072);
	assert.equal(hit.reasoning, true);
	// vm 跨 realm 数组 prototype 不同，deepStrictEqual 会因引用不等误报，用快照比较
	assert.equal(JSON.stringify(hit.input), JSON.stringify(["text"]));
	assert.equal(JSON.stringify(hit.thinkingLevelMap), JSON.stringify({ off: "off", high: "high" }));
	// 未命中目录的模型不写能力字段（不猜默认值，保持 omit）
	assert.equal(miss.maxTokens, undefined);
	assert.equal(miss.reasoning, undefined);
	assert.equal(miss.thinkingLevelMap, undefined);
});
