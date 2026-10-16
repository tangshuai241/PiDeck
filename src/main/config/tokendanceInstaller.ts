/**
 * TokenDance 一键安装：把供应商信息 + 目录模型写入 pi 配置。
 *
 * 设计动机（对应用户可见的「确认后写入配置文件」流程）：
 * - 不依赖任何展示层注入：模型写入 models.json 后，由 pi 运行时自行解析，配置页
 *   模型列表、会话模型选择、用量查询全部走既有链路，无需特判。
 * - 幂等：重复安装以同一份目录覆盖模型（只做 upsert，保留已有 provider 时用户手工
 *   调整的字段；models 目录更新时合并）。
 * - Key 落点跟随 mergePiProvider 惯例：内联写 models.json provider.apiKey，与
 *   ModelsTab 编辑器一致（曾写 auth.json 造成迁移后 key 显示为空的 bug）。
 * - DSH 侧写入已随 DSH 运行能力移除，不再保留任何写 DSH settings/凭据的入口。
 */
import { TOKENDANCE_APP_URL, TOKENDANCE_APP_URL_HEADER, TOKENDANCE_BASE_URL, TOKENDANCE_PROVIDER } from "../../shared/tokendance";
// 落盘前统一排序：目录/缓存旧数据可能仍是平台返回顺序，写入 models.json 必须与下拉列表一致。
import { sortModelRows } from "../../shared/modelOrder";
import type { AvailableModel } from "../../shared/types";
import { mergePiProvider, type PiProviderSnapshot } from "./providerCompat";
import type { ConfigManager, PiModelItem } from "./ConfigManager";
import type { TokendanceCatalogStore } from "./tokendanceCatalog";
import type { PiAiCatalogEntry } from "../pi/piAiBuiltinCatalog";

/**
 * 按模型 id 从 pi-ai 目录补能力字段（maxTokens/reasoning/input/thinkingLevelMap）。
 * TokenDance /models 只下 id/name/context_length/supported_protocols，没有这些字段；
 * 不补的话配置页表格「最大 Token/能力」大量空白，且 pi 侧无从得知思考档位映射。
 * 依赖注入便于单测（测试传 stub），主进程装配时接 getPiAiCatalogIndex+lookupPiAiCatalogEntry。
 */
export type TokendanceCatalogLookup = (modelId: string) => PiAiCatalogEntry | undefined;

export type TokendanceInstallResult = {
	ok: boolean;
	/** 本次写入的模型数（目录为空时为 0 且 ok=false）。 */
	modelCount: number;
	/** pi models.json 是否已写入（含 Key upsert）。 */
	piSaved: boolean;
	error?: string;
};

export type TokendanceInstallDeps = {
	configManager: Pick<ConfigManager, "getModelsConfig" | "getAuthConfig" | "saveModelsConfig">;
	tokendanceCatalog: TokendanceCatalogStore;
	/** 能力字段补全（可选）：未提供时只写目录实报字段。 */
	catalogLookup?: TokendanceCatalogLookup;
};

/**
 * 执行安装：目录 → pi models.json（merge upsert）。写盘失败即返回 ok=false
 * （错误信息原样上抛，由 IPC 边界转结构化结果，不泄露 Key）。
 */
export async function installTokendanceProvider(deps: TokendanceInstallDeps, options: { apiKey?: string } = {}): Promise<TokendanceInstallResult> {
	// 安装前强制刷新目录：旧缓存可能含已废弃的行（如 2026-09 曾写入 context_length=0
	// 的模型导致 pi 拒绝整个 provider）；刷新失败（断网/超时）降级用旧缓存，不让目录消失。
	let catalogResult;
	try {
		catalogResult = await deps.tokendanceCatalog.refresh();
	} catch {
		catalogResult = await deps.tokendanceCatalog.getModels();
	}
	if (!catalogResult || catalogResult.models.length === 0) {
		return {
			ok: false,
			modelCount: 0,
			piSaved: false,
			error: "TokenDance catalog unavailable",
		};
	}

	const apiKey = typeof options.apiKey === "string" && options.apiKey.trim() ? options.apiKey.trim() : undefined;
	const rawPiModels: PiModelItem[] = catalogResult.models.map((model: AvailableModel) => {
		const row: PiModelItem = { id: model.id };
		// 目录条目是网络数据，逐字段收窄后落盘（name/contextWindow 缺失时省略）；
		// contextWindow 必须正整数：pi 报 invalid contextWindow 会拒绝整个 provider。
		if (typeof model.name === "string" && model.name.trim()) row.name = model.name.trim();
		if (typeof model.contextWindow === "number" && Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
			row.contextWindow = model.contextWindow;
		}
		// 能力字段从 pi-ai 目录补：目录权威（contextWindow 以平台实报为准），
		// 目录命中时补 maxTokens/reasoning/input/thinkingLevelMap；命中不在数据即省略（不猜默认值）。
		const entry = deps.catalogLookup?.(model.id);
		if (entry) {
			if (typeof entry.maxTokens === "number" && Number.isFinite(entry.maxTokens)) row.maxTokens = entry.maxTokens;
			if (typeof entry.reasoning === "boolean") row.reasoning = entry.reasoning;
			if (Array.isArray(entry.input) && entry.input.length > 0) row.input = [...entry.input];
			if (entry.thinkingLevelMap) row.thinkingLevelMap = { ...entry.thinkingLevelMap };
		}
		return row;
	});

	// pi 侧：merge upsert，保留用户已有条目（apiKey 等），模型以目录为准覆盖。
	// 排序放在写盘前：refresh 失败降级用旧缓存时（缓存可能存的是未排序的旧版本）也能拿到有序列表。
	const piModels = sortModelRows(rawPiModels);
	const piSnapshot: PiProviderSnapshot = {
		name: TOKENDANCE_PROVIDER,
		baseUrl: TOKENDANCE_BASE_URL,
		api: "openai-completions",
		// 请求维度归因：TokenDance 平台按 X-App-URL 将调用计入 PiDeck（覆盖 Key 归因）
		headers: { [TOKENDANCE_APP_URL_HEADER]: TOKENDANCE_APP_URL },
		models: piModels,
		apiKey,
	};
	const [modelsConfig, authConfig] = await Promise.all([deps.configManager.getModelsConfig(), deps.configManager.getAuthConfig()]);
	const merged = mergePiProvider({ providers: modelsConfig.parsed.providers ?? {} }, authConfig.parsed, piSnapshot);
	const saveResult = await deps.configManager.saveModelsConfig(merged.models as never);
	if (!saveResult.valid) {
		return {
			ok: false,
			modelCount: piModels.length,
			piSaved: false,
			error: saveResult.error ?? "failed to save models.json",
		};
	}
	return { ok: true, modelCount: piModels.length, piSaved: true };
}
