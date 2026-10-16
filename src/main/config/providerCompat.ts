/**
 * pi 供应商配置兼容工具（从已移除的 pi↔DSH 迁移模块迁出的 pi 侧子集）。
 *
 * 只保留 pi 配置读写仍需要的能力：凭据 ref 推导、provider 名校验、pi-ai catalog
 * snapshot、密钥解析与 models.json 合并。DSH 迁移/转换逻辑已随 DSH 运行能力移除，
 * 不再保留任何写 DSH settings/凭据的入口。
 */
import type { PiAuthItem, PiModelItem, PiProviderConfig } from "./ConfigManager";

const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stableRouteDigest(value: string): string {
	let hash = 2166136261;
	for (const character of value) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
	}
	return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** 从 provider 配置与 route id 推导 PiDeck 自有的凭据引用名（保留旧命名规则）。 */
export function credentialRefFor(profile: { apiKeyEnv?: unknown } | undefined, routeId: string): string {
	const explicit = typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv.trim() ? profile.apiKeyEnv.trim() : "";
	if (explicit) return explicit;
	if (PROVIDER_NAME_PATTERN.test(routeId)) {
		const conventional = `${routeId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
		if (CREDENTIAL_REF_PATTERN.test(conventional)) return conventional;
	}
	return `PIDECK_${stableRouteDigest(routeId)}_API_KEY`;
}

export function isSafeProviderName(name: unknown): name is string {
	return typeof name === "string" && PROVIDER_NAME_PATTERN.test(name);
}

/** models.json 里该 provider 的 compat 白名单子集（pi 侧写入/回写用）。 */
export type ProviderCompatFlags = {
	supportsDeveloperRole?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
};

/**
 * compat 对象原样取出（保留 pi 侧自定义键，如 thinkingFormat）；非法值退化为空对象。
 */
function asCompatRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return { ...(value as Record<string, unknown>) };
}

/** 从任意来源（models.json 的 compat 对象）收窄出 PiDeck 管理的两个布尔；无有效键时返回 undefined。 */
export function asProviderCompatFlags(value: unknown): ProviderCompatFlags | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const rec = value as Record<string, unknown>;
	const flags: ProviderCompatFlags = {};
	if (typeof rec.supportsDeveloperRole === "boolean") {
		flags.supportsDeveloperRole = rec.supportsDeveloperRole;
	}
	if (typeof rec.requiresReasoningContentOnAssistantMessages === "boolean") {
		flags.requiresReasoningContentOnAssistantMessages = rec.requiresReasoningContentOnAssistantMessages;
	}
	return Object.keys(flags).length > 0 ? flags : undefined;
}

export type PiProviderSnapshot = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	/** models.json 里该 provider 的 compat（已收窄为白名单子集）。 */
	compat?: ProviderCompatFlags;
	models: PiModelItem[];
	/** Snapshot 由 pi-ai 内置 catalog 合成（auth.json 只有 key、models.json 无条目）。 */
	catalogOnly?: boolean;
};

/**
 * pi-ai catalog 里一个 provider 的模型条目视图（防跨层强依赖；只取构造 snapshot 需要的字段）。
 */
export type PiBuiltinCatalogView = {
	byProviderId: Map<
		string,
		Map<
			string,
			{
				id: string;
				name?: string;
				contextWindow?: number;
				maxTokens?: number;
				reasoning?: boolean;
				input?: string[];
				api?: string;
				baseUrl?: string;
			}
		>
	>;
};

/**
 * 从 pi-ai catalog 构造某个内置 provider 的 snapshot（auth.json 里只有 key、
 * models.json 无条目时的来源）。catalog 无该 provider / 无可用模型时返回 undefined。
 */
export function piBuiltinSnapshotFromCatalog(name: string, apiKey: string | undefined, catalog: PiBuiltinCatalogView): PiProviderSnapshot | undefined {
	const inner = catalog.byProviderId.get(name);
	if (!inner || inner.size === 0) return undefined;
	const entries = [...inner.values()];
	const first = entries[0];
	if (!first) return undefined;
	const models: PiModelItem[] = [];
	for (const entry of entries) {
		const row: PiModelItem = { id: entry.id.trim() };
		if (typeof entry.name === "string" && entry.name.trim()) row.name = entry.name.trim();
		if (entry.contextWindow != null) row.contextWindow = entry.contextWindow;
		if (entry.maxTokens != null) row.maxTokens = entry.maxTokens;
		if (entry.reasoning === true) row.reasoning = true;
		if (entry.input && entry.input.length > 0) row.input = entry.input;
		models.push(row);
	}
	return {
		name: name.trim(),
		baseUrl: typeof first.baseUrl === "string" ? first.baseUrl.trim() : undefined,
		api: typeof first.api === "string" ? first.api.trim() : "openai-completions",
		apiKey: apiKey?.trim() || undefined,
		models,
		catalogOnly: true,
	};
}

export function resolvePiApiKey(provider: PiProviderConfig | undefined, auth: PiAuthItem | undefined): string | undefined {
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
	if (inline) return inline;
	const fromAuth = typeof auth?.key === "string" ? auth.key.trim() : "";
	if (fromAuth) return fromAuth;
	// OAuth 凭据（type:"oauth"，Codex/xAI/Copilot 等消费者订阅）：access token 就是 pi
	// 会话里实际使用的凭据，用量/余额端点接受同一 Bearer token。放在最后兜底，避免
	// 覆盖有显式 key 的 provider；凭据不完整（无 access）时返回 undefined，由上层快速失败。
	if (auth && typeof auth === "object" && auth.type === "oauth") {
		const access = typeof auth.access === "string" ? auth.access.trim() : "";
		if (access) return access;
	}
	return undefined;
}

/** 把 snapshot 合并回 pi models.json + auth（供配置导入类功能复用）。 */
export function mergePiProvider(
	models: { providers: Record<string, PiProviderConfig> },
	auth: Record<string, PiAuthItem>,
	snapshot: PiProviderSnapshot,
): {
	models: { providers: Record<string, PiProviderConfig> };
	auth: Record<string, PiAuthItem>;
} {
	const existing = models.providers[snapshot.name];
	// compat 逐键合并：只覆盖白名单键，保留 pi 侧手写的其它 compat 子键；对方没给时整套保留原值。
	const mergedCompat = snapshot.compat ? { ...asCompatRecord(existing?.compat), ...snapshot.compat } : undefined;
	const nextModels = {
		providers: {
			...models.providers,
			[snapshot.name]: {
				...(existing ?? { models: [] }),
				baseUrl: snapshot.baseUrl,
				api: snapshot.api,
				models: snapshot.models,
				...(snapshot.headers ? { headers: snapshot.headers } : {}),
				...(mergedCompat ? { compat: mergedCompat } : {}),
			},
		},
	};
	const nextAuth = { ...auth };
	if (snapshot.apiKey) {
		// 密钥内联写进 models.json，与 ModelsTab 编辑器口径一致（该编辑器只读/写 provider.apiKey）。
		nextModels.providers[snapshot.name] = {
			...nextModels.providers[snapshot.name],
			apiKey: snapshot.apiKey,
		};
	}
	return { models: nextModels, auth: nextAuth };
}
