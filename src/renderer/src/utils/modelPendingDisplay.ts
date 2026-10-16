import { resolveModelDisplayName } from "../../../shared/modelDisplayName";

/**
 * 后端拒绝运行中模型切换时的 fallback 展示推导。
 *
 * 支持 live selection 的后端直接更新 runtime，不会设置 pending；只有 busy/error
 * 路径才会把选择保留到后续空闲时重试。
 */

export type ModelPendingRef = {
	provider: string;
	modelId: string;
	modelName?: string;
};

export type ModelPending = {
	from: ModelPendingRef;
	to: ModelPendingRef;
};

export function formatModelRef(ref: Pick<ModelPendingRef, "provider" | "modelId" | "modelName">): string {
	const name = ref.modelName || ref.modelId || "-";
	return ref.provider ? `${ref.provider}/${name}` : name;
}

export type ModelDisplayResult = {
	from?: ModelPendingRef;
	to?: ModelPendingRef;
	pending: boolean;
};

export function computeModelDisplay(current: ModelPendingRef | undefined, pending: ModelPending | undefined): ModelDisplayResult {
	if (pending) {
		return { from: pending.from, to: pending.to, pending: true };
	}
	return { from: current, pending: false };
}

export type ComposerLiveModelSource = {
	provider?: string;
	modelId?: string;
	modelName?: string;
};

/**
 * 底栏/选择器当前模型只读取 PiDeck 的选择偏好。
 *
 * 已有会话取 `SessionRecord.model`，尚未创建会话的引导页取 `fallback`。运行时状态
 * 仍用于流式、工具和统计，但绝不能参与名称或当前选择的决策；这样 Agent 启动前后
 * 都展示同一份本地名称快照。
 */
export function resolveComposerLiveModel(input: { record?: { provider?: string; modelId?: string; modelName?: string }; fallback?: ComposerLiveModelSource }): ModelPendingRef {
	const source = input.record?.provider && input.record.modelId ? input.record : input.fallback;
	return {
		provider: source?.provider ?? "",
		modelId: source?.modelId ?? "",
		modelName: resolveModelDisplayName(source?.modelName, source?.modelId ?? ""),
	};
}

/**
 * 引导页（无 record、未启动 Agent）的默认模型展示决策。
 *
 * 不变量：必须与主进程 `resolveLaunchDefaultOptions` 的来源次序一致
 * （点选 welcomeModel > 显式默认 > enabledModels > 上次使用），否则「底栏/选择器
 * 显示的默认」与「首次发送真实套用的默认」会分叉——用户表现为「页面切了但发送后
 * 变回去」。历史上展示层只建模了「显式默认」一级（defaultModelConfigured 为 true
 * 时直接屏蔽点选），而创建解析有四级来源，这就是「配了默认模型就切不动」的根因。
 *
 * 收拢为单一函数的原因：该规则曾在 ComposerPickerHost 与 ComposerComponents 各写
 * 一份（两份都带同一个闸门），任何一侧改动都容易漏改另一侧。
 *
 * 规则是「点选 > 默认」：点选是 welcomeModel，默认是 launchDefaults 的折叠结果
 * （显式默认 / 切换列表 / 上次使用）。
 */
export function resolveGuideDisplayModel(input: {
	/** 引导页点选（已经过 isWelcomeModelLost 校验，失效时为 undefined）。 */
	welcomeModel?: { provider: string; modelId: string; modelName?: string };
	/** 主进程解析出的预选默认（pi 的 launchDefaults 折叠结果 / DSH 的部署默认）。 */
	defaultModel?: ComposerLiveModelSource;
}): ComposerLiveModelSource | undefined {
	return input.welcomeModel ?? input.defaultModel;
}
