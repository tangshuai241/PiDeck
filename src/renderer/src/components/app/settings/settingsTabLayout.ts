import type { SettingsTabId } from "../../../atoms";
import type { TranslationKey } from "../../../i18n";

/** Stable tab identities are shared by navigation, deep links and the command palette. */
export type SettingsGroupId = "daily" | "workspace" | "ai" | "connections" | "maintenance";
export type SettingsTabLayoutEntry = { id: SettingsTabId; group: SettingsGroupId };

/** Persistent headings: groups never collapse and empty groups are omitted after filtering. */
export const SETTINGS_NAV_GROUPS: readonly { id: SettingsGroupId; labelKey: TranslationKey; tabs: readonly SettingsTabId[] }[] = [
	{ id: "daily", labelKey: "settings.groups.daily", tabs: ["common", "appearance", "shortcuts", "notification"] },
	{ id: "workspace", labelKey: "settings.groups.workspace", tabs: ["terminal", "git", "editors"] },
	{ id: "ai", labelKey: "settings.groups.ai", tabs: ["vision", "imagegen", "videogen", "cloudmemory"] },
	{ id: "connections", labelKey: "settings.groups.connections", tabs: ["proxy", "im", "hostplugins", "pet"] },
	{ id: "maintenance", labelKey: "settings.groups.maintenance", tabs: ["usage", "process", "storage", "backup", "dev"] },
];

export const SETTINGS_TAB_LAYOUT: readonly SettingsTabLayoutEntry[] = SETTINGS_NAV_GROUPS.flatMap((group) => group.tabs.map((id) => ({ id, group: group.id })));

/** 全部合法 tab id（顺序即展示顺序）：校验 localStorage 记忆值、防止旧版本残留值导致无高亮。 */
export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = SETTINGS_TAB_LAYOUT.map((entry) => entry.id);

/**
 * 各 tab 的标题 i18n key。
 *
 * 与 SETTINGS_TAB_LAYOUT 放在同一份文件是刻意的：命令面板（Ctrl+P 搜设置项）
 * 与设置页侧栏必须展示同一套标题，两处各维护一份字符串迟早漂移成
 * 「命令面板搜到的名字和侧栏对不上」。SettingsNavigation 只保留图标，
 * 标题一律从这里取。
 */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTabId, TranslationKey> = {
	common: "settings.tabs.common",
	shortcuts: "settings.tabs.shortcuts",
	appearance: "settings.tabs.appearance",
	terminal: "settings.tabs.terminal",
	proxy: "settings.tabs.proxy",

	editors: "settings.tabs.editors",
	git: "settings.tabs.git",
	dev: "settings.tabs.dev",
	im: "settings.tabs.im",
	pet: "settings.tabs.pet",
	notification: "settings.tabs.notification",
	storage: "settings.tabs.storage",
	backup: "settings.tabs.backup",
	usage: "settings.tabs.usage",
	process: "settings.tabs.process",
	vision: "settings.tabs.vision",
	imagegen: "settings.tabs.imagegen",
	videogen: "settings.tabs.videogen",
	cloudmemory: "settings.tabs.cloudmemory",

	hostplugins: "settings.tabs.hostplugins",
};

/**
 * 各 tab 的搜索别名（中英同义、用户常用俗称），供命令面板模糊匹配命中。
 * 例如用户搜「代理」要能出「代理」tab，搜 "mcp"/"模型" 要能出配置管理对应页。
 */
export const SETTINGS_TAB_KEYWORDS: Record<SettingsTabId, readonly string[]> = {
	common: ["常用", "基础", "通用", "general", "基本设置"],
	shortcuts: ["快捷键", "按键", "热键", "keybind", "hotkey", "shortcut"],
	appearance: ["外观", "主题", "深色", "浅色", "字体", "theme", "appearance", "dark"],
	terminal: ["终端", "配色", "字体", "光标", "terminal", "console", "font", "shell"],
	proxy: ["代理", "网络", "proxy", "http proxy", "网络代理"],

	editors: ["外部编辑器", "vscode", "编辑器", "editor", "ide"],
	git: ["git", "版本控制", "提交", "commit", "分支", "branch"],
	dev: ["开发者", "调试", "dev", "developer", "debug"],
	im: ["手机", "安卓", "远程", "配对", "Android", "remote", "companion", "飞书", "机器人", "im", "feishu", "lark", "消息"],
	pet: ["桌面宠物", "宠物", "pet", "桌宠"],
	notification: ["通知", "提醒", "消息提示", "notification", "toast"],
	storage: ["缓存", "日志", "存储", "清理", "cache", "log", "storage"],
	backup: ["备份", "恢复", "配置备份", "backup", "restore", "导入导出"],
	usage: ["用量", "统计", "token", "花费", "usage", "statistics"],
	process: ["进程", "监控", "内存", "process", "monitor"],
	vision: ["视觉", "图片识别", "视觉桥", "vision", "multimodal"],
	imagegen: ["生图", "画图", "图片生成", "imagegen", "image"],
	videogen: ["生视频", "视频生成", "videogen", "video"],
	cloudmemory: ["云端记忆", "记忆", "人格", "云端连接", "memory", "persona", "cloud"],

	hostplugins: ["插件", "宿主插件", "工作台插件", "plugin", "host plugin", "扩展安装", "pideck 插件"],
};
