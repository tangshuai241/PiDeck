import type { ShortcutId } from "../../../../shared/shortcuts";
import type { TranslationKey } from "../../i18n/rendererCopy.zh-CN";

/**
 * 流式响应指示器（RespondingIndicator）右侧轮播的功能提示清单。
 *
 * 存在的理由：PiDeck 有大量「没有可见入口、只能靠已经知道」的能力（命令面板、划选引用、
 * 排队/并行发送、右缘面板、会话导出…）。等待 AI 回复是用户注意力最集中、又无事可做的空档，
 * 状态条右侧是这段时间唯一闲置的位置——用它轮播提示，曝光成本最低。
 *
 * 收录规则（写入前逐条核实）：
 *  1. 只放**当前代码里确认存在**的入口——写错的提示比没有提示更糟（用户会去找一个不存在的按钮）；
 *  2. 一句话说得清，且短到不会被截断（指示器是单行 nowrap，长度契约见 tests/sessionFeatureTips.test.mjs）；
 *  3. 键位不写死：只填 shortcutId，实际键位由 RespondingTips 组件按生效绑定渲染。
 *
 * 本文件刻意保持为**纯数据模块**（无 React / 无别名 import），使 Node 测试可以直接加载它校验文案契约。
 */

export type SessionFeatureTip = {
	/** 文案 i18n key；zh-CN / en-US / zh-TW 三份词典都必须存在 */
	textKey: TranslationKey;
	/** 文案里的 {shortcut} 占位符取自该全局快捷键的生效键位（可选） */
	shortcutId?: ShortcutId;
};

export const SESSION_FEATURE_TIPS: readonly SessionFeatureTip[] = [
	// 输入区
	{ textKey: "agent.tips.commandPalette", shortcutId: "openCommandPalette" },
	{ textKey: "agent.tips.quickMessages", shortcutId: "openQuickMessages" },
	{ textKey: "agent.tips.composerTriggers" },
	{ textKey: "agent.tips.quoteSelection" },
	{ textKey: "agent.tips.sendOptions" },
	{ textKey: "agent.tips.pasteAttach" },
	{ textKey: "agent.tips.enhancePrompt" },
	{ textKey: "agent.tips.composerModes" },
	// 会话与消息
	{ textKey: "agent.tips.messageActions" },
	{ textKey: "agent.tips.multiSelect" },
	{ textKey: "agent.tips.sessionMenu" },
	{ textKey: "agent.tips.sessionSort" },
	{ textKey: "agent.tips.sessionManager" },
	// 项目列表
	{ textKey: "agent.tips.projectReorder" },
	{ textKey: "agent.tips.projectPin" },
	{ textKey: "agent.tips.importSessions" },
	// 面板与设置
	{ textKey: "agent.tips.workspaceRail" },
	{ textKey: "agent.tips.terminalDock" },
	{ textKey: "agent.tips.checkpoints" },
	{ textKey: "agent.tips.contextRing" },
	{ textKey: "agent.tips.usageStats" },
	{ textKey: "agent.tips.usageProbe" },
	{ textKey: "agent.tips.settingsExtras" },
];
